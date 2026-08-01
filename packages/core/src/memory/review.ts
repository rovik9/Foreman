import { z } from "zod";
import type { AgentHarness } from "../agents/harness.js";
import { parseJson } from "../agents/json.js";
import type { Store } from "../store/db.js";

const ReviewSchema = z.object({
  decisions: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      decision: z.enum(["approve", "reject", "critical"]),
      reason: z.string().default(""),
    }),
  ),
});

const REVIEW_SYSTEM = `You are the Interface AI of Foreman and the gatekeeper of project memory.
Every AI may READ memory freely, but WRITES go through you. Review proposed entries:
- approve: durable, correct, non-duplicate knowledge worth keeping
- reject: trivia, task-specific noise, or duplicates
- critical: anything that overwrites/contradicts existing knowledge, changes
  project direction, or touches security/credentials — these go to the USER

Respond with JSON only:
{ "decisions": [ { "index": 0, "decision": "approve|reject|critical", "reason": "..." } ] }`;

export interface ReviewCounts {
  approved: number;
  rejected: number;
  critical: number;
}

/**
 * Memory governance: the Interface AI reviews entries the memorizer
 * proposed. Critical ones park in awaiting_user for the human.
 */
export async function reviewMemories(
  harness: AgentHarness,
  store: Store,
  runId: string,
): Promise<ReviewCounts> {
  const counts: ReviewCounts = { approved: 0, rejected: 0, critical: 0 };
  const pending = store.listPendingMemories();
  if (pending.length === 0) return counts;

  const list = pending.map((m, i) => `${i}. [${m.kind}] ${m.text}`).join("\n");
  const r = await harness.run({
    runId,
    slot: harness.roleSlot("interface"),
    role: "interface",
    system: REVIEW_SYSTEM,
    input: `Proposed memory entries:\n${list}`,
    maxTokens: 1024,
  });
  const { decisions } = parseJson(r.output, ReviewSchema);

  for (const d of decisions) {
    const m = pending[d.index];
    if (!m) continue;
    if (d.decision === "approve") {
      store.setMemoryStatus(m.id, "approved");
      counts.approved++;
    } else if (d.decision === "reject") {
      store.setMemoryStatus(m.id, "rejected");
      counts.rejected++;
    } else {
      store.setMemoryStatus(m.id, "awaiting_user");
      counts.critical++;
    }
  }

  store.addMessage({
    runId,
    role: "interface",
    content: `Memory review: ${counts.approved} approved, ${counts.rejected} rejected, ${counts.critical} awaiting your approval`,
  });
  return counts;
}
