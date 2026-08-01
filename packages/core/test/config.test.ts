import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";

const VALID_MODELS = `
slots:
  pm: { provider: anthropic, model: claude-sonnet-5, via: anthropic }
  architect: { provider: openai, model: gpt-5.6-sol, via: openai, fallback: claude-opus-5 }
  builder_a: { provider: moonshot, model: kimi-k3, via: moonshot }
roles:
  interface: { options: [pm], active: pm }
  architect: { options: [architect], active: architect }
  builder: { options: [builder_a], active: builder_a }
  judge: { options: [pm], active: pm }
  memorizer: { options: [builder_a], active: builder_a }
tiers:
  plan: [architect]
  build: [builder_a]
cost_weights:
  architect: 3.0
  builder_a: 1.0
asset_studios:
  video: { type: mcp, command: higgsfield-mcp, args: [] }
`;

const VALID_LIMITS = `
max_iterations_per_task: 5
max_cost_per_run_usd: 5.00
max_cost_per_task_usd: 1.00
max_parallel_builders: 3
pm_clarify_confidence_threshold: 0.7
judge_pass_score: 0.85
sandbox:
  workspace_root: runs
  shell_allowlist: [pnpm, node]
`;

describe("loadConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(models: string, limits: string): void {
    writeFileSync(join(dir, "models.yaml"), models);
    writeFileSync(join(dir, "limits.yaml"), limits);
  }

  it("loads a valid registry", () => {
    write(VALID_MODELS, VALID_LIMITS);
    const cfg = loadConfig(dir);
    expect(cfg.models.slots["architect"]?.model).toBe("gpt-5.6-sol");
    expect(cfg.models.slots["architect"]?.fallback).toBe("claude-opus-5");
    expect(cfg.limits.max_iterations_per_task).toBe(5);
    expect(cfg.limits.sandbox.shell_allowlist).toContain("pnpm");
  });

  it("rejects a tier referencing an unknown slot", () => {
    write(
      VALID_MODELS.replace("build: [builder_a]", "build: [ghost]"),
      VALID_LIMITS,
    );
    expect(() => loadConfig(dir)).toThrow(/unknown slot "ghost"/);
  });

  it("rejects cost_weights referencing an unknown slot", () => {
    write(
      VALID_MODELS.replace("builder_a: 1.0", "ghost: 1.0"),
      VALID_LIMITS,
    );
    expect(() => loadConfig(dir)).toThrow(/unknown slot "ghost"/);
  });

  it("rejects invalid limits values", () => {
    write(
      VALID_MODELS,
      VALID_LIMITS.replace("judge_pass_score: 0.85", "judge_pass_score: 1.5"),
    );
    expect(() => loadConfig(dir)).toThrow();
  });

  it("rejects a missing models.yaml", () => {
    mkdirSync(dir, { recursive: true });
    expect(() => loadConfig(dir)).toThrow();
  });

  it("rejects a role whose active slot is not in its options", () => {
    write(
      VALID_MODELS.replace(
        "interface: { options: [pm], active: pm }",
        "interface: { options: [builder_a], active: pm }",
      ),
      VALID_LIMITS,
    );
    expect(() => loadConfig(dir)).toThrow(/active slot "pm" is not in its options/);
  });

  it("rejects a role option referencing an unknown slot", () => {
    write(
      VALID_MODELS.replace(
        "builder: { options: [builder_a], active: builder_a }",
        "builder: { options: [ghost], active: ghost }",
      ),
      VALID_LIMITS,
    );
    expect(() => loadConfig(dir)).toThrow(/unknown slot "ghost"/);
  });

  it("rejects when a required role is missing", () => {
    write(
      VALID_MODELS.replace("  judge: { options: [pm], active: pm }\n", ""),
      VALID_LIMITS,
    );
    expect(() => loadConfig(dir)).toThrow(/required role "judge"/);
  });
});
