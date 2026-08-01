import type { ForemanConfig, TaskClass } from "../config/schema.js";

/**
 * Cost-optimizing router. For each task class it picks the cheapest slot
 * (by cost_weights) that the class allows. Quality floor: classes are
 * curated so every listed slot meets the bar for that work — the cheap
 * models never see a task they can't handle.
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
