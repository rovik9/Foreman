import { OpenAICompatProvider } from "./openai-compat.js";

/**
 * Groq direct — used for the latency-critical realtime/news slot.
 * Groq's API is OpenAI-compatible but does not report $ cost in usage;
 * costUsd comes back 0 and is estimated later from the price table.
 */
export class GroqProvider extends OpenAICompatProvider {
  constructor(apiKey: string, baseUrl = "https://api.groq.com/openai/v1") {
    super({ baseUrl, apiKey });
  }
}
