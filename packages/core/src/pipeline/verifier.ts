import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

export interface GateResult {
  gate: string;
  command: string[];
  ok: boolean;
  output: string;
}

export type ExecFn = (
  command: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<{ code: number; output: string }>;

/** Real shell execution — only ever called with allowlisted binaries. */
export const spawnExec: ExecFn = (command, cwd, timeoutMs) =>
  new Promise((resolvePromise) => {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise({ code: -1, output: output + "\n[gate timed out]" });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, output });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, output: String(err) });
    });
  });

/**
 * Decides which deterministic gates apply to a workspace, based on the
 * config files the builders produced. No config files = no gates (the
 * judge still reviews).
 */
export function detectGates(workspace: string): string[][] {
  const gates: string[][] = [];
  if (!existsSync(join(workspace, "package.json"))) return gates;
  if (existsSync(join(workspace, "tsconfig.json"))) {
    gates.push(["npx", "tsc", "--noEmit"]);
  }
  const eslintConfigs = [
    "eslint.config.js",
    "eslint.config.mjs",
    ".eslintrc.json",
  ];
  if (eslintConfigs.some((f) => existsSync(join(workspace, f)))) {
    gates.push(["npx", "eslint", "."]);
  }
  if (
    existsSync(join(workspace, "vitest.config.ts")) ||
    existsSync(join(workspace, "vitest.config.js")) ||
    existsSync(join(workspace, "test")) ||
    existsSync(join(workspace, "tests"))
  ) {
    gates.push(["npx", "vitest", "run"]);
  }
  return gates;
}

const GATE_TIMEOUT_MS = 120_000;

export async function runGates(
  workspace: string,
  allowlist: string[],
  exec: ExecFn = spawnExec,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const command of detectGates(workspace)) {
    const binary = command[0]!;
    if (!allowlist.includes(binary)) {
      results.push({
        gate: binary,
        command,
        ok: false,
        output: `binary "${binary}" not in sandbox allowlist`,
      });
      continue;
    }
    const { code, output } = await exec(command, workspace, GATE_TIMEOUT_MS);
    results.push({
      gate: command.slice(0, 2).join(" "),
      command,
      ok: code === 0,
      output: output.slice(-4000), // keep the tail — errors live there
    });
  }
  return results;
}

export function gatesSummary(results: GateResult[]): string {
  if (results.length === 0) return "No deterministic gates applied (no toolchain config files in workspace).";
  return results
    .map(
      (r) =>
        `[${r.ok ? "PASS" : "FAIL"}] ${r.command.join(" ")}${r.ok ? "" : `\n${r.output}`}`,
    )
    .join("\n\n");
}
