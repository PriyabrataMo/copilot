"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { MODELS, type ChatModelId, DEFAULT_MODEL } from "@/src/lib/models";

type Message = {
  messageId: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  status: "STREAMING" | "COMPLETE" | "INTERRUPTED" | "ERROR";
  parentId?: string | null;
  model?: string | null;
};

type Conversation = {
  id: string;
  conversationId: string;
  title: string | null;
  model: string | null;
};

export function Chat({ conversationId, onTitleUpdate }: { conversationId: string; onTitleUpdate?: (title: string) => void }) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeModel, setActiveModel] = useState<ChatModelId>(DEFAULT_MODEL);
  const esRef = useRef<{ stop: () => void } | null>(null);
  const lastAssistantIdRef = useRef<string | null>(null);

  const canStop = isStreaming;

  async function load() {
    const res = await fetch(`/api/conversations/${conversationId}/messages`);
    const data = await res.json();
    setConversation(data.conversation);
    setActiveModel((data.conversation?.model ?? DEFAULT_MODEL) as ChatModelId);
    setMessages(data.messages);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  function connectSSE(body: { conversationId: string; userMessage: string; model: ChatModelId; regenerateOfMessageId?: string }) {
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
        setMessages((prev) => [
          ...prev,
          {
            messageId: data.messageId as string,
            role: "ASSISTANT",
            content: "",
            status: "STREAMING",
            parentId: body.regenerateOfMessageId ?? null,
            model: data.model as string,
          },
        ]);
      } else if (event === "token") {
        setMessages((prev) =>
          prev.map((m) =>
            m.messageId === lastAssistantIdRef.current ? { ...m, content: m.content + (data.delta as string ?? "") } : m
          )
        );
      } else if (event === "finish") {
        // optional finish info
      } else if (event === "end") {
        setMessages((prev) => prev.map((m) => (m.messageId === lastAssistantIdRef.current ? { ...m, status: data.status === "complete" ? "COMPLETE" : "INTERRUPTED" } : m)));
        setIsStreaming(false);
      } else if (event === "title") {
        // Update title in real-time
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

    // Start the stream
    run();

    return { stop: () => controller.abort() };
  }

  async function send() {
    if (!input.trim()) return;
    const body = {
      conversationId,
      userMessage: input,
      model: activeModel,
    };
    setMessages((prev) => [
      ...prev,
      { messageId: `local-${Date.now()}`, role: "USER", content: input, status: "COMPLETE" },
    ]);
    setInput("");
    const conn = connectSSE(body);
    esRef.current = conn;
  }

  async function stop() {
    try {
      await fetch("/api/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId }) });
    } catch {}
  }

  async function regenerate(messageId: string) {
    const body = {
      conversationId,
      userMessage: "", // empty; regen relies on history; server will use previous user turn
      model: activeModel,
      regenerateOfMessageId: messageId,
    };
    const conn = connectSSE(body);
    esRef.current = conn;
  }

  async function onNewModelChange(m: ChatModelId) {
    setActiveModel(m);
    if (conversation?.conversationId) {
      await fetch(`/api/conversations/${conversation.conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: m }),
      });
    }
  }

  const grouped = useMemo(() => messages, [messages]);

  return (
    <div className="flex flex-col h-screen">
      <div className="border-b p-2 flex items-center gap-2 bg-white">
        <select
          className="border rounded px-2 py-1 text-sm"
          value={activeModel}
          onChange={(e) => onNewModelChange(e.target.value as ChatModelId)}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <div className="ml-auto flex gap-2">
          <button className="px-2 py-1 border rounded text-sm" onClick={stop} disabled={!canStop}>
            Stop
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-3 bg-white">
        {grouped.map((m) => (
          <div key={m.messageId} className="group">
            <div className="text-xs text-gray-600 mb-1">{m.role}</div>
            <div className="whitespace-pre-wrap rounded border p-3 bg-white text-black">
              {m.content}
            </div>
            {m.role === "ASSISTANT" && (
              <div className="opacity-100 mt-1 flex gap-2">
                <button className="text-xs px-2 py-1 border rounded hover:bg-gray-100" onClick={() => navigator.clipboard.writeText(m.content)}>Copy</button>
                <button className="text-xs px-2 py-1 border rounded hover:bg-gray-100" onClick={() => regenerate(m.messageId)}>Regenerate</button>
                <button
                  className="text-xs px-2 py-1 border rounded hover:bg-gray-100"
                  onClick={async () => {
                    await fetch(`/api/messages/${m.messageId}`, { method: "DELETE" });
                    setMessages((prev) => prev.filter((x) => x.messageId !== m.messageId));
                  }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="border-t p-3 flex gap-2 bg-white">
        <textarea
          className="flex-1 border rounded p-2 text-sm text-black placeholder-gray-500"
          value={input}
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Send a message"
        />
        <button className="px-3 py-2 border rounded hover:bg-gray-100" onClick={send}>Send</button>
      </div>
    </div>
  );
}


