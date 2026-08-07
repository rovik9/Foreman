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

const DISCUSS_SYSTEM = `You are the Interface AI of Foreman — the only one the user talks to.

Right now you are DISCUSSING, not building. Talk like a thoughtful senior engineer in a
normal conversation: plain prose, no JSON, no bullet-point spam, no corporate filler.

Your job in this phase:
- Understand what they actually want, and why. Ask about the parts that genuinely change
  what gets built. One or two real questions at a time, never an interrogation.
- Say what you'd do and briefly why. Name real trade-offs and your recommendation.
- Push back when something seems off, under-specified, or more expensive than it needs to
  be. You are a collaborator, not an order-taker.
- Once the shape is clear, summarise the plan in a few lines and ask if they want you to
  start building. Do NOT start building on your own.

The user can reply to keep talking, or approve the build. When they approve, a crew of
other models (architect, builders, verifier) executes what the two of you agreed.

Respond with JSON only:
{
  "reply": "what you say to the user, in natural prose",
  "ready": true | false   // true only once you've proposed a concrete plan worth approving
}`;

const DiscussSchema = z.object({
  reply: z.string().min(1),
  ready: z.boolean().default(false),
});

export interface DiscussTurn {
  reply: string;
  ready: boolean;
}

/**
 * Conversation phase — the Interface AI talks with the user like a normal
 * assistant and only signals `ready` once there's a concrete plan. Nothing
 * downstream (architect/builders/judge) runs until the user approves, so a
 * prompt is never blind-dumped into the whole crew.
 */
export async function discussWithUser(
  harness: AgentHarness,
  runId: string,
  transcript: { role: string; content: string }[],
): Promise<DiscussTurn> {
  const rendered = transcript
    .map((m) => `${m.role === "user" ? "USER" : "YOU"}: ${m.content}`)
    .join("\n\n");

  const r = await harness.run({
    runId,
    slot: harness.roleSlot("interface"),
    // the harness logs raw prompt+completion under this role; keep it distinct
    // from "interface" so the curated reply stays the only conversation turn
    role: "interface_io",
    system: DISCUSS_SYSTEM,
    input: `Conversation so far:\n\n${rendered}\n\nReply to the latest USER message.`,
    maxTokens: 2048,
  });

  return parseJson(r.output, DiscussSchema);
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
