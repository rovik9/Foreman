import { z } from "zod";
import type { ForemanConfig, TaskClass } from "../config/schema.js";
import { CLASS_TO_ROLE, resolveRoleSlot } from "../router/router.js";
import type { TaskDraft } from "./architect.js";
import type { AgentHarness } from "./harness.js";
import { parseJson } from "./json.js";

const AssignmentSchema = z.object({
  assignments: z.array(
    z.object({
      id: z.string(),
      slot: z.string(),
      reason: z.string().default(""),
    }),
  ),
});

const ROUTER_SYSTEM = `You are the Interface AI of Foreman — master of prompting and routing.
Assign every task to exactly one slot from ITS OWN preselected options. Never invent slots.
Optimize: match the task's nature to each model's strength and cost weight.
Give a one-line reason per choice — what in the task drove it.
Respond with JSON only:
{ "assignments": [ { "id": "t1", "slot": "...", "reason": "..." } ] }`;

export interface RoutingResult {
  slots: Map<string, string>;
  reasons: Map<string, string>;
}

/**
 * The Interface AI routes each task across the user-PRESELECTED options for
 * the task's role. Choices come back with logged reasoning. Invalid picks
 * fall back to the role's active slot — a bad choice never breaks a run.
 */
export async function routeTasks(
  harness: AgentHarness,
  runId: string,
  drafts: TaskDraft[],
  config: ForemanConfig,
): Promise<RoutingResult> {
  const optionsFor = (cls: TaskClass): string[] =>
    config.models.roles[CLASS_TO_ROLE[cls]]?.options ?? [];
  const defaultFor = (cls: TaskClass): string =>
    resolveRoleSlot(config, CLASS_TO_ROLE[cls]);

  const slots = new Map<string, string>();
  const reasons = new Map<string, string>();

  // every task has exactly one option → nothing to choose; skip the call
  const table = drafts.map((d) => ({
    id: d.id,
    class: d.class,
    description: d.description,
    options: optionsFor(d.class).map((s) => ({
      slot: s,
      model: config.models.slots[s]?.model,
      cost_weight: config.models.cost_weights[s] ?? 1,
    })),
  }));
  if (table.every((t) => t.options.length <= 1)) {
    for (const d of drafts) slots.set(d.id, defaultFor(d.class));
    return { slots, reasons };
  }

  const r = await harness.run({
    runId,
    slot: harness.roleSlot("interface"),
    role: "interface",
    system: ROUTER_SYSTEM,
    input: `Tasks and their preselected slot options:\n${JSON.stringify(table, null, 2)}`,
    maxTokens: 2048,
  });
  const { assignments } = parseJson(r.output, AssignmentSchema);

  for (const d of drafts) {
    const a = assignments.find((x) => x.id === d.id);
    const valid = a !== undefined && optionsFor(d.class).includes(a.slot);
    const slot = valid ? a.slot : defaultFor(d.class);
    slots.set(d.id, slot);
    if (a?.reason) {
      reasons.set(
        d.id,
        valid ? a.reason : `${a.reason} (invalid slot "${a.slot}" — fell back)`,
      );
    }
  }
  return { slots, reasons };
}
