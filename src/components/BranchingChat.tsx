"use client";
import React, { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatInput } from "./ChatInput";
import { MODELS, type ChatModelId, DEFAULT_MODEL } from "@/src/lib/models";
import { useChatStore } from "@/src/lib/chat-store";

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
  onTitleUpdate,
}: {
  conversationId: string;
  onTitleUpdate?: (title: string) => void;
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [activeModel, setActiveModel] = useState<ChatModelId>(DEFAULT_MODEL);
  const [editingTurnIndex, setEditingTurnIndex] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");
  const store = useChatStore();
  const isStreaming = !!store.isStreaming[conversationId];

  async function loadConversation() {
    try {
      await store.loadConversation(conversationId);
      const conv = store.conversations[conversationId] ?? null;
      setConversation(conv ?? null);
      setActiveModel((conv?.model ?? DEFAULT_MODEL) as ChatModelId);
    } catch (error) {
      console.error("Failed to load conversation:", error);
    }
  }

  function organizeMessagesByTurns(messages: Message[]): ConversationTurn[] {
    const turns: ConversationTurn[] = [];
    const byId = new Map(messages.map((m) => [m.messageId, m] as const));
    // Root user messages are user messages whose parent is not a user (system or assistant)
    const rootUserMessages = messages
      .filter((m) => m.role === "USER")
      .filter((m) => {
        if (!m.parentId) return true;
        const parent = byId.get(m.parentId);
        return !parent || parent.role !== "USER";
      })
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );

    for (const rootUser of rootUserMessages) {
      // Find all versions of this user message (including edits)
      const userVersions = findAllUserVersions(messages, rootUser.messageId);

      // Find assistant responses for each user version
      const assistantVariants: { [userMessageId: string]: Message[] } = {};
      const currentAssistantVariant: { [userMessageId: string]: number } = {};

      for (const userVersion of userVersions) {
        const assistants = messages
          .filter(
            (m) =>
              m.role === "ASSISTANT" && m.parentId === userVersion.messageId
          )
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

  function findAllUserVersions(
    messages: Message[],
    rootMessageId: string
  ): Message[] {
    const versions: Message[] = [];
    const visited = new Set<string>();

    function collectVersions(messageId: string) {
      if (visited.has(messageId)) return;
      visited.add(messageId);

      const message = messages.find((m) => m.messageId === messageId);
      if (message && message.role === "USER") {
        versions.push(message);

        // Find any messages that have this message as parent (edited versions)
        const children = messages.filter(
          (m) => m.role === "USER" && m.parentId === messageId
        );
        for (const child of children) {
          collectVersions(child.messageId);
        }
      }
    }

    collectVersions(rootMessageId);
    return versions.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }

  useEffect(() => {
    loadConversation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const storeMessages = useMemo(
    () => store.messages[conversationId] ?? [],
    [store.messages, conversationId]
  );
  useEffect(() => {
    // Organize messages into conversation turns when store updates
    // Always render full content from store (accumulated tokens)
    const conversationTurns = organizeMessagesByTurns(
      storeMessages as unknown as Message[]
    );
    setTurns(conversationTurns);
    const conv = store.conversations[conversationId] ?? null;
    if (conv) {
      setConversation(conv);
      setActiveModel((conv.model ?? DEFAULT_MODEL) as ChatModelId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeMessages]);

  // Streaming handled by global store

  async function handleSendMessage(content: string) {
    if (!content.trim()) return;
    store.openStream({
      conversationId,
      userMessage: content,
      model: activeModel,
    });
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
    store.openStream(body);
  }

  async function handleRegenerateAssistant(turnIndex: number) {
    const turn = turns[turnIndex];
    if (!turn) return;

    const currentUserMessage = turn.userVersions[turn.currentUserVersion];
    const currentVariants =
      turn.assistantVariants[currentUserMessage.messageId] || [];

    const body = {
      conversationId,
      userMessage: currentUserMessage.content,
      model: activeModel,
      parentUserMessageId: currentUserMessage.messageId,
      variantIndex: currentVariants.length,
      isRegeneration: true,
    };
    store.openStream(body);
  }

  async function handleStop() {
    try {
      await store.stopStream(conversationId);
    } catch (error) {
      console.error("Failed to stop stream:", error);
    }
  }

  function navigateUserVersion(turnIndex: number, direction: "prev" | "next") {
    setTurns((prev) =>
      prev.map((turn, idx) => {
        if (idx !== turnIndex) return turn;

        const newIndex =
          direction === "prev"
            ? Math.max(0, turn.currentUserVersion - 1)
            : Math.min(
                turn.userVersions.length - 1,
                turn.currentUserVersion + 1
              );

        return { ...turn, currentUserVersion: newIndex };
      })
    );
  }

  function navigateAssistantVariant(
    turnIndex: number,
    userMessageId: string,
    direction: "prev" | "next"
  ) {
    setTurns((prev) =>
      prev.map((turn, idx) => {
        if (idx !== turnIndex) return turn;

        const variants = turn.assistantVariants[userMessageId] || [];
        const currentIndex = turn.currentAssistantVariant[userMessageId] || 0;
        const newIndex =
          direction === "prev"
            ? Math.max(0, currentIndex - 1)
            : Math.min(variants.length - 1, currentIndex + 1);

        return {
          ...turn,
          currentAssistantVariant: {
            ...turn.currentAssistantVariant,
            [userMessageId]: newIndex,
          },
        };
      })
    );
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
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
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
          const assistantVariants =
            turn.assistantVariants[currentUserMessage.messageId] || [];
          const currentAssistantIndex =
            turn.currentAssistantVariant[currentUserMessage.messageId] || 0;
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
                          {turn.currentUserVersion + 1}/
                          {turn.userVersions.length}
                        </span>
                        <button
                          onClick={() => navigateUserVersion(turnIndex, "next")}
                          disabled={
                            turn.currentUserVersion ===
                            turn.userVersions.length - 1
                          }
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
                          onClick={() =>
                            handleEditUserMessage(turnIndex, editContent)
                          }
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
                      <div className="whitespace-pre-wrap">
                        {currentUserMessage.content}
                      </div>
                      <div className=" transition-opacity mt-3 flex gap-2">
                        <button
                          onClick={() => {
                            setEditingTurnIndex(turnIndex);
                            setEditContent(currentUserMessage.content);
                          }}
                          className="text-xs px-2 py-1 bg-blue-400 text-white rounded hover:bg-blue-300"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleRegenerateAssistant(turnIndex)}
                          className="text-xs px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                        >
                          Regenerate
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
                            onClick={() =>
                              navigateAssistantVariant(
                                turnIndex,
                                currentUserMessage.messageId,
                                "prev"
                              )
                            }
                            disabled={currentAssistantIndex === 0}
                            className="p-1 rounded hover:bg-gray-200 disabled:opacity-50"
                          >
                            ←
                          </button>
                          <span className="text-xs">
                            {currentAssistantIndex + 1}/
                            {assistantVariants.length}
                          </span>
                          <button
                            onClick={() =>
                              navigateAssistantVariant(
                                turnIndex,
                                currentUserMessage.messageId,
                                "next"
                              )
                            }
                            disabled={
                              currentAssistantIndex ===
                              assistantVariants.length - 1
                            }
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

                    <div className=" transition-opacity mt-3 flex gap-2">
                      <button
                        onClick={() => handleRegenerateAssistant(turnIndex)}
                        className="text-xs px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                      >
                        Regenerate
                      </button>
                      <button
                        onClick={() =>
                          navigator.clipboard.writeText(
                            currentAssistant.content
                          )
                        }
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
