import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

/**
 * Verifies a code/memory repo URL is actually reachable, using whatever
 * git credentials (SSH agent, credential helper) already exist on this
 * machine — the point being most of these repos are private.
 */
export async function checkRepoAccess(url: string): Promise<RepoCheck> {
  try {
    await execFileAsync("git", ["ls-remote", "--exit-code", url], {
      timeout: 10_000,
    });
    return { ok: true };
  } catch (err) {
    const stderr = (err as { stderr?: string } | null)?.stderr?.trim();
    const raw = stderr || (err instanceof Error ? err.message : String(err));
    const firstLine = raw.split("\n").find((l) => l.trim().length > 0) ?? raw;
    return { ok: false, error: firstLine.replace(/^fatal:\s*/i, "").slice(0, 200) };
  }
}
