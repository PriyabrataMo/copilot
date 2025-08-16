"use client";
import React, { useEffect, useState, useRef } from "react";
import { MessageBubble } from "./MessageBubble";
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

type MessageGroup = {
  userMessage: Message;
  assistantVariants: Message[];
  currentVariantIndex: number;
};

export function EnhancedChat({ 
  conversationId, 
  onTitleUpdate 
}: { 
  conversationId: string; 
  onTitleUpdate?: (title: string) => void; 
}) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messageGroups, setMessageGroups] = useState<MessageGroup[]>([]);
  const [activeModel, setActiveModel] = useState<ChatModelId>(DEFAULT_MODEL);
  const [isStreaming, setIsStreaming] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const lastAssistantIdRef = useRef<string | null>(null);
  const streamConnectionRef = useRef<{ stop: () => void } | null>(null);

  async function loadConversation() {
    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`);
      const data = await res.json();
      setConversation(data.conversation);
      setActiveModel((data.conversation?.model ?? DEFAULT_MODEL) as ChatModelId);
      
      // Group messages by user turns
      const groups = groupMessagesByTurns(data.messages);
      setMessageGroups(groups);
    } catch (error) {
      console.error("Failed to load conversation:", error);
    }
  }

  function groupMessagesByTurns(messages: Message[]): MessageGroup[] {
    const groups: MessageGroup[] = [];
    const userMessages = messages.filter(m => m.role === "USER").sort((a, b) => 
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    for (const userMsg of userMessages) {
      const assistantVariants = messages
        .filter(m => m.role === "ASSISTANT" && m.parentId === userMsg.messageId)
        .sort((a, b) => (a.variantIndex || 0) - (b.variantIndex || 0));

      groups.push({
        userMessage: userMsg,
        assistantVariants,
        currentVariantIndex: 0,
      });
    }

    return groups;
  }

  useEffect(() => {
    loadConversation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  function connectSSE(body: { conversationId: string; userMessage: string; model: string; parentId?: string | null; variantIndex?: number; isRegeneration?: boolean }) {
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
            onEvent(event, data);
          }
        }
      } catch (error) {
        console.error("Stream error:", error);
        setIsStreaming(false);
      }
    }

    function onEvent(event: string, data: Record<string, unknown>) {
      if (event === "start") {
        lastAssistantIdRef.current = data.messageId as string;
        // Add new streaming assistant message
        const newMessage: Message = {
          messageId: data.messageId as string,
          role: "ASSISTANT",
          content: "",
          status: "STREAMING",
          parentId: body.parentId || null,
          variantIndex: body.variantIndex || 0,
          model: data.model as string,
          createdAt: new Date().toISOString(),
        };
        
        setMessageGroups(prev => {
          const newGroups = [...prev];
          const lastGroup = newGroups[newGroups.length - 1];
          if (lastGroup) {
            lastGroup.assistantVariants.push(newMessage);
            lastGroup.currentVariantIndex = lastGroup.assistantVariants.length - 1;
          }
          return newGroups;
        });
      } else if (event === "token") {
        setMessageGroups(prev => 
          prev.map(group => ({
            ...group,
            assistantVariants: group.assistantVariants.map(msg =>
              msg.messageId === lastAssistantIdRef.current 
                ? { ...msg, content: msg.content + (data.delta as string ?? "") }
                : msg
            )
          }))
        );
      } else if (event === "end") {
        setMessageGroups(prev => 
          prev.map(group => ({
            ...group,
            assistantVariants: group.assistantVariants.map(msg =>
              msg.messageId === lastAssistantIdRef.current 
                ? { ...msg, status: data.status === "complete" ? "COMPLETE" : "INTERRUPTED" }
                : msg
            )
          }))
        );
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

  async function handleSendMessage(content: string, parentMessageId?: string, isRegeneration = false) {
    if (!content.trim()) return;

    // For new messages, add user message to UI immediately
    if (!isRegeneration) {
      const userMessage: Message = {
        messageId: `temp-${Date.now()}`,
        role: "USER",
        content,
        status: "COMPLETE",
        createdAt: new Date().toISOString(),
      };

      const newGroup: MessageGroup = {
        userMessage,
        assistantVariants: [],
        currentVariantIndex: 0,
      };

      setMessageGroups(prev => [...prev, newGroup]);
    }

    // Determine variant index for regenerations
    let variantIndex = 0;
    if (isRegeneration && parentMessageId) {
      const parentGroup = messageGroups.find(g => g.userMessage.messageId === parentMessageId);
      if (parentGroup) {
        variantIndex = parentGroup.assistantVariants.length;
      }
    }

    const body = {
      conversationId,
      userMessage: content,
      model: activeModel,
      parentId: parentMessageId,
      variantIndex,
      isRegeneration,
    };

    const conn = connectSSE(body);
    streamConnectionRef.current = conn;
  }

  async function handleEditMessage(messageId: string, newContent: string) {
    // Create a new branch from this edit
    await handleSendMessage(newContent, messageId);
    setEditingMessageId(null);
  }

  async function handleRegenerate(groupIndex: number) {
    const group = messageGroups[groupIndex];
    if (!group) return;
    
    await handleSendMessage(group.userMessage.content, group.userMessage.messageId, true);
  }

  async function handleCopyMessage(content: string) {
    await navigator.clipboard.writeText(content);
  }

  async function handleDeleteMessage(messageId: string) {
    try {
      await fetch(`/api/messages/${messageId}`, { method: "DELETE" });
      loadConversation(); // Reload to get updated state
    } catch (error) {
      console.error("Failed to delete message:", error);
    }
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

  function handleVariantChange(groupIndex: number, variantIndex: number) {
    setMessageGroups(prev => 
      prev.map((group, idx) => 
        idx === groupIndex 
          ? { ...group, currentVariantIndex: variantIndex }
          : group
      )
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
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {messageGroups.map((group, groupIndex) => (
          <div key={group.userMessage.messageId} className="space-y-4">
            {/* User Message */}
            <MessageBubble
              message={group.userMessage}
              isEditing={editingMessageId === group.userMessage.messageId}
              onEdit={(content) => handleEditMessage(group.userMessage.messageId, content)}
              onDelete={() => handleDeleteMessage(group.userMessage.messageId)}
              onStartEdit={() => setEditingMessageId(group.userMessage.messageId)}
              onCancelEdit={() => setEditingMessageId(null)}
            />

            {/* Assistant Message(s) */}
            {group.assistantVariants.length > 0 && (
              <MessageBubble
                message={group.assistantVariants[group.currentVariantIndex]}
                variants={group.assistantVariants}
                currentVariantIndex={group.currentVariantIndex}
                onCopy={() => handleCopyMessage(group.assistantVariants[group.currentVariantIndex].content)}
                onDelete={() => handleDeleteMessage(group.assistantVariants[group.currentVariantIndex].messageId)}
                onRegenerate={() => handleRegenerate(groupIndex)}
                onVariantChange={(index) => handleVariantChange(groupIndex, index)}
              />
            )}
          </div>
        ))}
      </div>

      {/* Input */}
      <ChatInput
        onSend={(content) => handleSendMessage(content)}
        disabled={isStreaming}
        placeholder="Type your message... (Shift+Enter for new line)"
      />
    </div>
  );
}
