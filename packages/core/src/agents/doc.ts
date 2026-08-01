import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskRow } from "../store/db.js";
import type { AgentHarness } from "./harness.js";
import type { PmSpec } from "./pm.js";

const DOC_SYSTEM = `You are a specialist in an AI software company called Foreman.
Your deliverable is a DOCUMENT (not code files): a design contract, research
findings, or a review report, written in tight markdown.

Rules:
- Answer the task directly; be concrete and complete.
- Respect the spec and any reviewer feedback.
- Output the document only, no preamble.`;

/**
 * Executor for non-build task classes (plan / fetch / critique): produces a
 * markdown deliverable into workspace/docs/. Builders have their own
 * files-JSON contract; documents must not be forced through it.
 */
export async function docTask(
  harness: AgentHarness,
  runId: string,
  task: TaskRow,
  spec: PmSpec,
  workspace: string,
  feedback?: string,
  steering: string[] = [],
  memoryBlock?: string,
): Promise<string> {
  const parts = [
    `Task: ${task.description}`,
    `Acceptance criteria: ${task.acceptance_criteria}`,
    `Spec:\n${JSON.stringify(spec, null, 2)}`,
  ];
  if (memoryBlock) {
    parts.push(`Shared project memory (read-only):\n${memoryBlock}`);
  }
  if (steering.length > 0) {
    parts.push(`Live user steering (must respect):\n${steering.join("\n")}`);
  }
  if (feedback) {
    parts.push(`Reviewer feedback from failed attempt (fix this):\n${feedback}`);
  }

  const r = await harness.run({
    runId,
    taskId: task.id,
    slot: task.slot ?? harness.roleSlot("architect"),
    role: task.class,
    system: DOC_SYSTEM,
    input: parts.join("\n\n"),
    maxTokens: 8192,
  });

  const dir = join(workspace, "docs");
  mkdirSync(dir, { recursive: true });
  const rel = `docs/task-${task.seq}.md`;
  writeFileSync(join(dir, `task-${task.seq}.md`), r.output);
  return rel;
}
