import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
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
