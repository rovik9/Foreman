import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { withWorkspaceLock } from "../util/workspace-lock.js";

/**
 * The builder's hands. Every tool is jailed to one run's workspace directory
 * and every command is checked against the allowlist in
 * `config/limits.yaml` → `sandbox.shell_allowlist`. Nothing here ever goes
 * through a shell, so there is no interpolation to escape: args are passed
 * as an argv array to spawn().
 */

export interface McpTool {
  /** `<server>.<tool>` — namespaced so two servers can expose the same name. */
  name: string;
  description: string;
  call: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolContext {
  workspace: string;
  allowlist: string[];
  commandTimeoutMs: number;
  /** Tools from MCP servers the user connected in Settings. */
  mcpTools?: McpTool[];
  /** Which task is holding this context — used for write-conflict detection. */
  taskId?: string;
  /** Called when a task overwrites a file another live task wrote this level. */
  onWriteConflict?: (info: { path: string; otherTaskId: string }) => void;
}

/**
 * path -> taskId of the last writer, per workspace.
 *
 * The workspace lock serialises *commands*, but two parallel builders can still
 * write the same file — disjointness is only ever a promise made by the
 * architect's dependency graph, not something the sandbox can enforce. Rather
 * than let one silently clobber the other, we detect it and surface it.
 */
const fileOwners = new Map<string, Map<string, string>>();

function recordWrite(ctx: ToolContext, rel: string): void {
  if (!ctx.taskId) return;
  let owners = fileOwners.get(ctx.workspace);
  if (!owners) {
    owners = new Map();
    fileOwners.set(ctx.workspace, owners);
  }
  const prior = owners.get(rel);
  if (prior && prior !== ctx.taskId) {
    ctx.onWriteConflict?.({ path: rel, otherTaskId: prior });
  }
  owners.set(rel, ctx.taskId);
}

/** Drops a finished run's ownership table so the map doesn't grow forever. */
export function forgetWorkspace(workspace: string): void {
  fileOwners.delete(workspace);
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

/** Output beyond this is truncated — a 50MB test log would blow the context. */
const MAX_OUTPUT = 12_000;

function clip(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  const head = s.slice(0, MAX_OUTPUT * 0.7);
  const tail = s.slice(-MAX_OUTPUT * 0.25);
  return `${head}\n\n…[${s.length - head.length - tail.length} chars trimmed]…\n\n${tail}`;
}

/** Resolves a caller-supplied path inside the workspace, or throws. */
export function safePath(workspace: string, p: string): string {
  const base = resolve(workspace);
  const target = resolve(base, p);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`path "${p}" escapes the workspace`);
  }
  return target;
}

export function runCommand(
  ctx: ToolContext,
  command: string[],
  cwdRel = ".",
): Promise<ToolResult> {
  return withWorkspaceLock(ctx.workspace, () => runCommandUnlocked(ctx, command, cwdRel));
}

function runCommandUnlocked(
  ctx: ToolContext,
  command: string[],
  cwdRel = ".",
): Promise<ToolResult> {
  return new Promise((resolvePromise) => {
    const bin = command[0];
    if (!bin) return resolvePromise({ ok: false, output: "no command given" });
    if (!ctx.allowlist.includes(bin)) {
      return resolvePromise({
        ok: false,
        output: `"${bin}" is not allowed. Allowed: ${ctx.allowlist.join(", ")}. Ask the user to add it in Settings → Engine if you need it.`,
      });
    }

    let cwd: string;
    try {
      cwd = safePath(ctx.workspace, cwdRel);
      mkdirSync(cwd, { recursive: true });
    } catch (err) {
      return resolvePromise({ ok: false, output: String(err) });
    }

    const child = spawn(bin, command.slice(1), {
      cwd,
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise({ ok: false, output: clip(`${out}\n[timed out after ${ctx.commandTimeoutMs}ms]`) });
    }, ctx.commandTimeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ ok: code === 0, output: clip(`${out}\n[exit ${code}]`) });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, output: clip(`${out}\n${String(err)}`) });
    });
  });
}

function listFiles(ctx: ToolContext, rel = "."): ToolResult {
  const root = safePath(ctx.workspace, rel);
  const skip = new Set(["node_modules", ".git", "dist", "coverage", ".next"]);
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || found.length > 400) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, depth + 1);
      else found.push(relative(ctx.workspace, abs));
    }
  };
  walk(root, 0);
  return {
    ok: true,
    output: found.length ? clip(found.sort().join("\n")) : "(no files yet)",
  };
}

/** Dispatches one tool call. Never throws — failures come back as ok:false so
 *  the model can read the error and correct itself, exactly like a real shell. */
export async function executeTool(ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
  try {
    switch (call.tool) {
      case "run_command": {
        const cmd = call.args.command;
        const command = Array.isArray(cmd)
          ? cmd.map(String)
          : typeof cmd === "string"
            ? cmd.trim().split(/\s+/)
            : [];
        return await runCommand(ctx, command, String(call.args.cwd ?? "."));
      }
      case "read_file": {
        const abs = safePath(ctx.workspace, String(call.args.path ?? ""));
        return { ok: true, output: clip(readFileSync(abs, "utf8")) };
      }
      case "write_file": {
        const rel = String(call.args.path ?? "");
        const abs = safePath(ctx.workspace, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, String(call.args.content ?? ""), "utf8");
        recordWrite(ctx, relative(ctx.workspace, abs));
        return { ok: true, output: `wrote ${rel}` };
      }
      case "list_files":
        return listFiles(ctx, String(call.args.path ?? "."));
      default: {
        const mcp = ctx.mcpTools?.find((t) => t.name === call.tool);
        if (mcp) return await mcp.call(call.args);
        return { ok: false, output: `unknown tool "${call.tool}"` };
      }
    }
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * path -> mtimeMs, so a task can be credited with only the files it actually
 * touched. Without this every task re-registers the whole shared workspace and
 * artifacts pile up O(n²), attributed to the wrong task.
 */
export function workspaceSnapshot(workspace: string): Map<string, number> {
  const snap = new Map<string, number>();
  for (const rel of workspaceFiles(workspace)) {
    try {
      snap.set(rel, statSync(join(workspace, rel)).mtimeMs);
    } catch {
      // vanished between listing and stat — treat as absent
    }
  }
  return snap;
}

/** Files created or modified since the snapshot was taken. */
export function changedSince(workspace: string, before: Map<string, number>): string[] {
  return workspaceFiles(workspace).filter((rel) => {
    const prior = before.get(rel);
    if (prior === undefined) return true;
    try {
      return statSync(join(workspace, rel)).mtimeMs !== prior;
    } catch {
      return false;
    }
  });
}

/** Files the builder actually produced, for artifact registration. */
export function workspaceFiles(workspace: string): string[] {
  const skip = new Set(["node_modules", ".git", "dist", "coverage", ".next"]);
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || found.length > 400) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, depth + 1);
      else if (statSync(abs).isFile()) found.push(relative(workspace, abs));
    }
  };
  try {
    walk(workspace, 0);
  } catch {
    // workspace may not exist yet
  }
  return found.sort();
}

/** Appends the connected MCP servers' tools to the prompt, so a builder can
 *  actually call what the user wired up in Settings. */
export function toolGuideFor(ctx: ToolContext): string {
  if (!ctx.mcpTools?.length) return TOOL_GUIDE;
  const extra = ctx.mcpTools
    .map((t) => `{ "tool": "${t.name}", "args": { … } }   ${t.description}`)
    .join("\n");
  return `${TOOL_GUIDE}

Connected MCP tools (from the user's Settings) — call them the same way:
${extra}`;
}

export const TOOL_GUIDE = `You have real tools. Work like an engineer at a terminal:
look around, make a change, RUN it, read the output, fix what broke. Do not guess.

Respond with exactly one JSON object per turn, nothing else.

To use a tool:
{ "tool": "run_command", "args": { "command": ["npm", "test"], "cwd": "." } }
{ "tool": "read_file",  "args": { "path": "src/index.ts" } }
{ "tool": "write_file", "args": { "path": "src/index.ts", "content": "..." } }
{ "tool": "list_files", "args": { "path": "." } }

When the task is genuinely done — code written AND verified by running it:
{ "done": true, "notes": "what you did and what you verified" }

Rules:
- Prefer running the real command over assuming it works.
- If a command fails, read the error and fix it; that is the job.
- Only allowlisted binaries run; you'll be told if one is blocked.
- All paths are relative to the workspace root. You cannot escape it.`;
