import type { Via } from "../config/schema.js";
import { GroqProvider } from "./groq.js";
import { OpenRouterProvider } from "./openrouter.js";
import type { Provider } from "./types.js";

export type ProviderMap = Partial<Record<Via | "mock", Provider>>;

/**
 * Builds providers from environment keys. Missing key = slot unroutable;
 * the harness throws a clear error at call time instead of failing at boot,
 * so the system stays usable with a partial key set.
 */
export function buildProvidersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProviderMap {
  const map: ProviderMap = {};
  if (env.OPENROUTER_API_KEY) {
    map.openrouter = new OpenRouterProvider(env.OPENROUTER_API_KEY);
  }
  if (env.GROQ_API_KEY) {
    map["groq-direct"] = new GroqProvider(env.GROQ_API_KEY);
  }
  return map;
}
