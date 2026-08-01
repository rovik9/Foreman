import { z } from "zod";
import type { AgentHarness } from "./harness.js";
import { parseJson } from "./json.js";

export const NewsDigestSchema = z.object({
  digest: z.string().min(1),
  sources: z.array(z.string()).default([]),
});
export type NewsDigest = z.infer<typeof NewsDigestSchema>;

const REALTIME_SYSTEM = `You are the realtime researcher at an AI software company called Foreman.
You have the fastest, most current information feed on the team.

Given a topic, summarize what is happening RIGHT NOW that an architect
should know before planning. Respond with JSON only:
{ "digest": "dense, factual, current summary", "sources": ["outlet or feed name", ...] }`;

const TTL_MS = 15 * 60 * 1000; // news goes stale; reuse within 15 min

/**
 * Groq-backed realtime feed with a TTL cache — repeated asks for the same
 * topic within the TTL cost zero additional tokens.
 */
export class RealtimeFeed {
  private readonly cache = new Map<string, { at: number; digest: NewsDigest }>();

  constructor(
    private readonly harness: AgentHarness,
    private readonly ttlMs: number = TTL_MS,
  ) {}

  async digest(runId: string, topic: string): Promise<NewsDigest> {
    const key = topic.trim().toLowerCase();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.digest;

    const r = await this.harness.run({
      runId,
      slot: this.harness.roleSlot("trend"),
      role: "system",
      system: REALTIME_SYSTEM,
      input: `Topic: ${topic}`,
      maxTokens: 2048,
    });
    const digest = parseJson(r.output, NewsDigestSchema);
    this.cache.set(key, { at: Date.now(), digest });
    return digest;
  }

  cacheSize(): number {
    return this.cache.size;
  }
}

/** Process-wide singleton — the cache only pays off across runs. */
let singleton: RealtimeFeed | undefined;
export function getRealtimeFeed(harness: AgentHarness): RealtimeFeed {
  singleton ??= new RealtimeFeed(harness);
  return singleton;
}
