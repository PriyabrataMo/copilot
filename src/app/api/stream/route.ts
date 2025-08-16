import { NextRequest } from "next/server";
import OpenAI from "openai";
import { prisma } from "@/src/lib/prisma";
import { v4 as uuidv4 } from "uuid";
import { DEFAULT_MODEL, getModelInfo, type ChatModelId } from "@/src/lib/models";
import { buildPrompt, type ChatMessage } from "@/src/lib/tokens";
import { streamRegistry } from "@/src/lib/stream-registry";

export const runtime = "nodejs";

type Body = {
  conversationId: string; // UUID
  userMessage: string;
  model?: ChatModelId;
  systemPrompt?: string;
  parentUserMessageId?: string | null; // parent user message id (for assistant responses)
  userMessageParentId?: string | null; // parent id for user message versioning (edits)
  variantIndex?: number; // which variant this is (0, 1, 2...)
  isRegeneration?: boolean;
  isEditedPrompt?: boolean; // true when editing a user message
};

function sseChunk(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  try {
    const { 
      conversationId, 
      userMessage, 
      model, 
      systemPrompt, 
      parentUserMessageId, 
      userMessageParentId,
      variantIndex = 0, 
      isRegeneration = false,
      isEditedPrompt = false
    }: Body = await req.json();
    
    if (!process.env.OPENAI_API_KEY) {
      return new Response(sseChunk("error", { message: "OpenAI API key not configured" }), {
        status: 500,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Resolve conversation by UUID
  const conv = await prisma.conversation.findUnique({ where: { conversationId } });
  if (!conv) {
    return new Response(sseChunk("error", { message: "Conversation not found" }), {
      status: 404,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  // Handle user message creation/versioning
  let userMessageId = parentUserMessageId;
  
  if (!isRegeneration) {
    // Create new user message (either fresh or edited version)
    userMessageId = uuidv4();
    
    // If editing an existing prompt, cancel any active streams for the old version
    if (isEditedPrompt && userMessageParentId) {
      streamRegistry.stop(conversationId);
      
      // Mark any streaming assistant messages as interrupted
      await prisma.message.updateMany({
        where: {
          conversationId: conv.id,
          parentId: userMessageParentId,
          status: "STREAMING"
        },
        data: {
          status: "INTERRUPTED",
          finishReason: "user_edited_prompt"
        }
      });
    }
    
    await prisma.message.create({
      data: {
        messageId: userMessageId,
        conversationId: conv.id,
        role: "USER",
        content: userMessage,
        status: "COMPLETE",
        parentId: userMessageParentId, // Link to previous version if editing
      },
    });
  }

  // Update title if missing (only for new messages, not regeneration)
  if (!isRegeneration && (!conv.title || conv.title === "New Chat") && userMessage.trim()) {
    await prisma.conversation.update({ where: { id: conv.id }, data: { title: userMessage.trim().slice(0, 80) } });
  }

  const chosenModel = (model ?? conv.model ?? DEFAULT_MODEL) as ChatModelId;
  const info = getModelInfo(chosenModel);

  // Compose context - get all messages up to this point
  const prior = await prisma.message.findMany({ 
    where: { conversationId: conv.id }, 
    orderBy: { createdAt: "asc" } 
  });
      const history: ChatMessage[] = prior.map((m: { role: string; content: string; }) => ({
    role: m.role.toLowerCase() as "user" | "assistant" | "system",
    content: m.content,
  }));
  const sys = systemPrompt ?? "You are a helpful assistant.";
  const { messages, promptTokens, maxCompletionTokens } = buildPrompt(
    chosenModel,
    sys,
    history,
    info.maxContextTokens,
    info.outputHeadroomRatio
  );
  
  // Cap completion tokens to model limit
  const actualMaxTokens = Math.min(maxCompletionTokens, info.maxCompletionTokens);

  // Create assistant message placeholder
  const assistantMessageId = uuidv4();
  await prisma.message.create({
    data: {
      messageId: assistantMessageId,
      conversationId: conv.id,
      role: "ASSISTANT",
      content: "",
      status: "STREAMING",
      parentId: userMessageId,
      variantIndex,
      model: chosenModel,
      promptTokens,
    },
  });

  const controller = new AbortController();
  streamRegistry.set(conversationId, controller);

  const stream = new ReadableStream({
    start: async (controllerStream) => {
      controllerStream.enqueue(new TextEncoder().encode(sseChunk("start", {
        conversationId,
        messageId: assistantMessageId,
        model: chosenModel,
      })));

      try {
        const chatStream = await openai.chat.completions.create({
          model: chosenModel,
          messages: messages,
          stream: true,
          max_tokens: Math.max(64, actualMaxTokens),
        }, { signal: controller.signal });

        let accumulated = "";
        let completionTokens = 0;
        for await (const chunk of chatStream) {
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            accumulated += delta;
            completionTokens += 1;
            controllerStream.enqueue(new TextEncoder().encode(sseChunk("token", { delta })));
          }
          const finishReason = chunk.choices?.[0]?.finish_reason;
          if (finishReason) {
            controllerStream.enqueue(new TextEncoder().encode(sseChunk("finish", { finishReason })));
          }
        }

        await prisma.message.update({
          where: { messageId: assistantMessageId },
          data: { content: accumulated, status: "COMPLETE", completionTokens },
        });

        // Generate title if this is the first assistant message and no custom title exists
        if ((!conv.title || conv.title === "New Chat") && !isRegeneration && userMessage.trim()) {
          try {
            const titleResponse = await openai.chat.completions.create({
              model: "gpt-3.5-turbo",
              messages: [
                {
                  role: "system",
                  content: "Generate a concise, descriptive title (3-6 words) for this conversation based on the user message and assistant response. Return only the title, no quotes or extra text."
                },
                {
                  role: "user", 
                  content: `User: ${userMessage}\n\nAssistant: ${accumulated}\n\nGenerate a title:`
                }
              ],
              max_tokens: 20,
              temperature: 0.7,
            });
            
            const generatedTitle = titleResponse.choices[0]?.message?.content?.trim() || "Untitled Chat";
            
            // Update the conversation title in database
            await prisma.conversation.update({
              where: { id: conv.id },
              data: { title: generatedTitle },
            });
            
            // Send title update via SSE
            controllerStream.enqueue(new TextEncoder().encode(sseChunk("title", { title: generatedTitle })));
          } catch (err) {
            console.error("Title generation failed:", err);
          }
        }

        streamRegistry.clear(conversationId);
        controllerStream.enqueue(new TextEncoder().encode(sseChunk("end", { status: "complete" })));
        controllerStream.close();
      } catch (err: unknown) {
        const e = err as { name?: string; message?: string } | undefined;
        console.error("Stream error:", err);
        
        if (e?.name === "AbortError") {
          await prisma.message.update({ where: { messageId: assistantMessageId }, data: { status: "INTERRUPTED", finishReason: "user_cancelled" } });
          controllerStream.enqueue(new TextEncoder().encode(sseChunk("end", { status: "interrupted" })));
          controllerStream.close();
          return;
        }
        
        const errorMessage = e?.message || "Unknown error occurred";
        await prisma.message.update({ where: { messageId: assistantMessageId }, data: { status: "ERROR", finishReason: "error" } });
        controllerStream.enqueue(new TextEncoder().encode(sseChunk("error", { message: errorMessage })));
        controllerStream.close();
      }
    },
    cancel: () => {
      streamRegistry.clear(conversationId);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
  } catch (err: unknown) {
    console.error("Route error:", err);
    const e = err as { message?: string } | undefined;
    const errorMessage = e?.message || "Server error";
    return new Response(sseChunk("error", { message: errorMessage }), {
      status: 500,
      headers: { "Content-Type": "text/event-stream" },
    });
  }
}


