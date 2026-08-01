import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRepoAccess, listDirectories } from "../src/server/fs.js";

describe("listDirectories", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-fs-"));
    mkdirSync(join(dir, "alpha"));
    mkdirSync(join(dir, "beta"));
    mkdirSync(join(dir, ".hidden"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists only visible subdirectories, sorted", () => {
    const listing = listDirectories(dir);
    expect(listing.path).toBe(dir);
    expect(listing.entries.map((e) => e.name)).toEqual(["alpha", "beta"]);
    expect(listing.entries[0]!.path).toBe(join(dir, "alpha"));
  });

  it("reports the parent directory for navigating up", () => {
    const listing = listDirectories(join(dir, "alpha"));
    expect(listing.parent).toBe(dir);
  });

  it("defaults to the home directory when no path is given", () => {
    const listing = listDirectories();
    expect(listing.path.length).toBeGreaterThan(0);
  });

  it("throws on a missing directory", () => {
    expect(() => listDirectories(join(dir, "nope"))).toThrow();
  });
});

describe("checkRepoAccess", () => {
  it("reports failure for an unreachable url without hanging", async () => {
    const result = await checkRepoAccess("https://example.invalid/not-a-repo.git");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  }, 15_000);
});
