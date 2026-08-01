import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface SyncResult {
  committed: boolean;
  pushed: boolean;
  error?: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Local-first git sync for a product's memory repo.
 * - repo is created on first use (git init, local identity)
 * - every documented run is committed locally — always
 * - push happens only when a remote is configured and auto_push is on
 * Best-effort: never throws into the pipeline.
 */
export function syncProductRepo(
  repoDir: string,
  message: string,
  remote?: string,
): SyncResult {
  try {
    if (!existsSync(join(repoDir, ".git"))) {
      git(["init", "-b", "main"], repoDir);
      git(["config", "user.name", "foreman"], repoDir);
      git(["config", "user.email", "foreman@local"], repoDir);
    }

    git(["add", "-A"], repoDir);
    if (!git(["status", "--porcelain"], repoDir)) {
      return { committed: false, pushed: false };
    }
    git(["commit", "-m", message], repoDir);

    if (!remote) return { committed: true, pushed: false };
    try {
      const remotes = git(["remote"], repoDir).split("\n").filter(Boolean);
      if (!remotes.includes("origin")) {
        git(["remote", "add", "origin", remote], repoDir);
      }
      git(["push", "-u", "origin", "main"], repoDir);
      return { committed: true, pushed: true };
    } catch (err) {
      return {
        committed: true,
        pushed: false,
        error: `push failed (local commit kept): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } catch (err) {
    return {
      committed: false,
      pushed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
