"use client";
import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Message = {
  messageId: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  status: "STREAMING" | "COMPLETE" | "INTERRUPTED" | "ERROR";
  parentId?: string | null;
  variantIndex?: number | null;
  model?: string | null;
};

type MessageBubbleProps = {
  message: Message;
  variants?: Message[]; // All assistant variants for this user turn
  currentVariantIndex?: number;
  isEditing?: boolean;
  onEdit?: (content: string) => void;
  onCopy?: () => void;
  onDelete?: () => void;
  onRegenerate?: () => void;
  onVariantChange?: (index: number) => void;
  onStartEdit?: () => void;
  onCancelEdit?: () => void;
};

export function MessageBubble({
  message,
  variants = [],
  currentVariantIndex = 0,
  isEditing = false,
  onEdit,
  onCopy,
  onDelete,
  onRegenerate,
  onVariantChange,
  onStartEdit,
  onCancelEdit,
}: MessageBubbleProps) {
  const [editContent, setEditContent] = useState(message.content);
  const isUser = message.role === "USER";
  const isAssistant = message.role === "ASSISTANT";
  const hasVariants = variants.length > 1;

  function handleSaveEdit() {
    if (onEdit) {
      onEdit(editContent);
    }
  }

  function handleCancelEdit() {
    setEditContent(message.content);
    if (onCancelEdit) {
      onCancelEdit();
    }
  }

  const currentMessage = variants.length > 0 ? variants[currentVariantIndex] : message;

  return (
    <div className={`group flex ${isUser ? "justify-end" : "justify-start"} mb-4`}>
      <div className={`max-w-[70%] rounded-lg p-4 ${
        isUser 
          ? "bg-blue-500 text-white" 
          : "bg-gray-100 text-gray-800"
      }`}>
        
        {/* Role Header */}
        <div className="text-xs opacity-70 mb-2">
          {message.role}
          {isAssistant && hasVariants && (
            <span className="ml-2">
              ({currentVariantIndex + 1} of {variants.length})
            </span>
          )}
        </div>

        {/* Message Content */}
        {isEditing ? (
          <div className="space-y-3">
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="w-full p-2 border rounded text-gray-800 min-h-[100px] resize-none"
              placeholder="Edit your message..."
            />
            <div className="flex gap-2">
              <button
                onClick={handleSaveEdit}
                className="px-3 py-1 bg-blue-500 text-white rounded text-sm hover:bg-blue-600"
              >
                Save & Submit
              </button>
              <button
                onClick={handleCancelEdit}
                className="px-3 py-1 bg-gray-500 text-white rounded text-sm hover:bg-gray-600"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="prose prose-sm max-w-none">
            {isAssistant ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {currentMessage.content}
              </ReactMarkdown>
            ) : (
              <div className="whitespace-pre-wrap">{message.content}</div>
            )}
          </div>
        )}

        {/* Assistant Variant Navigation */}
        {isAssistant && hasVariants && !isEditing && (
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-200">
            <button
              onClick={() => onVariantChange && onVariantChange(Math.max(0, currentVariantIndex - 1))}
              disabled={currentVariantIndex === 0}
              className="p-1 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              ←
            </button>
            <span className="text-xs text-gray-500">
              {currentVariantIndex + 1} / {variants.length}
            </span>
            <button
              onClick={() => onVariantChange && onVariantChange(Math.min(variants.length - 1, currentVariantIndex + 1))}
              disabled={currentVariantIndex === variants.length - 1}
              className="p-1 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              →
            </button>
          </div>
        )}

        {/* Action Buttons */}
        {!isEditing && (
          <div className="opacity-0 group-hover:opacity-100 transition-opacity mt-3 flex gap-2">
            {isUser && (
              <button
                onClick={onStartEdit}
                className="text-xs px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
              >
                Edit
              </button>
            )}
            {isAssistant && (
              <>
                <button
                  onClick={onRegenerate}
                  className="text-xs px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                >
                  Regenerate
                </button>
                <button
                  onClick={onCopy}
                  className="text-xs px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                >
                  Copy
                </button>
              </>
            )}
            <button
              onClick={onDelete}
              className="text-xs px-2 py-1 bg-red-200 text-red-700 rounded hover:bg-red-300"
            >
              Delete
            </button>
          </div>
        )}

        {/* Streaming Indicator */}
        {currentMessage.status === "STREAMING" && (
          <div className="mt-2 text-xs opacity-70">
            <span className="inline-block w-2 h-2 bg-current rounded-full animate-pulse mr-1"></span>
            Thinking...
          </div>
        )}
      </div>
    </div>
  );
}
