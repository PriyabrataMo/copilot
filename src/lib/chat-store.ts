"use client";
import { create } from "zustand";

export type ChatRole = "USER" | "ASSISTANT" | "SYSTEM";

export type ChatMessage = {
  messageId: string;
  role: ChatRole;
  content: string;
  status: "STREAMING" | "COMPLETE" | "INTERRUPTED" | "ERROR";
  parentId?: string | null;
  variantIndex?: number | null;
  model?: string | null;
  createdAt: string;
  structuredData?: unknown;
  visualizationConfig?: unknown;
  pipelineStatus?: string;
};

export type Conversation = {
  id: string;
  conversationId: string;
  title: string | null;
  model: string | null;
};

type StreamBody = {
  conversationId: string;
  userMessage: string;
  model: string;
  parentUserMessageId?: string;
  userMessageParentId?: string;
  variantIndex?: number;
  isRegeneration?: boolean;
  isEditedPrompt?: boolean;
};

type ChatState = {
  conversations: Record<string, Conversation | undefined>;
  messages: Record<string, ChatMessage[]>; // keyed by conversationId
  messagesById: Record<string, Record<string, ChatMessage>>; // conversationId -> messageId -> message
  messageIndex: Record<string, Record<string, number>>; // conversationId -> messageId -> index in messages array
  isStreaming: Record<string, boolean | undefined>;
  currentAssistantId: Record<string, string | undefined>; // per conversation
  controllers: Record<string, AbortController | undefined>;

  // Actions
  loadConversation: (conversationId: string) => Promise<void>;
  openStream: (body: StreamBody) => void;
  stopStream: (conversationId: string) => Promise<void>;
  clearStream: (conversationId: string) => void;
};

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: {},
  messages: {},
  messagesById: {},
  messageIndex: {},
  isStreaming: {},
  currentAssistantId: {},
  controllers: {},

  async loadConversation(conversationId) {
    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`);
      const data = await res.json();
      const msgs = (data.messages ?? []) as ChatMessage[];
      // If there is an ongoing in-memory streaming assistant message, merge it so partial content doesn't disappear
      const currentAssistantId = get().currentAssistantId[conversationId];
      if (currentAssistantId) {
        const localById = get().messagesById[conversationId] ?? {};
        const localAssistant = localById[currentAssistantId];
        if (localAssistant) {
          const serverIndex = msgs.findIndex((m) => m.messageId === currentAssistantId);
          if (serverIndex >= 0) {
            const serverMsg = msgs[serverIndex];
            // Prefer the longer content and preserve STREAMING status from local copy
            const merged: ChatMessage = {
              ...serverMsg,
              content:
                (localAssistant.content?.length || 0) > (serverMsg.content?.length || 0)
                  ? localAssistant.content
                  : serverMsg.content,
              status: localAssistant.status ?? serverMsg.status,
            };
            msgs[serverIndex] = merged;
          } else {
            // Server might not have flushed the placeholder yet; append local streaming message
            msgs.push(localAssistant);
          }
        }
      }
      const byId: Record<string, ChatMessage> = {};
      const idx: Record<string, number> = {};
      msgs.forEach((m, i) => {
        byId[m.messageId] = m;
        idx[m.messageId] = i;
      });
      set((s) => ({
        conversations: {
          ...s.conversations,
          [conversationId]: data.conversation,
        },
        messages: { ...s.messages, [conversationId]: msgs },
        messagesById: { ...s.messagesById, [conversationId]: byId },
        messageIndex: { ...s.messageIndex, [conversationId]: idx },
      }));
    } catch (e) {
      console.error("Failed to load conversation", e);
    }
  },

  openStream(body) {
    const prevController = get().controllers[body.conversationId];
    if (prevController) {
      // Ensure only one stream per chat
      prevController.abort();
    }
    const controller = new AbortController();
    set((s) => ({
      controllers: { ...s.controllers, [body.conversationId]: controller },
      isStreaming: { ...s.isStreaming, [body.conversationId]: true },
    }));

    const run = async () => {
      try {
        const res = await fetch("/api/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const lines = raw.split("\n");
            const eventLine = lines.find((l) => l.startsWith("event: "));
            const dataLine = lines.find((l) => l.startsWith("data: "));
            const event = eventLine ? eventLine.slice(7) : "message";
            const data = dataLine ? JSON.parse(dataLine.slice(6)) : {};

            // Route events
            if (event === "start") {
              const assistantId = data.messageId as string;
              const parentUserMsgId = data.parentId as string | undefined;
              set((s) => ({
                currentAssistantId: {
                  ...s.currentAssistantId,
                  [body.conversationId]: assistantId,
                },
              }));

              // For non-regenerations, create the user message placeholder first (using server-provided parentId)
              if (!body.isRegeneration && parentUserMsgId) {
                const existing = (get().messagesById[body.conversationId] ?? {})[parentUserMsgId];
                if (!existing) {
                  set((s) => {
                    const list = s.messages[body.conversationId] ?? [];
                    const byIdExisting = s.messagesById[body.conversationId] ?? {};
                    // Compute the parent for this user message (last ASSISTANT or SYSTEM) unless editing
                    let userParentId: string | null = body.userMessageParentId ?? null;
                    if (!userParentId) {
                      for (let i = list.length - 1; i >= 0; i--) {
                        const m = list[i];
                        if (m.role === "ASSISTANT" || m.role === "SYSTEM") {
                          userParentId = m.messageId;
                          break;
                        }
                      }
                    }
                    const userMsg: ChatMessage = {
                      messageId: parentUserMsgId,
                      role: "USER",
                      content: body.userMessage,
                      status: "COMPLETE",
                      parentId: userParentId,
                      createdAt: new Date().toISOString(),
                    };
                    const nextList = [...list, userMsg];
                    const byId = { ...byIdExisting, [userMsg.messageId]: userMsg };
                    const idx = { ...(s.messageIndex[body.conversationId] ?? {}) };
                    idx[userMsg.messageId] = nextList.length - 1;
                    return {
                      messages: { ...s.messages, [body.conversationId]: nextList },
                      messagesById: { ...s.messagesById, [body.conversationId]: byId },
                      messageIndex: { ...s.messageIndex, [body.conversationId]: idx },
                    };
                  });
                }
              }

              // Add placeholder assistant message so tokens can render live
              set((s) => {
                const list = s.messages[body.conversationId] ?? [];
                const newMsg: ChatMessage = {
                  messageId: assistantId,
                  role: "ASSISTANT",
                  content: "",
                  status: "STREAMING",
                  parentId:
                    (parentUserMsgId as string | undefined) ??
                    body.parentUserMessageId ??
                    null,
                  variantIndex: body.variantIndex ?? 0,
                  model: data.model as string,
                  createdAt: new Date().toISOString(),
                };
                const updatedList = [...list, newMsg];
                const byId = { ...(s.messagesById[body.conversationId] ?? {}) };
                const idx = { ...(s.messageIndex[body.conversationId] ?? {}) };
                byId[newMsg.messageId] = newMsg;
                idx[newMsg.messageId] = updatedList.length - 1;
                return {
                  messages: {
                    ...s.messages,
                    [body.conversationId]: updatedList,
                  },
                  messagesById: {
                    ...s.messagesById,
                    [body.conversationId]: byId,
                  },
                  messageIndex: {
                    ...s.messageIndex,
                    [body.conversationId]: idx,
                  },
                };
              });
            } else if (event === "token") {
              const assistantId = get().currentAssistantId[body.conversationId];
              if (!assistantId) continue;
              set((s) => {
                const token = (data.token ?? data.delta ?? "") as string;
                const list = s.messages[body.conversationId] ?? [];
                const idxMap = s.messageIndex[body.conversationId] ?? {};
                const i = idxMap[assistantId];
                if (i === undefined) return {} as ChatState;
                const target = list[i];
                const updatedMessage: ChatMessage = {
                  ...target,
                  content: target.content + token,
                };
                const updatedList = [...list];
                updatedList[i] = updatedMessage;
                const byId = { ...(s.messagesById[body.conversationId] ?? {}) };
                byId[assistantId] = updatedMessage;
                return {
                  messages: {
                    ...s.messages,
                    [body.conversationId]: updatedList,
                  },
                  messagesById: {
                    ...s.messagesById,
                    [body.conversationId]: byId,
                  },
                };
              });
            } else if (event === "status") {
              const assistantId = get().currentAssistantId[body.conversationId];
              if (!assistantId) return;
              set((s) => {
                const list = s.messages[body.conversationId] ?? [];
                const idxMap = s.messageIndex[body.conversationId] ?? {};
                const i = idxMap[assistantId];
                if (i === undefined) return {} as ChatState;
                const target = list[i];
                const label = (() => {
                  const stage = data.stage;
                  const status = data.status;
                  const msg = data.message;
                  if (typeof stage !== "undefined") {
                    return `Stage ${stage}: ${status}${msg ? ` - ${msg}` : ""}`;
                  }
                  return typeof status === "string" ? status : "";
                })();
                const updated: ChatMessage = { ...target, pipelineStatus: label };
                const updatedList = [...list];
                updatedList[i] = updated;
                const byId = { ...(s.messagesById[body.conversationId] ?? {}) };
                byId[assistantId] = updated;
                return {
                  messages: { ...s.messages, [body.conversationId]: updatedList },
                  messagesById: { ...s.messagesById, [body.conversationId]: byId },
                };
              });
            } else if (event === "structured_data") {
              const assistantId = get().currentAssistantId[body.conversationId];
              if (!assistantId) return;
              set((s) => {
                const list = s.messages[body.conversationId] ?? [];
                const idxMap = s.messageIndex[body.conversationId] ?? {};
                const i = idxMap[assistantId];
                if (i === undefined) return {} as ChatState;
                const target = list[i];
                const updated: ChatMessage = { ...target, structuredData: data };
                const updatedList = [...list];
                updatedList[i] = updated;
                const byId = { ...(s.messagesById[body.conversationId] ?? {}) };
                byId[assistantId] = updated;
                return {
                  messages: { ...s.messages, [body.conversationId]: updatedList },
                  messagesById: { ...s.messagesById, [body.conversationId]: byId },
                };
              });
            } else if (event === "viz_config") {
              const assistantId = get().currentAssistantId[body.conversationId];
              if (!assistantId) return;
              set((s) => {
                const list = s.messages[body.conversationId] ?? [];
                const idxMap = s.messageIndex[body.conversationId] ?? {};
                const i = idxMap[assistantId];
                if (i === undefined) return {} as ChatState;
                const target = list[i];
                const updated: ChatMessage = { ...target, visualizationConfig: data };
                const updatedList = [...list];
                updatedList[i] = updated;
                const byId = { ...(s.messagesById[body.conversationId] ?? {}) };
                byId[assistantId] = updated;
                return {
                  messages: { ...s.messages, [body.conversationId]: updatedList },
                  messagesById: { ...s.messagesById, [body.conversationId]: byId },
                };
              });
            } else if (event === "end") {
              const assistantId = get().currentAssistantId[body.conversationId];
              set((s) => {
                const list = s.messages[body.conversationId] ?? [];
                const idxMap = s.messageIndex[body.conversationId] ?? {};
                if (assistantId === undefined) return {} as ChatState;
                const i = idxMap[assistantId];
                if (i === undefined) return {} as ChatState;
                const target = list[i];
                const updatedMessage: ChatMessage = {
                  ...target,
                  status:
                    data.status === "complete"
                      ? "COMPLETE"
                      : "INTERRUPTED",
                };
                const updatedList = [...list];
                updatedList[i] = updatedMessage;
                const byId = { ...(s.messagesById[body.conversationId] ?? {}) };
                byId[assistantId] = updatedMessage;
                return {
                  messages: {
                    ...s.messages,
                    [body.conversationId]: updatedList,
                  },
                  messagesById: {
                    ...s.messagesById,
                    [body.conversationId]: byId,
                  },
                };
              });
              // Clear streaming state
              set((s) => ({
                isStreaming: { ...s.isStreaming, [body.conversationId]: false },
              }));
              // Refresh from server after completion to sync DB content
              get()
                .loadConversation(body.conversationId)
                .catch(() => {});
            } else if (event === "title") {
              const title = data.title as string;
              set((s) => ({
                conversations: {
                  ...s.conversations,
                  [body.conversationId]: s.conversations[body.conversationId]
                    ? { ...s.conversations[body.conversationId]!, title }
                    : s.conversations[body.conversationId],
                },
              }));
            } else if (event === "error") {
              console.error("Stream error:", data);
              set((s) => ({
                isStreaming: { ...s.isStreaming, [body.conversationId]: false },
              }));
            }
          }
        }
      } catch (e) {
        console.error("Stream failed:", e);
        set((s) => ({
          isStreaming: { ...s.isStreaming, [body.conversationId]: false },
        }));
      }
    };

    run();
  },

  async stopStream(conversationId) {
    try {
      await fetch("/api/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      });
    } catch {}
    const controller = get().controllers[conversationId];
    if (controller) controller.abort();
    set((s) => ({
      isStreaming: { ...s.isStreaming, [conversationId]: false },
      controllers: { ...s.controllers, [conversationId]: undefined },
    }));
  },

  clearStream(conversationId) {
    const controller = get().controllers[conversationId];
    if (controller) controller.abort();
    set((s) => ({
      controllers: { ...s.controllers, [conversationId]: undefined },
      currentAssistantId: {
        ...s.currentAssistantId,
        [conversationId]: undefined,
      },
      isStreaming: { ...s.isStreaming, [conversationId]: false },
    }));
  },
}));
