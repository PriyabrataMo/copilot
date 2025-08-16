"use client";
import React, { useEffect, useState } from "react";

type Conversation = {
  id: string;
  conversationId: string;
  title: string | null;
  model: string | null;
};

export function Sidebar({
  activeConversationId,
  onSelect,
  onNew,
  onTitleUpdate,
}: {
  activeConversationId?: string | null;
  onSelect: (conversationId: string) => void;
  onNew: () => void;
  onTitleUpdate?: (conversationId: string, title: string) => void;
}) {
  const [list, setList] = useState<Conversation[]>([]);

  async function refresh() {
    const res = await fetch("/api/conversations");
    const data = await res.json();
    setList(data);
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    refresh(); // Refresh when active conversation changes
  }, [activeConversationId]);

  async function deleteConversation(conversationId: string, e: React.MouseEvent) {
    e.stopPropagation(); // Prevent triggering onSelect
    if (!confirm("Delete this conversation?")) return;
    
    try {
      const res = await fetch(`/api/conversations/${conversationId}`, { method: "DELETE" });
      if (res.ok) {
        setList(prev => prev.filter(c => c.conversationId !== conversationId));
        // If we deleted the active conversation, redirect to home
        if (conversationId === activeConversationId) {
          window.location.href = "/";
        }
      }
    } catch (error) {
      console.error("Failed to delete conversation:", error);
    }
  }

  // Function to update title in the list
  function updateTitle(conversationId: string, title: string) {
    setList(prev => prev.map(c => 
      c.conversationId === conversationId ? { ...c, title } : c
    ));
  }

  // Expose updateTitle to parent
  React.useEffect(() => {
    if (onTitleUpdate) {
      const globalWindow = window as typeof window & { _updateSidebarTitle?: (id: string, title: string) => void };
      globalWindow._updateSidebarTitle = updateTitle;
    }
  }, [onTitleUpdate]);

  return (
    <div className="w-64 border-r h-screen flex flex-col bg-white">
      <div className="p-2 border-b flex items-center justify-between bg-white">
        <div className="font-semibold">Chats</div>
        <button className="text-sm px-2 py-1 border rounded hover:bg-gray-100" onClick={onNew}>New</button>
      </div>
      <div className="flex-1 overflow-auto">
        {list.map((c) => (
          <div
            key={c.conversationId}
            className={`flex items-center hover:bg-gray-100 ${activeConversationId === c.conversationId ? "border-l-4 border-blue-500 bg-blue-50" : ""}`}
          >
            <button
              onClick={() => onSelect(c.conversationId)}
              className="flex-1 text-left px-3 py-2 w-[20px]"
            >
              <div className="truncate text-sm w-full">{c.title ?? "Untitled"}</div>
              <div className="text-xs text-gray-500">{c.model ?? "default"}</div>
            </button>
            <button
              onClick={(e) => deleteConversation(c.conversationId, e)}
              className="px-2 py-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded mr-2 transition-colors"
              title="Delete conversation"
            >
              🗑️
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}


