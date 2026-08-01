import { z } from "zod";
import { TaskClassSchema } from "../config/schema.js";
import { topoOrder } from "../pipeline/dag.js";
import type { AgentHarness } from "./harness.js";
import { parseJson } from "./json.js";
import type { PmSpec } from "./pm.js";

export const AcceptanceCriterionSchema = z.union([
  z.object({ type: z.literal("command"), run: z.string().min(1) }),
  z.object({ type: z.literal("rubric"), check: z.string().min(1) }),
]);
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const TaskDraftSchema = z.object({
  id: z.string().min(1),
  class: TaskClassSchema,
  description: z.string().min(1),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  deps: z.array(z.string()).default([]),
});
export type TaskDraft = z.infer<typeof TaskDraftSchema>;

const TaskListSchema = z.object({ tasks: z.array(TaskDraftSchema).min(1) });

const ARCHITECT_SYSTEM = `You are the Architect of an AI software company called Foreman.
Given an engineering spec, decompose it into the smallest useful task DAG.

Respond with JSON only, exactly this shape:
{
  "tasks": [
    {
      "id": "t1",
      "class": "build" | "plan" | "critique" | "fetch",
      "description": "what to do, precisely",
      "acceptanceCriteria": [
        { "type": "command", "run": "exact shell command that must exit 0" },
        { "type": "rubric", "check": "what a reviewer should verify" }
      ],
      "deps": ["ids of tasks that must finish first"]
    }
  ]
}

Rules:
- Prefer few, well-scoped tasks (2-6 for a small project).
- Every task must carry at least one acceptance criterion.
- Use "command" criteria whenever a shell command can prove the result.
- No dependency cycles. deps reference task ids in this same list.`;

export async function planTasks(
  harness: AgentHarness,
  runId: string,
  spec: PmSpec,
  extraContext?: string,
): Promise<TaskDraft[]> {
  const input = [
    `Spec:\n${JSON.stringify(spec, null, 2)}`,
    extraContext ? `Realtime context (current as of now):\n${extraContext}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const r = await harness.run({
    runId,
    slot: "architect",
    role: "architect",
    system: ARCHITECT_SYSTEM,
    input,
    maxTokens: 4096,
  });
  const { tasks } = parseJson(r.output, TaskListSchema);
  topoOrder(tasks); // validates refs + acyclicity, throws on bad DAG
  return tasks;
}
