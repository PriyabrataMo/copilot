"use client";
import React, { useEffect, useState, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatInput } from "./ChatInput";
import { MODELS, type ChatModelId, DEFAULT_MODEL } from "@/src/lib/models";

type Message = {
  messageId: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  status: "STREAMING" | "COMPLETE" | "INTERRUPTED" | "ERROR";
  parentId?: string | null;
  variantIndex?: number | null;
  model?: string | null;
  createdAt: string;
};

type Conversation = {
  id: string;
  conversationId: string;
  title: string | null;
  model: string | null;
};

// Represents a single user turn with all its versions and assistant responses
type ConversationTurn = {
  userVersions: Message[]; // All versions of the user message (edits)
  currentUserVersion: number; // Which user version is currently active
  assistantVariants: { [userMessageId: string]: Message[] }; // Assistant responses per user version
  currentAssistantVariant: { [userMessageId: string]: number }; // Current assistant variant per user version
};

export function BranchingChat({ 
  conversationId, 
  onTitleUpdate 
}: { 
  conversationId: string; 
  onTitleUpdate?: (title: string) => void; 
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [activeModel, setActiveModel] = useState<ChatModelId>(DEFAULT_MODEL);
  const [isStreaming, setIsStreaming] = useState(false);
  const [editingTurnIndex, setEditingTurnIndex] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");
  const lastAssistantIdRef = useRef<string | null>(null);
  const streamConnectionRef = useRef<{ stop: () => void } | null>(null);

  async function loadConversation() {
    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`);
      const data = await res.json();
      setConversation(data.conversation);
      setActiveModel((data.conversation?.model ?? DEFAULT_MODEL) as ChatModelId);
      
      // Organize messages into conversation turns
      const conversationTurns = organizeMessagesByTurns(data.messages);
      setTurns(conversationTurns);
    } catch (error) {
      console.error("Failed to load conversation:", error);
    }
  }

  function organizeMessagesByTurns(messages: Message[]): ConversationTurn[] {
    const turns: ConversationTurn[] = [];
    
    // Group messages by user turns (find root user messages first)
    const rootUserMessages = messages
      .filter(m => m.role === "USER" && !m.parentId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    for (const rootUser of rootUserMessages) {
      // Find all versions of this user message (including edits)
      const userVersions = findAllUserVersions(messages, rootUser.messageId);
      
      // Find assistant responses for each user version
      const assistantVariants: { [userMessageId: string]: Message[] } = {};
      const currentAssistantVariant: { [userMessageId: string]: number } = {};
      
      for (const userVersion of userVersions) {
        const assistants = messages
          .filter(m => m.role === "ASSISTANT" && m.parentId === userVersion.messageId)
          .sort((a, b) => (a.variantIndex || 0) - (b.variantIndex || 0));
        
        assistantVariants[userVersion.messageId] = assistants;
        currentAssistantVariant[userVersion.messageId] = 0;
      }

      turns.push({
        userVersions,
        currentUserVersion: userVersions.length - 1, // Default to latest version
        assistantVariants,
        currentAssistantVariant,
      });
    }

    return turns;
  }

  function findAllUserVersions(messages: Message[], rootMessageId: string): Message[] {
    const versions: Message[] = [];
    const visited = new Set<string>();
    
    function collectVersions(messageId: string) {
      if (visited.has(messageId)) return;
      visited.add(messageId);
      
      const message = messages.find(m => m.messageId === messageId);
      if (message && message.role === "USER") {
        versions.push(message);
        
        // Find any messages that have this message as parent (edited versions)
        const children = messages.filter(m => m.role === "USER" && m.parentId === messageId);
        for (const child of children) {
          collectVersions(child.messageId);
        }
      }
    }
    
    collectVersions(rootMessageId);
    return versions.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  useEffect(() => {
    loadConversation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  function connectSSE(body: {
    conversationId: string;
    userMessage: string;
    model: string;
    parentUserMessageId?: string;
    userMessageParentId?: string;
    variantIndex?: number;
    isRegeneration?: boolean;
    isEditedPrompt?: boolean;
  }) {
    const controller = new AbortController();
    
    async function run() {
      try {
        setIsStreaming(true);
        const res = await fetch("/api/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        
        const reader = res.body!.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const lines = raw.split("\n");
            const eventLine = lines.find((l) => l.startsWith("event: "));
            const dataLine = lines.find((l) => l.startsWith("data: "));
            const event = eventLine ? eventLine.slice(7) : "message";
            const data = dataLine ? JSON.parse(dataLine.slice(6)) : {};
            onEvent(event, data, body);
          }
        }
      } catch (error) {
        console.error("Stream error:", error);
        setIsStreaming(false);
      }
    }

    function onEvent(event: string, data: Record<string, unknown>, requestBody: typeof body) {
      if (event === "start") {
        lastAssistantIdRef.current = data.messageId as string;
        
        // Reload conversation to get updated structure including the new streaming message
        setTimeout(() => loadConversation(), 100);
        
      } else if (event === "token") {
        setTurns(prev => prev.map(turn => {
          const newAssistantVariants = { ...turn.assistantVariants };
          
          Object.keys(newAssistantVariants).forEach(userMessageId => {
            newAssistantVariants[userMessageId] = newAssistantVariants[userMessageId].map(msg =>
              msg.messageId === lastAssistantIdRef.current 
                ? { ...msg, content: msg.content + (data.delta as string ?? "") }
                : msg
            );
          });
          
          return { ...turn, assistantVariants: newAssistantVariants };
        }));
        
      } else if (event === "end") {
        setTurns(prev => prev.map(turn => {
          const newAssistantVariants = { ...turn.assistantVariants };
          
          Object.keys(newAssistantVariants).forEach(userMessageId => {
            newAssistantVariants[userMessageId] = newAssistantVariants[userMessageId].map(msg =>
              msg.messageId === lastAssistantIdRef.current 
                ? { ...msg, status: data.status === "complete" ? "COMPLETE" : "INTERRUPTED" }
                : msg
            );
          });
          
          return { ...turn, assistantVariants: newAssistantVariants };
        }));
        setIsStreaming(false);
        
      } else if (event === "title") {
        const newTitle = data.title as string;
        if (onTitleUpdate) {
          onTitleUpdate(newTitle);
        }
        setConversation(prev => prev ? { ...prev, title: newTitle } : null);
        
      } else if (event === "error") {
        console.error("Stream error:", data);
        setIsStreaming(false);
      }
    }

    run();
    return { stop: () => controller.abort() };
  }

  async function handleSendMessage(content: string) {
    if (!content.trim()) return;

    const body = {
      conversationId,
      userMessage: content,
      model: activeModel,
    };

    const conn = connectSSE(body);
    streamConnectionRef.current = conn;
  }

  async function handleEditUserMessage(turnIndex: number, newContent: string) {
    const turn = turns[turnIndex];
    if (!turn) return;

    const currentUserMessage = turn.userVersions[turn.currentUserVersion];
    
    const body = {
      conversationId,
      userMessage: newContent,
      model: activeModel,
      userMessageParentId: currentUserMessage.messageId,
      isEditedPrompt: true,
    };

    setEditingTurnIndex(null);
    const conn = connectSSE(body);
    streamConnectionRef.current = conn;
    
    // Reload after a short delay to see the new structure
    setTimeout(() => loadConversation(), 500);
  }

  async function handleRegenerateAssistant(turnIndex: number) {
    const turn = turns[turnIndex];
    if (!turn) return;

    const currentUserMessage = turn.userVersions[turn.currentUserVersion];
    const currentVariants = turn.assistantVariants[currentUserMessage.messageId] || [];
    
    const body = {
      conversationId,
      userMessage: currentUserMessage.content,
      model: activeModel,
      parentUserMessageId: currentUserMessage.messageId,
      variantIndex: currentVariants.length,
      isRegeneration: true,
    };

    const conn = connectSSE(body);
    streamConnectionRef.current = conn;
  }

  async function handleStop() {
    try {
      await fetch("/api/stop", { 
        method: "POST", 
        headers: { "Content-Type": "application/json" }, 
        body: JSON.stringify({ conversationId }) 
      });
      if (streamConnectionRef.current) {
        streamConnectionRef.current.stop();
      }
    } catch (error) {
      console.error("Failed to stop stream:", error);
    }
  }

  function navigateUserVersion(turnIndex: number, direction: "prev" | "next") {
    setTurns(prev => prev.map((turn, idx) => {
      if (idx !== turnIndex) return turn;
      
      const newIndex = direction === "prev" 
        ? Math.max(0, turn.currentUserVersion - 1)
        : Math.min(turn.userVersions.length - 1, turn.currentUserVersion + 1);
      
      return { ...turn, currentUserVersion: newIndex };
    }));
  }

  function navigateAssistantVariant(turnIndex: number, userMessageId: string, direction: "prev" | "next") {
    setTurns(prev => prev.map((turn, idx) => {
      if (idx !== turnIndex) return turn;
      
      const variants = turn.assistantVariants[userMessageId] || [];
      const currentIndex = turn.currentAssistantVariant[userMessageId] || 0;
      const newIndex = direction === "prev" 
        ? Math.max(0, currentIndex - 1)
        : Math.min(variants.length - 1, currentIndex + 1);
      
      return {
        ...turn,
        currentAssistantVariant: {
          ...turn.currentAssistantVariant,
          [userMessageId]: newIndex
        }
      };
    }));
  }

  async function handleModelChange(model: ChatModelId) {
    setActiveModel(model);
    if (conversation?.conversationId) {
      await fetch(`/api/conversations/${conversation.conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
    }
  }

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="border-b p-3 flex items-center gap-3 bg-white">
        <select
          className="border rounded px-3 py-1 text-sm"
          value={activeModel}
          onChange={(e) => handleModelChange(e.target.value as ChatModelId)}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <div className="ml-auto flex gap-2">
          <button 
            className="px-3 py-1 border rounded text-sm hover:bg-gray-50" 
            onClick={handleStop} 
            disabled={!isStreaming}
          >
            {isStreaming ? "Stop" : "Stopped"}
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {turns.map((turn, turnIndex) => {
          const currentUserMessage = turn.userVersions[turn.currentUserVersion];
          const assistantVariants = turn.assistantVariants[currentUserMessage.messageId] || [];
          const currentAssistantIndex = turn.currentAssistantVariant[currentUserMessage.messageId] || 0;
          const currentAssistant = assistantVariants[currentAssistantIndex];

          return (
            <div key={`turn-${turnIndex}`} className="space-y-4">
              {/* User Message */}
              <div className="flex justify-end">
                <div className="max-w-[70%] bg-blue-500 text-white rounded-lg p-4">
                  <div className="text-xs opacity-70 mb-2 flex justify-between items-center">
                    <span>USER</span>
                    {turn.userVersions.length > 1 && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => navigateUserVersion(turnIndex, "prev")}
                          disabled={turn.currentUserVersion === 0}
                          className="p-1 rounded hover:bg-blue-400 disabled:opacity-50"
                        >
                          ←
                        </button>
                        <span className="text-xs">
                          {turn.currentUserVersion + 1}/{turn.userVersions.length}
                        </span>
                        <button
                          onClick={() => navigateUserVersion(turnIndex, "next")}
                          disabled={turn.currentUserVersion === turn.userVersions.length - 1}
                          className="p-1 rounded hover:bg-blue-400 disabled:opacity-50"
                        >
                          →
                        </button>
                      </div>
                    )}
                  </div>
                  
                  {editingTurnIndex === turnIndex ? (
                    <div className="space-y-3">
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        className="w-full p-2 border rounded text-gray-800 min-h-[100px] resize-none"
                        placeholder="Edit your message..."
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleEditUserMessage(turnIndex, editContent)}
                          className="px-3 py-1 bg-green-500 text-white rounded text-sm hover:bg-green-600"
                        >
                          Save & Submit
                        </button>
                        <button
                          onClick={() => setEditingTurnIndex(null)}
                          className="px-3 py-1 bg-gray-500 text-white rounded text-sm hover:bg-gray-600"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="whitespace-pre-wrap">{currentUserMessage.content}</div>
                      <div className="opacity-0 group-hover:opacity-100 transition-opacity mt-3">
                        <button
                          onClick={() => {
                            setEditingTurnIndex(turnIndex);
                            setEditContent(currentUserMessage.content);
                          }}
                          className="text-xs px-2 py-1 bg-blue-400 text-white rounded hover:bg-blue-300"
                        >
                          Edit
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Assistant Message */}
              {currentAssistant && (
                <div className="flex justify-start">
                  <div className="max-w-[70%] bg-gray-100 text-gray-800 rounded-lg p-4">
                    <div className="text-xs text-gray-600 mb-2 flex justify-between items-center">
                      <span>ASSISTANT</span>
                      {assistantVariants.length > 1 && (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => navigateAssistantVariant(turnIndex, currentUserMessage.messageId, "prev")}
                            disabled={currentAssistantIndex === 0}
                            className="p-1 rounded hover:bg-gray-200 disabled:opacity-50"
                          >
                            ←
                          </button>
                          <span className="text-xs">
                            {currentAssistantIndex + 1}/{assistantVariants.length}
                          </span>
                          <button
                            onClick={() => navigateAssistantVariant(turnIndex, currentUserMessage.messageId, "next")}
                            disabled={currentAssistantIndex === assistantVariants.length - 1}
                            className="p-1 rounded hover:bg-gray-200 disabled:opacity-50"
                          >
                            →
                          </button>
                        </div>
                      )}
                    </div>
                    
                    <div className="prose prose-sm max-w-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {currentAssistant.content}
                      </ReactMarkdown>
                    </div>

                    {currentAssistant.status === "STREAMING" && (
                      <div className="mt-2 text-xs text-gray-500">
                        <span className="inline-block w-2 h-2 bg-current rounded-full animate-pulse mr-1"></span>
                        Thinking...
                      </div>
                    )}

                    <div className="opacity-0 group-hover:opacity-100 transition-opacity mt-3 flex gap-2">
                      <button
                        onClick={() => handleRegenerateAssistant(turnIndex)}
                        className="text-xs px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                      >
                        Regenerate
                      </button>
                      <button
                        onClick={() => navigator.clipboard.writeText(currentAssistant.content)}
                        className="text-xs px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Input */}
      <ChatInput
        onSend={handleSendMessage}
        disabled={isStreaming}
        placeholder="Type your message... (Shift+Enter for new line)"
      />
    </div>
  );
}
