import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import type { TaskRow } from "../store/db.js";
import type { AgentHarness } from "./harness.js";
import { parseJson } from "./json.js";
import type { PmSpec } from "./pm.js";

export const BuildOutputSchema = z.object({
  files: z
    .array(z.object({ path: z.string().min(1), content: z.string() }))
    .min(1),
  notes: z.string().default(""),
});
export type BuildOutput = z.infer<typeof BuildOutputSchema>;

const BUILDER_SYSTEM = `You are a Builder in an AI software company called Foreman.
You receive one task, the project spec, and optionally reviewer feedback from a
previous failed attempt. Produce the complete file set for your task.

Respond with JSON only, exactly this shape:
{
  "files": [{ "path": "relative/path/from/workspace", "content": "full file content" }],
  "notes": "anything the reviewer should know"
}

Rules:
- Paths are relative to the workspace root. Never use ".." or absolute paths.
- Write complete files, not diffs or fragments.
- Address every acceptance criterion for the task.
- If feedback is provided, fix exactly what it names.`;

/** Writes builder output into the sandbox, refusing path escapes. */
export function writeBuildOutput(workspace: string, out: BuildOutput): string[] {
  const root = resolve(workspace);
  const written: string[] = [];
  for (const f of out.files) {
    const target = resolve(join(root, f.path));
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`builder attempted path escape: ${f.path}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
    written.push(target);
  }
  return written;
}

export async function buildTask(
  harness: AgentHarness,
  runId: string,
  task: TaskRow,
  spec: PmSpec,
  workspace: string,
  feedback?: string,
  steering: string[] = [],
  memoryBlock?: string,
): Promise<BuildOutput> {
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
    slot: task.slot ?? harness.roleSlot("builder"),
    role: "builder",
    system: BUILDER_SYSTEM,
    input: parts.join("\n\n"),
    maxTokens: 8192,
  });
  const out = parseJson(r.output, BuildOutputSchema);
  writeBuildOutput(workspace, out);
  return out;
}
