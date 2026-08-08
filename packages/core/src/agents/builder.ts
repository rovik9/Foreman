import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import type { TaskRow } from "../store/db.js";
import type { AgentHarness } from "./harness.js";
import { parseJson } from "./json.js";
import type { PmSpec } from "./pm.js";
import { executeTool, workspaceFiles, TOOL_GUIDE, type ToolContext } from "./tools.js";

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

const AGENTIC_SYSTEM = `You are a Builder in an AI software company called Foreman.
You get one task, the project spec, and sometimes reviewer feedback from a failed
attempt. You are working in a real workspace on a real machine.

${TOOL_GUIDE}

Finish only when the work is done AND you have run something that proves it.`;

const StepSchema = z.union([
  z.object({
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({ done: z.literal(true), notes: z.string().default("") }),
]);

export interface AgenticDeps {
  onStep?: (step: { tool: string; args: Record<string, unknown>; ok: boolean; output: string }) => void;
  maxSteps?: number;
  commandTimeoutMs?: number;
  /** Checked between steps so a runaway loop still respects the budget cap. */
  shouldStop?: () => boolean;
}

/**
 * The builder as an actual agent: it looks around, edits, runs commands, reads
 * the output and iterates — instead of emitting files blind in one shot. This
 * is the difference between "wrote something plausible" and "ran it and it
 * works". Falls back to the single-shot builder if the model can't drive tools.
 */
export async function buildTaskAgentic(
  harness: AgentHarness,
  runId: string,
  task: TaskRow,
  spec: PmSpec,
  workspace: string,
  ctx: ToolContext,
  feedback?: string,
  steering: string[] = [],
  memoryBlock?: string,
  deps: AgenticDeps = {},
): Promise<BuildOutput> {
  const maxSteps = deps.maxSteps ?? 24;
  const opening = [
    `Task: ${task.description}`,
    `Acceptance criteria: ${task.acceptance_criteria}`,
    `Spec:\n${JSON.stringify(spec, null, 2)}`,
    memoryBlock ? `Shared project memory (read-only):\n${memoryBlock}` : "",
    steering.length ? `Live user steering (must respect):\n${steering.join("\n")}` : "",
    feedback ? `Reviewer feedback from a failed attempt (fix this):\n${feedback}` : "",
    "Start by looking at the workspace.",
  ].filter(Boolean).join("\n\n");

  const transcript: string[] = [opening];
  let notes = "";

  for (let step = 0; step < maxSteps; step++) {
    if (deps.shouldStop?.()) {
      notes ||= `stopped after ${step} step(s) — budget or stop signal`;
      break;
    }

    const r = await harness.run({
      runId,
      taskId: task.id,
      slot: task.slot ?? harness.roleSlot("builder"),
      role: "builder",
      system: AGENTIC_SYSTEM,
      input: transcript.join("\n\n---\n\n"),
      maxTokens: 8192,
    });

    let parsed;
    try {
      parsed = parseJson(r.output, StepSchema);
    } catch {
      // Some models answer with the whole file set instead of driving tools.
      // Honour that reply as-is rather than burning another call on a retry.
      try {
        const oneShot = parseJson(r.output, BuildOutputSchema);
        writeBuildOutput(workspace, oneShot);
        return oneShot;
      } catch {
        transcript.push(
          "Your last reply was not valid JSON in the required shape. Reply with exactly one JSON object.",
        );
        continue;
      }
    }

    if ("done" in parsed) {
      notes = parsed.notes;
      break;
    }

    const call = { tool: parsed.tool, args: parsed.args };
    const result = await executeTool(ctx, call);
    deps.onStep?.({ ...call, ok: result.ok, output: result.output });
    transcript.push(
      `You ran: ${JSON.stringify(call)}\nResult (${result.ok ? "ok" : "FAILED"}):\n${result.output}`,
    );
  }

  // whatever ended up on disk is the real output, regardless of what it claimed
  const files = workspaceFiles(workspace).map((path) => ({ path, content: "" }));
  return {
    files: files.length ? files : [{ path: ".foreman-empty", content: "" }],
    notes: notes || "reached the step limit without declaring completion",
  };
}
