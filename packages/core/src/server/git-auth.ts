import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Modular git credential strategies. This is the ONLY place that knows how
 * to turn a credential into an actual git invocation — every git operation
 * in the codebase (validation today, clone/pull tomorrow) goes through
 * execGit() below, so a new auth method (GitHub App installation token,
 * gcloud, ...) means adding one case here, not touching every call site.
 *
 * Credentials are never persisted — they live only for the duration of the
 * request that supplied them (see server/app.ts). Foreman leans on the
 * local git identity by default ("system"), the same way any CLI git
 * command on this machine would.
 */
export type GitCredential =
  | { method: "system" }
  | { method: "ssh_key"; keyPath: string }
  | { method: "token"; token: string };

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Env overrides for the given credential. */
export function gitEnvFor(cred?: GitCredential): NodeJS.ProcessEnv {
  if (cred?.method === "ssh_key") {
    return {
      GIT_SSH_COMMAND: `ssh -i ${shellQuote(cred.keyPath)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes`,
    };
  }
  return {};
}

/** Rewrites an HTTPS url to embed a token credential. SSH urls and the
 *  system/ssh_key methods pass the url through untouched. */
export function gitUrlFor(url: string, cred?: GitCredential): string {
  if (cred?.method === "token" && /^https?:\/\//.test(url)) {
    try {
      const u = new URL(url);
      u.username = "x-access-token";
      u.password = cred.token;
      return u.toString();
    } catch {
      return url;
    }
  }
  return url;
}

/** Strips any embedded token out of error text before it can reach the UI. */
export function redact(text: string, cred?: GitCredential): string {
  let out = text.replace(/\/\/[^\s/@]+:[^\s/@]+@/g, "//***:***@");
  if (cred?.method === "token" && cred.token) {
    out = out.split(cred.token).join("***");
  }
  return out;
}

export interface ExecGitOptions {
  timeout?: number;
}

/** The single choke point every git shell-out in this codebase should use. */
export async function execGit(
  args: string[],
  cred?: GitCredential,
  opts: ExecGitOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", args, {
      timeout: opts.timeout ?? 15_000,
      env: { ...process.env, ...gitEnvFor(cred) },
    });
  } catch (err) {
    const e = err as { message?: string; stderr?: string };
    if (typeof e.message === "string") e.message = redact(e.message, cred);
    if (typeof e.stderr === "string") e.stderr = redact(e.stderr, cred);
    throw err;
  }
}
