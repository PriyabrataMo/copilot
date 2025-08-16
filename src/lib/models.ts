export type ChatModelId =
  | "gpt-4o-mini"
  | "gpt-4o"
  | "gpt-4-turbo"
  | "gpt-3.5-turbo";

type ModelInfo = {
  id: ChatModelId;
  label: string;
  maxContextTokens: number;
  maxCompletionTokens: number; // max tokens for completion
  outputHeadroomRatio: number; // reserve fraction for completion
};

export const MODELS: ModelInfo[] = [
  { id: "gpt-4o-mini", label: "GPT-4o mini", maxContextTokens: 128000, maxCompletionTokens: 16384, outputHeadroomRatio: 0.1 },
  { id: "gpt-4o", label: "GPT-4o", maxContextTokens: 128000, maxCompletionTokens: 4096, outputHeadroomRatio: 0.1 },
  { id: "gpt-4-turbo", label: "GPT-4 Turbo", maxContextTokens: 128000, maxCompletionTokens: 4096, outputHeadroomRatio: 0.1 },
  { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo", maxContextTokens: 16000, maxCompletionTokens: 4096, outputHeadroomRatio: 0.1 },
];

export const DEFAULT_MODEL: ChatModelId = "gpt-4o-mini";

export function getModelInfo(id: ChatModelId): ModelInfo {
  const found = MODELS.find((m) => m.id === id);
  return found ?? MODELS[0];
}


