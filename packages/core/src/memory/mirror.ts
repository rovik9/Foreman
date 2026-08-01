import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MirrorEntry {
  id: string;
  kind: string;
  text: string;
  tags: string[];
  confidence: number;
}

/**
 * Human window onto the memory store: one markdown file per memory under
 * memory/<kind>/. Point Obsidian at the memory/ folder as a vault to
 * browse, search, and hand-edit Foreman's long-term memory. SQLite + FTS5
 * stays the machine store of record.
 */
export function mirrorMemory(dir: string, e: MirrorEntry): string {
  const kindDir = join(dir, e.kind);
  mkdirSync(kindDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const file = join(kindDir, `${stamp}_${e.id.slice(0, 8)}.md`);
  writeFileSync(
    file,
    `---\nkind: ${e.kind}\ntags: [${e.tags.join(", ")}]\nconfidence: ${e.confidence}\n---\n\n${e.text}\n`,
  );
  return file;
}
