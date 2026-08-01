import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  Provider,
} from "./types.js";

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number; // present when usage.include=true on paid models
}

interface OpenRouterResponse {
  choices?: { message?: { content?: string } }[];
  model?: string;
  usage?: OpenRouterUsage;
  error?: { message?: string };
}

/**
 * OpenRouter gateway — one API key in front of GPT / Claude / Kimi / Groq-hosted
 * models, with per-call cost reporting so the ledger stays honest.
 */
export class OpenRouterProvider implements Provider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://openrouter.ai/api/v1",
  ) {}

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/rovik/foreman",
        "X-Title": "Foreman",
      },
      body: JSON.stringify({
        model: opts.model,
        messages,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        usage: { include: true },
      }),
      signal: opts.signal,
    });

    const body = (await res.json()) as OpenRouterResponse;
    if (!res.ok || body.error) {
      throw new Error(
        `openrouter ${res.status}: ${body.error?.message ?? res.statusText}`,
      );
    }

    return {
      content: body.choices?.[0]?.message?.content ?? "",
      model: body.model ?? opts.model,
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
      costUsd: body.usage?.cost ?? 0,
    };
  }
}
