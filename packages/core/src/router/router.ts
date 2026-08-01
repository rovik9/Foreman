import type { ForemanConfig, RoleName, TaskClass } from "../config/schema.js";

const ROLE_FALLBACKS: Record<RoleName, string> = {
  interface: "pm",
  architect: "architect",
  trend: "realtime",
  context: "context",
  builder: "builder_a",
  judge: "judge",
  memorizer: "memorizer",
};

/** The slot currently active for a role (user-preselected default). */
export function resolveRoleSlot(config: ForemanConfig, role: RoleName): string {
  return config.models.roles[role]?.active ?? ROLE_FALLBACKS[role];
}

/** Task class -> owning role. The interface routes within the role's options. */
export const CLASS_TO_ROLE: Record<TaskClass, RoleName> = {
  plan: "architect",
  build: "builder",
  critique: "judge",
  fetch: "trend",
};

/**
 * Cost-optimizing static router — the fallback when the Interface AI's
 * routing call is unavailable. Picks the cheapest slot the class allows.
 */
export class Router {
  constructor(private readonly config: ForemanConfig) {}

  pick(taskClass: TaskClass): string {
    const candidates = this.config.models.tiers[taskClass];
    if (!candidates || candidates.length === 0) {
      throw new Error(`no slots configured for task class "${taskClass}"`);
    }
    const weight = (slot: string): number =>
      this.config.models.cost_weights[slot] ?? 1;
    return [...candidates].sort((a, b) => weight(a) - weight(b))[0]!;
  }

  /** Ordered fallback chain for a class (cheapest first). */
  chain(taskClass: TaskClass): string[] {
    const candidates = this.config.models.tiers[taskClass];
    if (!candidates) return [];
    const weight = (slot: string): number =>
      this.config.models.cost_weights[slot] ?? 1;
    return [...candidates].sort((a, b) => weight(a) - weight(b));
  }
}
