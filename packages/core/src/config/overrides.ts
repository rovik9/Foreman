import {
  LimitsConfigSchema,
  RoleConfigSchema,
  RoleNameSchema,
  type ForemanConfig,
} from "./schema.js";

/**
 * Config precedence: `config/*.yaml` provides defaults, anything edited in the
 * Settings UI overrides it. Overrides live in the DB (never rewriting the
 * user's YAML) and are applied *onto the live config object* — which every
 * agent, router and runner already holds by reference — so an edit takes
 * effect on the next model call without a restart.
 */

export interface OverrideSource {
  listConfigOverrides(): { key: string; value: unknown }[];
}

/** Dotted paths we accept. Anything else is rejected rather than silently set. */
const LIMIT_KEYS = new Set([
  "max_iterations_per_task",
  "max_cost_per_run_usd",
  "max_cost_per_task_usd",
  "max_parallel_builders",
  "pm_clarify_confidence_threshold",
  "judge_pass_score",
]);

/** The engine only knows these roles; anything else would be dead config. */
const ROLE_NAMES = new Set<string>(RoleNameSchema.options);

export function isValidOverrideKey(key: string): boolean {
  if (key.startsWith("limits.")) return LIMIT_KEYS.has(key.slice("limits.".length));
  if (key.startsWith("roles.")) return ROLE_NAMES.has(key.slice("roles.".length));
  if (key === "memory.auto_push") return true;
  return false;
}

/**
 * Validates one override against the same schemas the YAML is parsed with, so
 * a bad value from the UI can never leave the config in a shape the pipeline
 * doesn't expect. Returns an error string, or null when it applies cleanly.
 */
export function applyOverride(
  config: ForemanConfig,
  key: string,
  value: unknown,
): string | null {
  if (!isValidOverrideKey(key)) return `unknown setting "${key}"`;

  if (key.startsWith("limits.")) {
    const field = key.slice("limits.".length);
    const candidate = { ...config.limits, [field]: value };
    const parsed = LimitsConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      return parsed.error.issues[0]?.message ?? "invalid value";
    }
    config.limits = parsed.data;
    return null;
  }

  if (key.startsWith("roles.")) {
    const role = key.slice("roles.".length) as keyof ForemanConfig["models"]["roles"];
    const parsed = RoleConfigSchema.safeParse(value);
    if (!parsed.success) return parsed.error.issues[0]?.message ?? "invalid role config";
    for (const slot of parsed.data.options) {
      if (!config.models.slots[slot]) return `unknown slot "${slot}"`;
    }
    if (!parsed.data.options.includes(parsed.data.active)) {
      return `active slot "${parsed.data.active}" is not one of its options`;
    }
    config.models.roles[role] = parsed.data;
    return null;
  }

  if (key === "memory.auto_push") {
    if (typeof value !== "boolean") return "auto_push must be true or false";
    config.memory.auto_push = value;
    return null;
  }

  return `unknown setting "${key}"`;
}

/**
 * Restores one setting to its `config/*.yaml` value. Kept here (rather than
 * inline in the route) so the "what does the YAML say for this key" mapping
 * lives next to the "how do I apply it" mapping and the two can't drift.
 */
export function resetOverride(
  config: ForemanConfig,
  fresh: ForemanConfig,
  key: string,
): string | null {
  if (!isValidOverrideKey(key)) return `unknown setting "${key}"`;

  if (key.startsWith("limits.")) {
    const field = key.slice("limits.".length);
    return applyOverride(config, key, (fresh.limits as unknown as Record<string, unknown>)[field]);
  }
  if (key.startsWith("roles.")) {
    const role = key.slice("roles.".length) as keyof ForemanConfig["models"]["roles"];
    const yamlRole = fresh.models.roles[role];
    if (!yamlRole) return `"${role}" is not defined in config/models.yaml`;
    return applyOverride(config, key, yamlRole);
  }
  return applyOverride(config, key, fresh.memory.auto_push);
}

/** Replays every stored override onto the freshly-loaded YAML config at boot. */
export function applyStoredOverrides(config: ForemanConfig, store: OverrideSource): string[] {
  const problems: string[] = [];
  for (const { key, value } of store.listConfigOverrides()) {
    const err = applyOverride(config, key, value);
    if (err) problems.push(`${key}: ${err}`);
  }
  return problems;
}
