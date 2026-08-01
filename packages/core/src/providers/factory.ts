import { AnthropicProvider } from "./anthropic.js";
import { GroqProvider } from "./groq.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { OpenRouterProvider } from "./openrouter.js";
import type { Provider } from "./types.js";

/** Keyed by the slot's `via` value. "mock" is reserved for tests/demos. */
export type ProviderMap = Record<string, Provider | undefined>;

/**
 * Builds one provider per vendor from environment keys. Missing key = the
 * slot is unroutable; the harness throws a clear error at call time instead
 * of failing at boot, so Foreman stays usable with a partial key set.
 */
export function buildProvidersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProviderMap {
  const map: ProviderMap = {};
  if (env.ANTHROPIC_API_KEY) {
    map.anthropic = new AnthropicProvider(env.ANTHROPIC_API_KEY);
  }
  if (env.OPENAI_API_KEY) {
    map.openai = new OpenAICompatProvider({
      baseUrl: "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
    });
  }
  if (env.MOONSHOT_API_KEY) {
    map.moonshot = new OpenAICompatProvider({
      baseUrl: "https://api.moonshot.ai/v1",
      apiKey: env.MOONSHOT_API_KEY,
    });
  }
  if (env.GROQ_API_KEY) {
    map.groq = new GroqProvider(env.GROQ_API_KEY);
  }
  if (env.OPENROUTER_API_KEY) {
    // escape hatch only — not the default path (see config/models.yaml)
    map.openrouter = new OpenRouterProvider(env.OPENROUTER_API_KEY);
  }
  return map;
}
