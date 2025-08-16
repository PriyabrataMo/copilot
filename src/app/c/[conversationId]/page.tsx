"use client";
import { Sidebar } from "@/src/components/Sidebar";
import { EnhancedChat } from "@/src/components/EnhancedChat";
import { useParams, useRouter, notFound } from "next/navigation";
import { useEffect, useState } from "react";

export default function ConversationPage() {
  const params = useParams();
  const router = useRouter();
  const conversationId = params.conversationId as string;
  const [isValidConversation, setIsValidConversation] = useState<boolean | null>(null);

  useEffect(() => {
    // Verify conversation exists
    async function checkConversation() {
      try {
        const res = await fetch(`/api/conversations/${conversationId}/messages`);
        if (res.ok) {
          setIsValidConversation(true);
        } else if (res.status === 404) {
          notFound();
        } else {
          setIsValidConversation(false);
        }
      } catch {
        setIsValidConversation(false);
      }
    }
    
    if (conversationId) {
      checkConversation();
    }
  }, [conversationId]);

  async function createNew() {
    const res = await fetch("/api/conversations", { 
      method: "POST", 
      headers: { "Content-Type": "application/json" }, 
      body: JSON.stringify({}) 
    });
    const data = await res.json();
    router.push(`/c/${data.conversationId}`);
  }

  function handleSelect(newConversationId: string) {
    if (newConversationId !== conversationId) {
      router.push(`/c/${newConversationId}`);
    }
  }

  function handleTitleUpdate(title: string) {
    // Update title in sidebar
    const globalWindow = window as typeof window & { _updateSidebarTitle?: (id: string, title: string) => void };
    if (globalWindow._updateSidebarTitle && conversationId) {
      globalWindow._updateSidebarTitle(conversationId, title);
    }
  }

  if (isValidConversation === null) {
    return (
      <div className="flex h-screen">
        <Sidebar 
          activeConversationId={conversationId} 
          onSelect={handleSelect} 
          onNew={createNew}
          onTitleUpdate={handleTitleUpdate}
        />
        <div className="flex-1 grid place-items-center">
          <div className="text-gray-500">Loading...</div>
        </div>
      </div>
    );
  }

  if (isValidConversation === false) {
    return (
      <div className="flex h-screen">
        <Sidebar 
          activeConversationId={null} 
          onSelect={handleSelect} 
          onNew={createNew}
        />
        <div className="flex-1 grid place-items-center">
          <div className="text-center">
            <h2 className="text-xl font-bold text-gray-800 mb-4">Error Loading Conversation</h2>
            <button 
              onClick={createNew}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            >
              Start New Conversation
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <Sidebar 
        activeConversationId={conversationId} 
        onSelect={handleSelect} 
        onNew={createNew}
        onTitleUpdate={handleTitleUpdate}
      />
      <div className="flex-1">
        <EnhancedChat conversationId={conversationId} onTitleUpdate={handleTitleUpdate} />
      </div>
    </div>
  );
}
