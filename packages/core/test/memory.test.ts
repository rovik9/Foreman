import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recallBlock } from "../src/memory/recall.js";
import { mirrorMemory } from "../src/memory/mirror.js";
import { Store } from "../src/store/db.js";
import { existsSync, readFileSync } from "node:fs";

describe("memory store", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-mem-"));
    store = new Store(join(dir, "t.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds and full-text searches memories", () => {
    store.addMemory({ kind: "preference", text: "User likes dark themes", tags: ["ui"] });
    store.addMemory({ kind: "fact", text: "The fund contracts use Foundry", tags: ["defi"] });
    store.addMemory({ kind: "lesson", text: "Slither flags unguarded withdraw", tags: ["defi"] });

    const hits = store.searchMemories("dark theme for the landing page");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text).toContain("dark themes");

    const defi = store.searchMemories("reentrancy slither foundry");
    expect(defi.length).toBeGreaterThanOrEqual(1);
  });

  it("bumps access count on recall", () => {
    const id = store.addMemory({ kind: "fact", text: "Foundry shop" });
    store.searchMemories("foundry");
    const mem = store.listMemories().find((m) => m.id === id)!;
    expect(mem.access_count).toBe(1);
  });

  it("returns empty for junk queries", () => {
    store.addMemory({ kind: "fact", text: "something" });
    expect(store.searchMemories("zz zz zz")).toEqual([]);
    expect(store.searchMemories("")).toEqual([]);
  });

  it("recallBlock formats and returns undefined when empty", () => {
    expect(recallBlock(store, "nothing here")).toBeUndefined();
    store.addMemory({ kind: "preference", text: "dark ui" });
    const block = recallBlock(store, "dark ui");
    expect(block).toContain("- [preference] dark ui");
  });
});

describe("mirrorMemory", () => {
  it("writes an obsidian-ready markdown file", () => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-mirror-"));
    const file = mirrorMemory(dir, {
      id: "abcd1234-0000-0000-0000-000000000000",
      kind: "lesson",
      text: "Reentrancy guards are non-negotiable",
      tags: ["defi", "security"],
      confidence: 0.95,
    });
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf8");
    expect(content).toContain("kind: lesson");
    expect(content).toContain("Reentrancy guards");
    expect(file).toContain(join("memory", "lesson").slice(1) === "" ? "" : "lesson");
    rmSync(dir, { recursive: true, force: true });
  });
});
