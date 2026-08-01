import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  Provider,
} from "./types.js";

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

/**
 * Anthropic direct — native /v1/messages API (not OpenAI-compatible).
 * Cost comes back 0; the harness estimates it from the price table.
 */
export class AnthropicProvider implements Provider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.anthropic.com",
  ) {}

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const turns = messages.filter((m) => m.role !== "system");

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        ...(system ? { system } : {}),
        messages: turns,
        ...(opts.temperature !== undefined
          ? { temperature: opts.temperature }
          : {}),
      }),
      signal: opts.signal,
    });

    const body = (await res.json()) as AnthropicResponse;
    if (!res.ok || body.error) {
      throw new Error(
        `anthropic ${res.status}: ${body.error?.message ?? res.statusText}`,
      );
    }

    return {
      content: (body.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join(""),
      model: body.model ?? opts.model,
      promptTokens: body.usage?.input_tokens ?? 0,
      completionTokens: body.usage?.output_tokens ?? 0,
      costUsd: 0,
    };
  }
}
