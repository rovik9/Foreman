import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { execGit, gitUrlFor, type GitCredential } from "./git-auth.js";

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

/**
 * Local folder browser for the "new project" modal — browsers can't hand a
 * web page a real OS path (File System Access API returns a sandboxed
 * handle, not a path string), so the server lists directories instead.
 * Directories only, dotfiles hidden. Throws on unreadable/missing paths.
 */
export function listDirectories(requested?: string): DirListing {
  const target = resolve(requested?.trim() || homedir());
  const raw = readdirSync(target, { withFileTypes: true });
  const entries = raw
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => ({ name: d.name, path: resolve(target, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = target === dirname(target) ? null : dirname(target);
  return { path: target, parent, entries };
}

export type RepoCheck = { ok: true } | { ok: false; error: string };

function firstErrorLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string } | null;
  const raw = e?.stderr?.trim() || (err instanceof Error ? err.message : String(err));
  const firstLine = raw.split("\n").find((l) => l.trim().length > 0) ?? raw;
  return firstLine.replace(/^fatal:\s*/i, "").slice(0, 200);
}

/**
 * Verifies a code/memory repo URL is actually reachable, using the given
 * credential (see git-auth.ts) — most of these repos are private, so a
 * plain URL string was never going to be enough.
 */
export async function checkRepoAccess(url: string, cred?: GitCredential): Promise<RepoCheck> {
  try {
    await execGit(["ls-remote", "--exit-code", gitUrlFor(url, cred)], cred);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: firstErrorLine(err) };
  }
}

export type CloneResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Real, proof-of-connectivity clone (shallow) into destDir. Best-effort by
 * design — callers (project creation) should treat failure as informative,
 * not fatal, the same way GitHub auto-repo-create already degrades.
 */
export async function cloneRepo(
  url: string,
  destDir: string,
  cred?: GitCredential,
): Promise<CloneResult> {
  try {
    mkdirSync(dirname(destDir), { recursive: true });
    await execGit(["clone", "--depth", "1", gitUrlFor(url, cred), destDir], cred, {
      timeout: 60_000,
    });
    return { ok: true, path: destDir };
  } catch (err) {
    return { ok: false, error: firstErrorLine(err) };
  }
}
