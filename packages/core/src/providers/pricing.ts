import type { PricesConfig } from "../config/schema.js";

const PER_MILLION = 1_000_000;

/**
 * Cost estimate from token counts. Direct provider APIs don't report $ per
 * call, so the ledger runs on this table. Provider-reported cost (when a
 * provider does return it) always takes precedence over this estimate.
 */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  prices: PricesConfig,
): number {
  const [promptRate, completionRate] =
    prices.models[model] ?? prices.default;
  return (
    (promptTokens * promptRate + completionTokens * completionRate) /
    PER_MILLION
  );
}
