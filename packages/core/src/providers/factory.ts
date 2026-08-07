import { AnthropicProvider } from "./anthropic.js";
import { GroqProvider } from "./groq.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { OpenRouterProvider } from "./openrouter.js";
import type { Provider } from "./types.js";

/** Keyed by the slot's `via` value. "mock" is reserved for tests/demos. */
export type ProviderMap = Record<string, Provider | undefined>;

/** via -> the env var / settings-store key name that holds its API key. */
export const ENV_VAR_FOR: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** Constructs the right Provider for a vendor given its raw API key. */
function buildProvider(via: string, apiKey: string): Provider | undefined {
  switch (via) {
    case "anthropic":
      return new AnthropicProvider(apiKey);
    case "openai":
      return new OpenAICompatProvider({ baseUrl: "https://api.openai.com/v1", apiKey });
    case "moonshot":
      return new OpenAICompatProvider({ baseUrl: "https://api.moonshot.ai/v1", apiKey });
    case "groq":
      return new GroqProvider(apiKey);
    case "openrouter":
      // escape hatch only — not the default path (see config/models.yaml)
      return new OpenRouterProvider(apiKey);
    default:
      return undefined;
  }
}

/**
 * Builds one provider per vendor from environment keys. Missing key = the
 * slot is unroutable; the harness throws a clear error at call time instead
 * of failing at boot, so Foreman stays usable with a partial key set.
 */
export function buildProvidersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProviderMap {
  const map: ProviderMap = {};
  for (const [via, envVar] of Object.entries(ENV_VAR_FOR)) {
    const key = env[envVar];
    if (key) map[via] = buildProvider(via, key);
  }
  return map;
}

/** Minimal shape the live resolver needs — avoids importing the whole Store class. */
export interface ApiKeySource {
  getApiKey(name: string): string | undefined;
}

/**
 * Live provider resolution: DB-backed key (settings UI) wins, falls back to
 * .env, built fresh on every call so a key added mid-session works without
 * a restart. Cheap — providers are just fetch wrappers holding a key.
 */
export function resolveProviderLive(
  via: string,
  keys: ApiKeySource,
  env: NodeJS.ProcessEnv = process.env,
): Provider | undefined {
  const envVar = ENV_VAR_FOR[via];
  if (!envVar) return undefined;
  const apiKey = keys.getApiKey(envVar) ?? env[envVar];
  return apiKey ? buildProvider(via, apiKey) : undefined;
}
