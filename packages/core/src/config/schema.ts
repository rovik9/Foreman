import { z } from "zod";

/** How a slot reaches its provider. Direct keys only — one adapter per vendor. */
export const ViaSchema = z.enum([
  "anthropic",
  "openai",
  "moonshot",
  "google",
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
export type AssetStudioConfig = z.infer<typeof AssetStudioSchema>;

export const TaskClassSchema = z.enum(["plan", "build", "critique", "fetch"]);
export type TaskClass = z.infer<typeof TaskClassSchema>;

/**
 * Roles are JOBS; slots are MODEL bindings. The user preselects a short
 * option list per role — the Interface AI picks among options per task
 * (fast, no open-ended model deliberation) and logs its reasoning.
 */
export const RoleNameSchema = z.enum([
  "interface", // the boss: prompts everyone, routes, approves memory writes
  "architect", // planning / intelligence / decisions (3 preselected options)
  "trend",     // trend checker & news verifier
  "context",   // long-context synthesis (Gemini Pro intent)
  "builder",
  "judge",
  "memorizer",
]);
export type RoleName = z.infer<typeof RoleNameSchema>;

export const RoleConfigSchema = z.object({
  options: z.array(z.string().min(1)).min(1),
  active: z.string().min(1), // default when the interface doesn't override
});
export type RoleConfig = z.infer<typeof RoleConfigSchema>;

export const ModelsConfigSchema = z.object({
  slots: z.record(z.string(), ModelSlotSchema),
  roles: z.record(RoleNameSchema, RoleConfigSchema),
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
    /** Binaries a builder may execute. Everything else is refused. */
    shell_allowlist: z.array(z.string().min(1)).min(1),
    /** Tool calls one builder attempt may make before it's cut off. */
    max_tool_steps: z.number().int().positive().default(24),
    command_timeout_ms: z.number().int().positive().default(120_000),
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
  memory: MemoryConfig;
}

export const MemoryConfigSchema = z.object({
  /** Local-first vault root; per-product subdirs are their own git repos. */
  mirror_dir: z.string().min(1).default("memory"),
  /** Push to remotes after each documented run. Local commit always happens. */
  auto_push: z.boolean().default(false),
  /** product slug -> git remote (use SSH URLs, never tokens in URLs). */
  remotes: z.record(z.string(), z.string()).default({}),
});
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
