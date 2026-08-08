import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { syncProductRepo } from "../journal/gitsync.js";
import type { ProjectRow, RunRow } from "../store/db.js";

/**
 * Delivers a completed run's code into the project's real checkout.
 *
 * Without this, everything a run builds is stranded in `runs/<id>/workspace`
 * forever: `accept` only ever synced the *memory* repo, so the actual work
 * never reached the repo the user cloned when they created the project.
 */

export interface DeliverResult {
  delivered: boolean;
  target?: string;
  files: number;
  committed: boolean;
  pushed: boolean;
  error?: string;
}

/** Build outputs only — never ship a dependency tree or someone's .git dir. */
const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".next", ".turbo"]);

export function collectFiles(root: string, dir = root, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(root, abs, out);
    else if (statSync(abs).isFile()) out.push(relative(root, abs));
  }
  return out;
}

export interface FileDiff {
  path: string;
  status: "added" | "modified" | "unchanged";
  added: number;
  removed: number;
  hunk: string;
}

/** Minimal line diff — enough to review a change, no dependency needed. */
function lineDiff(before: string, after: string): { added: number; removed: number; hunk: string } {
  const a = before.length ? before.split("\n") : [];
  const b = after.split("\n");

  // longest common subsequence over lines, then walk it back into +/- lines
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { out.push(`- ${a[i]}`); removed++; i++; }
    else { out.push(`+ ${b[j]}`); added++; j++; }
  }
  for (; i < a.length; i++) { out.push(`- ${a[i]}`); removed++; }
  for (; j < b.length; j++) { out.push(`+ ${b[j]}`); added++; }

  return { added, removed, hunk: out.slice(0, 400).join("\n") };
}

/**
 * What this run would change in the project checkout, before accepting it.
 * Lets the user review real diffs instead of a bare list of filenames.
 */
export function diffRunAgainstCheckout(run: RunRow, project: ProjectRow | undefined): FileDiff[] {
  const workspace = run.workspace_dir;
  if (!workspace || !existsSync(workspace)) return [];
  const target = project ? (JSON.parse(project.workspace_dirs) as string[])[0] : undefined;

  return collectFiles(workspace).map((path) => {
    const after = readFileSync(join(workspace, path), "utf8");
    const targetFile = target ? join(target, path) : undefined;
    const before = targetFile && existsSync(targetFile) ? readFileSync(targetFile, "utf8") : null;

    if (before === null) {
      const lines = after.split("\n");
      return {
        path,
        status: "added" as const,
        added: lines.length,
        removed: 0,
        hunk: lines.slice(0, 400).map((l) => `+ ${l}`).join("\n"),
      };
    }
    if (before === after) {
      return { path, status: "unchanged" as const, added: 0, removed: 0, hunk: "" };
    }
    return { path, status: "modified" as const, ...lineDiff(before, after) };
  });
}

/**
 * Copies the run workspace over the project checkout and commits it. The
 * checkout is a real git repo (cloned at project creation), so the user gets
 * a normal diff to review rather than a pile of files in a temp directory.
 */
export function deliverRunCode(
  run: RunRow,
  project: ProjectRow | undefined,
  opts: { remote?: string } = {},
): DeliverResult {
  const workspace = run.workspace_dir;
  if (!workspace || !existsSync(workspace)) {
    return { delivered: false, files: 0, committed: false, pushed: false, error: "run has no workspace" };
  }

  const targets = project ? (JSON.parse(project.workspace_dirs) as string[]) : [];
  const target = targets[0];
  if (!target) {
    return {
      delivered: false,
      files: 0,
      committed: false,
      pushed: false,
      error: "project has no local folder to deliver into — add one in the project settings",
    };
  }

  const files = collectFiles(workspace);
  if (files.length === 0) {
    return { delivered: false, target, files: 0, committed: false, pushed: false, error: "nothing to deliver" };
  }

  try {
    mkdirSync(target, { recursive: true });
    for (const rel of files) {
      const dest = join(target, rel);
      mkdirSync(join(dest, ".."), { recursive: true });
      cpSync(join(workspace, rel), dest);
    }
  } catch (err) {
    return {
      delivered: false, target, files: 0, committed: false, pushed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const sync = syncProductRepo(
    target,
    `foreman: ${run.prompt.slice(0, 72)}${run.prompt.length > 72 ? "…" : ""}`,
    opts.remote,
  );
  return { delivered: true, target, files: files.length, ...sync };
}
