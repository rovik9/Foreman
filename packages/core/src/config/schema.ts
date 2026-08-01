import { z } from "zod";

/** How a slot reaches its provider. Direct keys only — one adapter per vendor. */
export const ViaSchema = z.enum([
  "anthropic",
  "openai",
  "moonshot",
  "groq",
  "openrouter", // kept as an escape hatch, not the default path
  "direct",
]);
export type Via = z.infer<typeof ViaSchema>;

export const ModelSlotSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  via: ViaSchema,
  fallback: z.string().optional(),
});
export type ModelSlot = z.infer<typeof ModelSlotSchema>;

export const AssetStudioSchema = z.object({
  type: z.literal("mcp"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});

export const TaskClassSchema = z.enum(["plan", "build", "critique", "fetch"]);
export type TaskClass = z.infer<typeof TaskClassSchema>;

export const ModelsConfigSchema = z.object({
  slots: z.record(z.string(), ModelSlotSchema),
  tiers: z.record(TaskClassSchema, z.array(z.string().min(1)).min(1)),
  cost_weights: z.record(z.string(), z.number().positive()),
  asset_studios: z.record(z.string(), AssetStudioSchema),
});
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

export const LimitsConfigSchema = z.object({
  max_iterations_per_task: z.number().int().positive(),
  max_cost_per_run_usd: z.number().positive(),
  max_cost_per_task_usd: z.number().positive(),
  max_parallel_builders: z.number().int().positive(),
  pm_clarify_confidence_threshold: z.number().min(0).max(1),
  judge_pass_score: z.number().min(0).max(1),
  sandbox: z.object({
    workspace_root: z.string().min(1),
    shell_allowlist: z.array(z.string().min(1)).min(1),
  }),
});
export type LimitsConfig = z.infer<typeof LimitsConfigSchema>;

/** USD per 1M tokens: [prompt, completion]. */
export const PricePairSchema = z.tuple([
  z.number().nonnegative(),
  z.number().nonnegative(),
]);
export const PricesConfigSchema = z.object({
  models: z.record(z.string(), PricePairSchema),
  default: PricePairSchema.default([0, 0]),
});
export type PricesConfig = z.infer<typeof PricesConfigSchema>;

export interface ForemanConfig {
  models: ModelsConfig;
  limits: LimitsConfig;
  prices: PricesConfig;
}
