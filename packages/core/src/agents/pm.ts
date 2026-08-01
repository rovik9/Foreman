import { z } from "zod";
import type { AgentHarness } from "./harness.js";
import { parseJson } from "./json.js";

export const PmSpecSchema = z.object({
  summary: z.string().min(1),
  product: z.string().default("misc"), // kebab-case product name — owns a memory repo
  requirements: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  questions: z.array(z.string()).default([]),
});
export type PmSpec = z.infer<typeof PmSpecSchema>;

const PM_SYSTEM = `You are the PM (project manager) of an AI software company called Foreman.
The user gives you a rough goal. Rewrite it as a precise engineering spec.

Respond with JSON only, no prose, exactly this shape:
{
  "summary": "one-sentence goal",
  "product": "short-kebab-case-name of the product this work belongs to (reuse the same name across runs on the same product)",
  "requirements": ["concrete, testable requirement", ...],
  "constraints": ["explicit limits or non-goals"],
  "confidence": 0.0-1.0,
  "questions": ["only if confidence < 0.7: the blocking questions for the user"]
}

Rules:
- Requirements must be verifiable by tests, commands, or inspection.
- Do not invent scope the user did not ask for.
- If the request is clear, confidence >= 0.8 and questions = [].`;

export async function refinePrompt(
  harness: AgentHarness,
  runId: string,
  rawPrompt: string,
  priorAnswers: string[] = [],
  memoryBlock?: string,
): Promise<PmSpec> {
  const input = [
    `User request:\n${rawPrompt}`,
    memoryBlock
      ? `Durable memory about the user and their projects (use it):\n${memoryBlock}`
      : "",
    priorAnswers.length > 0
      ? `User answers to your earlier questions:\n${priorAnswers.join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const r = await harness.run({
    runId,
    slot: "pm",
    role: "pm",
    system: PM_SYSTEM,
    input,
  });
  return parseJson(r.output, PmSpecSchema);
}
