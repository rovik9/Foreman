import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  changedSince, executeTool, forgetWorkspace, runCommand, safePath, workspaceFiles, workspaceSnapshot,
  type ToolContext,
} from "../src/agents/tools.js";
import { pendingWorkspaceLocks } from "../src/util/workspace-lock.js";

describe("builder sandbox", () => {
  let ws: string;
  let ctx: ToolContext;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "foreman-tools-"));
    ctx = { workspace: ws, allowlist: ["node", "echo"], commandTimeoutMs: 15_000 };
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  // ---- containment ----

  it("refuses to escape the workspace with ..", () => {
    expect(() => safePath(ws, "../../etc/passwd")).toThrow(/escapes the workspace/);
  });

  it("refuses absolute paths outside the workspace", () => {
    expect(() => safePath(ws, "/etc/passwd")).toThrow(/escapes the workspace/);
  });

  it("allows nested paths inside the workspace", () => {
    expect(safePath(ws, "src/deep/file.ts")).toBe(join(ws, "src/deep/file.ts"));
  });

  it("write_file cannot escape, and reports the error instead of throwing", async () => {
    const r = await executeTool(ctx, {
      tool: "write_file",
      args: { path: "../escaped.txt", content: "nope" },
    });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/escapes the workspace/);
    expect(existsSync(join(ws, "..", "escaped.txt"))).toBe(false);
  });

  // ---- allowlist ----

  it("blocks a binary that is not allowlisted, naming what is allowed", async () => {
    const r = await runCommand({ ...ctx, allowlist: ["node"] }, ["rm", "-rf", "."]);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/not allowed/);
    expect(r.output).toMatch(/node/);
  });

  it("does not go through a shell, so metacharacters are inert", async () => {
    // if this were `sh -c`, the `;` would run a second command
    const r = await runCommand(ctx, ["node", "-e", "console.log('a; echo pwned')"]);
    expect(r.output).toContain("a; echo pwned");
    expect(r.output).not.toContain("pwned\n[exit");
  });

  // ---- real execution ----

  it("runs a real command and captures stdout plus exit code", async () => {
    const r = await runCommand(ctx, ["node", "-e", "console.log('hello from the sandbox')"]);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("hello from the sandbox");
    expect(r.output).toContain("[exit 0]");
  });

  it("reports a failing command as not ok, with its stderr", async () => {
    const r = await runCommand(ctx, ["node", "-e", "console.error('boom'); process.exit(3)"]);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("boom");
    expect(r.output).toContain("[exit 3]");
  });

  it("kills a command that exceeds the timeout", async () => {
    const r = await runCommand(
      { ...ctx, commandTimeoutMs: 400 },
      ["node", "-e", "setTimeout(() => {}, 60000)"],
    );
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/timed out/);
  }, 15_000);

  it("truncates enormous output instead of blowing the context", async () => {
    const r = await runCommand(ctx, [
      "node",
      "-e",
      "console.log('x'.repeat(400000))",
    ]);
    expect(r.output.length).toBeLessThan(20_000);
    expect(r.output).toMatch(/chars trimmed/);
  }, 20_000);

  // ---- concurrency (parallel builders share one workspace) ----

  it("serialises commands per workspace so parallel builders can't interleave", async () => {
    const script = (tag: string) =>
      `const fs=require('fs');fs.appendFileSync('log.txt','${tag}-start\\n');` +
      `setTimeout(()=>fs.appendFileSync('log.txt','${tag}-end\\n'),120)`;

    await Promise.all([
      runCommand(ctx, ["node", "-e", script("A")]),
      runCommand(ctx, ["node", "-e", script("B")]),
    ]);

    const log = readFileSync(join(ws, "log.txt"), "utf8").trim().split("\n");
    // each command must fully finish before the next starts
    expect(log).toHaveLength(4);
    expect(log[0]!.endsWith("-start")).toBe(true);
    expect(log[1]).toBe(log[0]!.replace("-start", "-end"));
    expect(log[2]!.endsWith("-start")).toBe(true);
    expect(log[3]).toBe(log[2]!.replace("-start", "-end"));
  }, 20_000);

  // ---- file tools ----

  it("write_file then read_file round-trips", async () => {
    const w = await executeTool(ctx, {
      tool: "write_file",
      args: { path: "src/a.ts", content: "export const a = 1;" },
    });
    expect(w.ok).toBe(true);
    const r = await executeTool(ctx, { tool: "read_file", args: { path: "src/a.ts" } });
    expect(r.output).toBe("export const a = 1;");
  });

  it("list_files skips node_modules and .git", async () => {
    mkdirSync(join(ws, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(ws, "node_modules/pkg/index.js"), "x");
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src/main.ts"), "y");

    const r = await executeTool(ctx, { tool: "list_files", args: {} });
    expect(r.output).toContain("src/main.ts");
    expect(r.output).not.toContain("node_modules");
  });

  it("reports unknown tools rather than crashing the run", async () => {
    const r = await executeTool(ctx, { tool: "sudo_make_me_a_sandwich", args: {} });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/unknown tool/);
  });

  it("credits a task only with the files it changed, not the whole workspace", async () => {
    // a previous task's output already sitting in the shared workspace
    writeFileSync(join(ws, "from-task-1.ts"), "earlier");
    const before = workspaceSnapshot(ws);

    await executeTool(ctx, { tool: "write_file", args: { path: "from-task-2.ts", content: "new" } });

    const changed = changedSince(ws, before);
    expect(changed).toEqual(["from-task-2.ts"]);
    expect(changed).not.toContain("from-task-1.ts");
  });

  it("counts a rewritten file as changed", async () => {
    writeFileSync(join(ws, "edit-me.ts"), "v1");
    const before = workspaceSnapshot(ws);
    await new Promise((r) => setTimeout(r, 12)); // mtime resolution
    await executeTool(ctx, { tool: "write_file", args: { path: "edit-me.ts", content: "v2" } });

    expect(changedSince(ws, before)).toContain("edit-me.ts");
  });

  it("does not leak a lock entry per command", async () => {
    const start = pendingWorkspaceLocks();
    await runCommand(ctx, ["node", "-e", "0"]);
    await runCommand(ctx, ["node", "-e", "0"]);
    await new Promise((r) => setTimeout(r, 20)); // let the cleanup microtask settle
    expect(pendingWorkspaceLocks()).toBe(start);
  }, 20_000);

  it("keeps serialising after a command fails", async () => {
    // a rejected/failed command must not wedge the queue for the next one
    await runCommand(ctx, ["node", "-e", "process.exit(1)"]);
    const after = await runCommand(ctx, ["node", "-e", "console.log('still works')"]);
    expect(after.ok).toBe(true);
    expect(after.output).toContain("still works");
  }, 20_000);

  it("workspaceFiles reports what actually landed on disk", () => {
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src/main.ts"), "y");
    writeFileSync(join(ws, "README.md"), "z");
    mkdirSync(join(ws, "node_modules"), { recursive: true });
    writeFileSync(join(ws, "node_modules/junk.js"), "no");

    expect(workspaceFiles(ws)).toEqual(["README.md", "src/main.ts"]);
  });
});

describe("parallel write conflicts", () => {
  let ws: string;
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "foreman-conflict-")); });
  afterEach(() => { forgetWorkspace(ws); rmSync(ws, { recursive: true, force: true }); });

  const ctxFor = (taskId: string, onWriteConflict: (i: { path: string; otherTaskId: string }) => void) => ({
    workspace: ws, allowlist: ["node"], commandTimeoutMs: 5000, taskId, onWriteConflict,
  });

  it("flags two parallel tasks writing the same file", async () => {
    const hits: { path: string; otherTaskId: string }[] = [];
    const push = (i: { path: string; otherTaskId: string }) => hits.push(i);

    await executeTool(ctxFor("task-a", push), {
      tool: "write_file", args: { path: "shared.ts", content: "from a" },
    });
    await executeTool(ctxFor("task-b", push), {
      tool: "write_file", args: { path: "shared.ts", content: "from b" },
    });

    expect(hits).toEqual([{ path: "shared.ts", otherTaskId: "task-a" }]);
    // last write still wins — we surface it, we don't silently drop work
    expect(readFileSync(join(ws, "shared.ts"), "utf8")).toBe("from b");
  });

  it("does not flag a task rewriting its own file", async () => {
    const hits: unknown[] = [];
    const push = () => hits.push(1);
    const ctx = ctxFor("task-a", push);
    await executeTool(ctx, { tool: "write_file", args: { path: "mine.ts", content: "v1" } });
    await executeTool(ctx, { tool: "write_file", args: { path: "mine.ts", content: "v2" } });
    expect(hits).toHaveLength(0);
  });

  it("does not flag different files", async () => {
    const hits: unknown[] = [];
    const push = () => hits.push(1);
    await executeTool(ctxFor("a", push), { tool: "write_file", args: { path: "a.ts", content: "x" } });
    await executeTool(ctxFor("b", push), { tool: "write_file", args: { path: "b.ts", content: "y" } });
    expect(hits).toHaveLength(0);
  });
});
