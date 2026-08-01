import type { Store } from "../store/db.js";

/**
 * Formats recalled memories for prompt injection. Undefined when nothing
 * matches — agents treat undefined as "no memory yet".
 */
export function recallBlock(
  store: Store,
  query: string,
  limit = 5,
): string | undefined {
  const hits = store.searchMemories(query, limit);
  if (hits.length === 0) return undefined;
  return hits.map((h) => `- [${h.kind}] ${h.text}`).join("\n");
}
