"use client";
import { Sidebar } from "@/src/components/Sidebar";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();

  async function createNew() {
    const res = await fetch("/api/conversations", { 
      method: "POST", 
      headers: { "Content-Type": "application/json" }, 
      body: JSON.stringify({}) 
    });
    const data = await res.json();
    router.push(`/c/${data.conversationId}`);
  }

  function handleSelect(conversationId: string) {
    router.push(`/c/${conversationId}`);
  }

  return (
    <div className="flex h-screen">
      <Sidebar 
        activeConversationId={null} 
        onSelect={handleSelect} 
        onNew={createNew}
      />
      <div className="flex-1 grid place-items-center">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-gray-800 mb-4">ChatGPT Clone</h1>
          <p className="text-gray-600 mb-8">Start a conversation to begin</p>
          <button 
            onClick={createNew}
            className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
          >
            New Conversation
          </button>
        </div>
      </div>
    </div>
  );
}
