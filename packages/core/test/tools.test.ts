import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool, runCommand, safePath, workspaceFiles, type ToolContext } from "../src/agents/tools.js";

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

  it("workspaceFiles reports what actually landed on disk", () => {
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src/main.ts"), "y");
    writeFileSync(join(ws, "README.md"), "z");
    mkdirSync(join(ws, "node_modules"), { recursive: true });
    writeFileSync(join(ws, "node_modules/junk.js"), "no");

    expect(workspaceFiles(ws)).toEqual(["README.md", "src/main.ts"]);
  });
});
