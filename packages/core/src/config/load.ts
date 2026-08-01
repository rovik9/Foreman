import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ForemanConfig,
  LimitsConfigSchema,
  MemoryConfigSchema,
  ModelsConfigSchema,
  PricesConfigSchema,
  type ModelsConfig,
} from "./schema.js";

/**
 * Cross-checks that enforce referential integrity between slots and tiers.
 * A broken registry must fail fast at boot, never mid-run.
 */
function validateRegistry(models: ModelsConfig): void {
  for (const [taskClass, slotNames] of Object.entries(models.tiers)) {
    for (const slotName of slotNames) {
      if (!models.slots[slotName]) {
        throw new Error(
          `models.yaml: tier "${taskClass}" references unknown slot "${slotName}"`,
        );
      }
    }
  }
  for (const name of Object.keys(models.cost_weights)) {
    if (!models.slots[name]) {
      throw new Error(
        `models.yaml: cost_weights references unknown slot "${name}"`,
      );
    }
  }
}

export function loadConfig(configDir: string): ForemanConfig {
  const modelsRaw = parseYaml(
    readFileSync(join(configDir, "models.yaml"), "utf8"),
  );
  const limitsRaw = parseYaml(
    readFileSync(join(configDir, "limits.yaml"), "utf8"),
  );

  const models = ModelsConfigSchema.parse(modelsRaw);
  validateRegistry(models);
  const limits = LimitsConfigSchema.parse(limitsRaw);

  // prices.yaml is optional — without it, costs estimate to $0 and the
  // budget caps run blind, so we warn loudly instead of failing.
  let prices = PricesConfigSchema.parse({ models: {} });
  try {
    prices = PricesConfigSchema.parse(
      parseYaml(readFileSync(join(configDir, "prices.yaml"), "utf8")),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    console.warn("config/prices.yaml not found — cost estimates will be $0");
  }

  // memory.yaml is optional — defaults: local vault at ./memory, no push
  let memory = MemoryConfigSchema.parse({});
  try {
    memory = MemoryConfigSchema.parse(
      parseYaml(readFileSync(join(configDir, "memory.yaml"), "utf8")),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  return { models, limits, prices, memory };
}
