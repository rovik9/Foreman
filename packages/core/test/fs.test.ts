import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRepoAccess, cloneRepo, listDirectories } from "../src/server/fs.js";

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

  it("succeeds against a real, reachable local repo (no network needed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-checkrepo-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main", dir]);
      writeFileSync(join(dir, "a.txt"), "x");
      execFileSync("git", ["add", "a.txt"], { cwd: dir });
      execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "x"], { cwd: dir });
      const result = await checkRepoAccess(dir);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cloneRepo", () => {
  let sourceDir: string;
  let destRoot: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "foreman-clonesrc-"));
    destRoot = mkdtempSync(join(tmpdir(), "foreman-clonedest-"));
    execFileSync("git", ["init", "-q", "-b", "main", sourceDir]);
    writeFileSync(join(sourceDir, "hello.txt"), "hello from source");
    execFileSync("git", ["add", "hello.txt"], { cwd: sourceDir });
    execFileSync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init"],
      { cwd: sourceDir },
    );
  });

  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(destRoot, { recursive: true, force: true });
  });

  it("actually clones a real repo end to end", async () => {
    const dest = join(destRoot, "nested", "checkout");
    const result = await cloneRepo(sourceDir, dest);
    expect(result).toEqual({ ok: true, path: dest });
    expect(existsSync(join(dest, "hello.txt"))).toBe(true);
    expect(readFileSync(join(dest, "hello.txt"), "utf8")).toBe("hello from source");
  });

  it("fails cleanly for an unreachable source", async () => {
    const result = await cloneRepo("/nowhere/does-not-exist", join(destRoot, "x"));
    expect(result.ok).toBe(false);
  });
});
