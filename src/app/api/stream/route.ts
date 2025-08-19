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
  parentId?: string | null; // parent id for user message versioning (edits)
};

function sseChunk(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  try {
    const raw : Body = await req.json();
    const conversationId: string = raw.conversationId;
    const userMessage: string = raw.userMessage;
    const model: ChatModelId | undefined = raw.model;
    const systemPrompt: string | undefined = raw.systemPrompt;
    let parentUserMessageId: string | null | undefined = raw.parentUserMessageId;
    let userMessageParentId: string | null | undefined = raw.userMessageParentId;
    const variantIndex: number = raw.variantIndex ?? 0;
    const isRegeneration: boolean = !!raw.isRegeneration;
    const isEditedPrompt: boolean = !!raw.isEditedPrompt;

    // Backward-compat: support `parentId` param from older clients
    if (!parentUserMessageId && raw.parentId && isRegeneration) {
      parentUserMessageId = raw.parentId as string;
    }
    if (!userMessageParentId && raw.parentId && !isRegeneration) {
      userMessageParentId = raw.parentId as string;
    }
    
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

  // Handle user message creation/versioning and parent linkage
  let userMessageId = parentUserMessageId;
  if (!isRegeneration) {
    userMessageId = uuidv4();

    // Determine the parent for this user message:
    // - If editing, parent is the previous user message (userMessageParentId)
    // - Else, parent is the last assistant or system message in the conversation (to build a chain)
    let parentIdForUser: string | null | undefined = userMessageParentId;
    if (!parentIdForUser) {
      const lastNonUser = await prisma.message.findFirst({
        where: { conversationId: conv.id, OR: [{ role: "ASSISTANT" }, { role: "SYSTEM" }] },
        orderBy: { createdAt: "desc" },
      });
      parentIdForUser = lastNonUser?.messageId ?? null;
    }

    // If editing an existing prompt, cancel any active streams for the old version
    if (isEditedPrompt && userMessageParentId) {
      streamRegistry.stop(conversationId);
      await prisma.message.updateMany({
        where: { conversationId: conv.id, parentId: userMessageParentId, status: "STREAMING" },
        data: { status: "INTERRUPTED", finishReason: "user_edited_prompt" },
      });
    }

    await prisma.message.create({
      data: {
        messageId: userMessageId,
        conversationId: conv.id,
        role: "USER",
        content: userMessage,
        status: "COMPLETE",
        parentId: parentIdForUser ?? null,
      },
    });
  }

  // Update title if missing (only for new messages, not regeneration)
  if (!isRegeneration && (!conv.title || conv.title === "New Chat") && userMessage.trim()) {
    await prisma.conversation.update({ where: { id: conv.id }, data: { title: userMessage.trim().slice(0, 80) } });
  }

  const chosenModel = (model ?? (conv.model as ChatModelId) ?? DEFAULT_MODEL) as ChatModelId;
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
  // Use first system message if exists, otherwise fallback
  const firstSystem = prior.find((m) => m.role === "SYSTEM");
  const sys = systemPrompt ?? firstSystem?.content ?? "You are a helpful assistant.";
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
        parentId: userMessageId,
        role: "assistant",
        model: chosenModel,
      })));

      // Hoist accumulated buffers so they are available in all branches
      let accumulated = "";
      let completionTokens = 0;
      try {
        const chatStream = await openai.chat.completions.create({
          model: chosenModel,
          messages: messages,
          stream: true,
          max_tokens: Math.max(64, actualMaxTokens),
        }, { signal: controller.signal });
        
        // Persist partial content to DB periodically to support resume-on-reconnect UX
        const SAVE_EVERY_N_TOKENS = 5;
        for await (const chunk of chatStream) {
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            accumulated += delta;
            completionTokens += 1;
            // messageId and parentId are not required for the client on token events
            controllerStream.enqueue(new TextEncoder().encode(sseChunk("token", { token: delta })));
            // Throttled save of partial content so reconnecting clients see progress
            if (completionTokens % SAVE_EVERY_N_TOKENS === 0) {
              try {
                await prisma.message.update({
                  where: { messageId: assistantMessageId },
                  data: { content: accumulated, completionTokens },
                });
              } catch (e) {
                // Non-fatal; continue streaming
                console.error("Partial save failed:", e);
              }
            }
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
          // Save whatever we have accumulated so far before marking interrupted
          try {
            await prisma.message.update({
              where: { messageId: assistantMessageId },
              data: { content: accumulated, status: "INTERRUPTED", completionTokens, finishReason: "user_cancelled" },
            });
          } catch {}
          controllerStream.enqueue(new TextEncoder().encode(sseChunk("end", { status: "interrupted" })));
          controllerStream.close();
          return;
        }
        
        const errorMessage = e?.message || "Unknown error occurred";
        try {
          await prisma.message.update({ where: { messageId: assistantMessageId }, data: { content: accumulated, status: "ERROR", completionTokens, finishReason: "error" } });
        } catch {}
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


