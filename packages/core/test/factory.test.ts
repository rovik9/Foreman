import { describe, expect, it } from "vitest";
import {
  buildProvidersFromEnv,
  ENV_VAR_FOR,
  resolveProviderLive,
} from "../src/providers/factory.js";

describe("buildProvidersFromEnv", () => {
  it("builds only the vendors with a key present", () => {
    const map = buildProvidersFromEnv({ ANTHROPIC_API_KEY: "sk-1" } as NodeJS.ProcessEnv);
    expect(map.anthropic).toBeDefined();
    expect(map.openai).toBeUndefined();
  });

  it("builds nothing from an empty env", () => {
    const map = buildProvidersFromEnv({} as NodeJS.ProcessEnv);
    expect(Object.keys(map)).toHaveLength(0);
  });
});

describe("resolveProviderLive", () => {
  it("prefers a DB-backed key over .env", () => {
    const store = { getApiKey: () => "db-key" };
    const provider = resolveProviderLive("anthropic", store, {
      ANTHROPIC_API_KEY: "env-key",
    } as NodeJS.ProcessEnv);
    expect(provider).toBeDefined();
  });

  it("falls back to .env when no DB key is set", () => {
    const store = { getApiKey: () => undefined };
    const provider = resolveProviderLive("anthropic", store, {
      ANTHROPIC_API_KEY: "env-key",
    } as NodeJS.ProcessEnv);
    expect(provider).toBeDefined();
  });

  it("returns undefined when neither DB nor env has a key", () => {
    const store = { getApiKey: () => undefined };
    const provider = resolveProviderLive("anthropic", store, {} as NodeJS.ProcessEnv);
    expect(provider).toBeUndefined();
  });

  it("returns undefined for an unknown via", () => {
    const store = { getApiKey: () => "whatever" };
    expect(resolveProviderLive("not-a-vendor", store, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("covers every vendor in ENV_VAR_FOR", () => {
    for (const via of Object.keys(ENV_VAR_FOR)) {
      const store = { getApiKey: () => "k" };
      expect(resolveProviderLive(via, store, {} as NodeJS.ProcessEnv)).toBeDefined();
    }
  });
});
