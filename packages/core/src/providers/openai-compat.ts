import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  Provider,
} from "./types.js";

interface CompatResponse {
  choices?: { message?: { content?: string } }[];
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  };
  error?: { message?: string };
}

export interface CompatOptions {
  baseUrl: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  /** Merge into the request body (e.g. OpenRouter's usage:include). */
  extraBody?: Record<string, unknown>;
}

/** Shared client for OpenAI-compatible chat-completion APIs. */
export class OpenAICompatProvider implements Provider {
  constructor(protected readonly opts: CompatOptions) {}

  async chat(messages: ChatMessage[], chatOpts: ChatOptions): Promise<ChatResult> {
    const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
        ...this.opts.extraHeaders,
      },
      body: JSON.stringify({
        model: chatOpts.model,
        messages,
        max_tokens: chatOpts.maxTokens,
        temperature: chatOpts.temperature,
        ...this.opts.extraBody,
      }),
      signal: chatOpts.signal,
    });

    const body = (await res.json()) as CompatResponse;
    if (!res.ok || body.error) {
      throw new Error(
        `${this.opts.baseUrl} ${res.status}: ${body.error?.message ?? res.statusText}`,
      );
    }

    return {
      content: body.choices?.[0]?.message?.content ?? "",
      model: body.model ?? chatOpts.model,
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
      costUsd: body.usage?.cost ?? 0,
    };
  }
}
