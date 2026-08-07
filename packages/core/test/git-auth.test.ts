import { describe, expect, it } from "vitest";
import { execGit, gitEnvFor, gitUrlFor, redact } from "../src/server/git-auth.js";

describe("gitEnvFor", () => {
  it("system credential needs no env overrides", () => {
    expect(gitEnvFor({ method: "system" })).toEqual({});
    expect(gitEnvFor(undefined)).toEqual({});
  });

  it("ssh_key sets GIT_SSH_COMMAND with the quoted key path", () => {
    const env = gitEnvFor({ method: "ssh_key", keyPath: "/home/me/.ssh/id_ed25519" });
    expect(env.GIT_SSH_COMMAND).toContain("-i '/home/me/.ssh/id_ed25519'");
    expect(env.GIT_SSH_COMMAND).toContain("IdentitiesOnly=yes");
  });

  it("safely quotes a key path containing a single quote", () => {
    const env = gitEnvFor({ method: "ssh_key", keyPath: "/tmp/weird'key" });
    expect(env.GIT_SSH_COMMAND).toContain(`'/tmp/weird'\\''key'`);
  });

  it("token credential needs no ssh env overrides", () => {
    expect(gitEnvFor({ method: "token", token: "abc123" })).toEqual({});
  });
});

describe("gitUrlFor", () => {
  it("leaves system/ssh_key credentials and ssh urls untouched", () => {
    expect(gitUrlFor("git@github.com:you/app.git", { method: "system" })).toBe(
      "git@github.com:you/app.git",
    );
    expect(gitUrlFor("https://github.com/you/app.git", { method: "ssh_key", keyPath: "x" })).toBe(
      "https://github.com/you/app.git",
    );
  });

  it("embeds a token credential into an https url", () => {
    const url = gitUrlFor("https://github.com/you/app.git", { method: "token", token: "ghp_secret" });
    expect(url).toBe("https://x-access-token:ghp_secret@github.com/you/app.git");
  });

  it("leaves non-http token urls untouched (e.g. ssh)", () => {
    expect(gitUrlFor("git@github.com:you/app.git", { method: "token", token: "ghp_secret" })).toBe(
      "git@github.com:you/app.git",
    );
  });
});

describe("redact", () => {
  it("strips a known token out of arbitrary text", () => {
    const out = redact("fatal: auth failed for ghp_secret at host", {
      method: "token",
      token: "ghp_secret",
    });
    expect(out).not.toContain("ghp_secret");
    expect(out).toContain("***");
  });

  it("strips embedded url credentials even without a known token", () => {
    const out = redact("Command failed: git ls-remote https://x-access-token:ghp_secret@github.com/x");
    expect(out).not.toContain("ghp_secret");
    expect(out).toContain("//***:***@github.com");
  });
});

describe("execGit", () => {
  it("runs a real git command and resolves stdout", async () => {
    const { stdout } = await execGit(["--version"]);
    expect(stdout).toContain("git version");
  });

  it("rejects on a bad subcommand without leaking anything odd", async () => {
    await expect(execGit(["not-a-real-subcommand"])).rejects.toBeTruthy();
  });
});
