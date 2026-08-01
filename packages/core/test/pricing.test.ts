import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "../src/providers/pricing.js";
import type { PricesConfig } from "../src/config/schema.js";

const prices: PricesConfig = {
  models: { "kimi-k3": [0.6, 2.5] },
  default: [1.0, 3.0],
};

describe("estimateCostUsd", () => {
  it("computes from the model's price pair", () => {
    // 1M prompt @ $0.60 + 1M completion @ $2.50 = $3.10
    expect(estimateCostUsd("kimi-k3", 1_000_000, 1_000_000, prices)).toBeCloseTo(3.1, 6);
  });

  it("scales linearly", () => {
    // 100k prompt @ 0.60/1M = $0.06; 10k completion @ 2.50/1M = $0.025
    expect(estimateCostUsd("kimi-k3", 100_000, 10_000, prices)).toBeCloseTo(0.085, 6);
  });

  it("falls back to default for unknown models", () => {
    expect(estimateCostUsd("mystery-model", 1_000_000, 0, prices)).toBeCloseTo(1.0, 6);
  });

  it("zero tokens cost zero", () => {
    expect(estimateCostUsd("kimi-k3", 0, 0, prices)).toBe(0);
  });
});
