import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncProductRepo } from "../src/journal/gitsync.js";

describe("syncProductRepo", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-git-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("inits a repo and commits locally without a remote", () => {
    writeFileSync(join(dir, "note.md"), "# hello");
    const res = syncProductRepo(dir, "first commit");
    expect(res).toEqual({ committed: true, pushed: false });
    expect(existsSync(join(dir, ".git"))).toBe(true);
    const log = execFileSync("git", ["log", "--oneline"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(log).toContain("first commit");
  });

  it("no-ops when there is nothing to commit", () => {
    mkdirSync(dir, { recursive: true });
    const res = syncProductRepo(dir, "nothing");
    expect(res.committed).toBe(false);
    expect(res.error).toBeUndefined();
  });

  it("pushes when a local remote is set", () => {
    // local bare repo acts as the "remote" — no network needed
    const remoteDir = mkdtempSync(join(tmpdir(), "foreman-remote-"));
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    writeFileSync(join(dir, "a.md"), "x");
    const res = syncProductRepo(dir, "push me", remoteDir);
    expect(res.committed).toBe(true);
    expect(res.pushed).toBe(true);
    rmSync(remoteDir, { recursive: true, force: true });
  });

  it("keeps the local commit when push fails", () => {
    writeFileSync(join(dir, "b.md"), "y");
    const res = syncProductRepo(dir, "commit", "/nonexistent/remote.git");
    expect(res.committed).toBe(true);
    expect(res.pushed).toBe(false);
    expect(res.error).toMatch(/push failed/);
  });
});
