import { z } from "zod";
import type { AgentHarness } from "./harness.js";
import { parseJson } from "./json.js";

const BriefingSchema = z.object({
  briefing: z.string().min(1),
  watchouts: z.array(z.string()).default([]),
});

const CONTEXT_SYSTEM = `You are the Context AI of Foreman — the long-context specialist.
You receive raw recalled memory (and it can be long). Compress it into a
tight project briefing for the architect planning the NEXT piece of work.

Respond with JSON only:
{
  "briefing": "the essential context, dense and factual, <= 200 words",
  "watchouts": ["past failures/decisions the architect must not repeat"]
}

Rules:
- Decisions and lessons outrank preferences and trivia.
- Never invent context that is not in the input.
- If the memory is thin, say so briefly instead of padding.`;

/**
 * Long-context synthesis: big raw memory dumps get distilled by the context
 * role (Gemini Pro intent) before they reach the architect — the architect
 * sees signal, not haystack.
 */
export async function synthesizeContext(
  harness: AgentHarness,
  runId: string,
  topic: string,
  rawMemory: string,
): Promise<string> {
  const r = await harness.run({
    runId,
    slot: harness.roleSlot("context"),
    role: "context",
    system: CONTEXT_SYSTEM,
    input: `Topic of the upcoming work: ${topic}\n\nRaw recalled memory:\n${rawMemory}`,
    maxTokens: 2048,
  });
  const out = parseJson(r.output, BriefingSchema);
  return [
    `Project context briefing:\n${out.briefing}`,
    out.watchouts.length > 0 ? `Watchouts:\n${out.watchouts.map((w) => `- ${w}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Raw memory beyond this size goes through the context AI first. */
export const CONTEXT_SYNTH_THRESHOLD = 1200;
