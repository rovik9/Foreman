export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  model: string; // actual model id reported by the provider
  promptTokens: number;
  completionTokens: number;
  costUsd: number; // provider-reported when available, else 0
}

export interface ChatOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/** A provider turns chat messages in, metered completion out. */
export interface Provider {
  chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult>;
}
