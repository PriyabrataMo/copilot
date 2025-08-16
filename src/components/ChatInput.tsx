"use client";
import React, { useState, useRef, useEffect } from "react";

type ChatInputProps = {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
};

export function ChatInput({ onSend, disabled = false, placeholder = "Type a message..." }: ChatInputProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSend() {
    if (!input.trim() || disabled) return;
    onSend(input.trim());
    setInput("");
  }

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [input]);

  return (
    <div className="border-t p-4 bg-white">
      <div className="flex gap-3 items-end">
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            className="w-full border rounded-lg p-3 pr-12 text-sm resize-none min-h-[44px] max-h-[200px] disabled:opacity-50 disabled:cursor-not-allowed"
            rows={1}
          />
          <div className="absolute bottom-2 right-2 text-xs text-gray-400">
            {input.length > 0 && (
              <span>Shift+Enter for new line</span>
            )}
          </div>
        </div>
        <button
          onClick={handleSend}
          disabled={!input.trim() || disabled}
          className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}
