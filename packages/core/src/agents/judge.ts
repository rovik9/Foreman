import { z } from "zod";
import type { TaskRow } from "../store/db.js";
import type { AgentHarness } from "./harness.js";
import { parseJson } from "./json.js";

export const JudgeVerdictSchema = z.object({
  score: z.number().min(0).max(1),
  pass: z.boolean(),
  feedback: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

const JUDGE_SYSTEM = `You are the QA Judge in an AI software company called Foreman.
You review one task's output against its acceptance criteria, plus the results
of any automated gates that already ran.

Respond with JSON only, exactly this shape:
{
  "score": 0.0-1.0,
  "pass": true|false,
  "feedback": "if fail: precisely what is wrong and what to change; if pass: one line"
}

Rules:
- Be strict but fair: pass only when every acceptance criterion is satisfied.
- If automated gates failed, you fail too — name the gate output that matters.
- Feedback must be actionable by a builder on the next attempt.`;

export async function judgeTask(
  harness: AgentHarness,
  runId: string,
  task: TaskRow,
  gateSummary: string,
  fileListing: string[],
): Promise<JudgeVerdict> {
  const r = await harness.run({
    runId,
    taskId: task.id,
    slot: harness.roleSlot("judge"),
    role: "judge",
    system: JUDGE_SYSTEM,
    input: [
      `Task: ${task.description}`,
      `Acceptance criteria: ${task.acceptance_criteria}`,
      `Automated gates:\n${gateSummary}`,
      `Files produced:\n${fileListing.join("\n")}`,
    ].join("\n\n"),
  });
  return parseJson(r.output, JudgeVerdictSchema);
}
