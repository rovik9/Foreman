import { OpenAICompatProvider } from "./openai-compat.js";

/**
 * OpenRouter gateway — one API key in front of GPT / Claude / Kimi / Groq-hosted
 * models, with per-call cost reporting so the ledger stays honest.
 */
export class OpenRouterProvider extends OpenAICompatProvider {
  constructor(
    apiKey: string,
    baseUrl = "https://openrouter.ai/api/v1",
  ) {
    super({
      baseUrl,
      apiKey,
      extraHeaders: {
        "HTTP-Referer": "https://github.com/rovik/foreman",
        "X-Title": "Foreman",
      },
      extraBody: { usage: { include: true } },
    });
  }
}
