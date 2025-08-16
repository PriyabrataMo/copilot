import type { ChatModelId } from "./models";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// Simple token approximation (roughly 4 chars per token for GPT models)
export function countTokensForModel(model: ChatModelId, text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildPrompt(
  model: ChatModelId,
  systemPrompt: string,
  history: ChatMessage[],
  maxContextTokens: number,
  outputHeadroomRatio: number
): { messages: ChatMessage[]; promptTokens: number; maxCompletionTokens: number } {
  const headroom = Math.floor(maxContextTokens * outputHeadroomRatio);
  const target = maxContextTokens - headroom;
  const messages: ChatMessage[] = [];

  const pushAndMeasure = (msg: ChatMessage): number => {
    const serialized = JSON.stringify(msg);
    return countTokensForModel(model, serialized);
  };

  let tokenSum = 0;
  // Always include system
  const systemMsg: ChatMessage = { role: "system", content: systemPrompt };
  tokenSum += pushAndMeasure(systemMsg);
  messages.push(systemMsg);

  // Sliding window from the end
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    const t = pushAndMeasure(msg);
    if (tokenSum + t > target) break;
    messages.unshift(msg);
    tokenSum += t;
  }

  const maxCompletionTokens = headroom;
  return { messages, promptTokens: tokenSum, maxCompletionTokens };
}


