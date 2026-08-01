import { z } from "zod";
import type { AgentHarness } from "../agents/harness.js";
import { parseJson } from "../agents/json.js";
import type { Store } from "../store/db.js";
import { mirrorMemory } from "./mirror.js";

const MemoryEntrySchema = z.object({
  kind: z.enum(["preference", "fact", "decision", "lesson", "convention"]),
  text: z.string().min(1),
  tags: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.8),
});
const DistillSchema = z.object({
  memories: z.array(MemoryEntrySchema).default([]),
});

const DISTILLER_SYSTEM = `You are the memory keeper of an AI software company called Foreman.
Read one run's transcript and extract ONLY durable, reusable knowledge:
- preference: how the user likes things done
- fact: stable facts about the user or their projects
- decision: decisions made, with the reason why
- lesson: what failed and what fixed it
- convention: project conventions to respect next time

Rules:
- Skip task-specific trivia and anything obvious.
- Each entry must be self-contained, one sentence.
- At most 8 entries. If nothing is durable, return an empty list.

Respond with JSON only:
{ "memories": [ { "kind": "...", "text": "...", "tags": ["..."], "confidence": 0.0 } ] }`;

/**
 * Post-run distillation. Runs on the cheapest slot (memorizer = Kimi K3).
 * Never breaks the pipeline — caller wraps in try/catch.
 * Returns the number of memories stored.
 */
export async function distillRun(
  harness: AgentHarness,
  store: Store,
  runId: string,
  memoryDir?: string,
): Promise<number> {
  const messages = store.listMessages(runId) as {
    role: string;
    content: string;
  }[];
  const transcript = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")
    .slice(-12_000);
  if (transcript.length < 200) return 0;

  const r = await harness.run({
    runId,
    slot: harness.roleSlot("memorizer"),
    role: "system",
    system: DISTILLER_SYSTEM,
    input: `Transcript:\n${transcript}`,
    maxTokens: 2048,
  });
  const { memories } = parseJson(r.output, DistillSchema);

  for (const m of memories) {
    const id = store.addMemory({
      kind: m.kind,
      text: m.text,
      tags: m.tags,
      confidence: m.confidence,
      sourceRunId: runId,
      status: "pending", // writes need Interface AI approval (memory governance)
      proposedBy: "memorizer",
    });
    if (memoryDir) {
      mirrorMemory(memoryDir, { id, ...m });
    }
  }
  return memories.length;
}
