import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForemanConfig } from "../src/config/schema.js";
import { AgentHarness } from "../src/agents/harness.js";
import { ForemanBus } from "../src/events/bus.js";
import { MockProvider } from "../src/providers/mock.js";
import { Store } from "../src/store/db.js";

export function makeConfig(workspaceRoot: string): ForemanConfig {
  return {
    models: {
      slots: {
        pm: { provider: "anthropic", model: "pm-model", via: "openrouter" },
        architect: { provider: "openai", model: "arch-model", via: "openrouter" },
        builder_a: { provider: "moonshot", model: "build-model", via: "openrouter" },
        judge: { provider: "anthropic", model: "judge-model", via: "openrouter" },
      },
      tiers: {
        plan: ["architect"],
        build: ["builder_a"],
        critique: ["judge"],
        fetch: ["architect"],
      },
      cost_weights: {},
      asset_studios: {},
    },
    limits: {
      max_iterations_per_task: 3,
      max_cost_per_run_usd: 5,
      max_cost_per_task_usd: 1,
      max_parallel_builders: 1,
      pm_clarify_confidence_threshold: 0.7,
      judge_pass_score: 0.85,
      sandbox: { workspace_root: workspaceRoot, shell_allowlist: ["npx"] },
    },
  };
}

export interface TestRig {
  config: ForemanConfig;
  store: Store;
  bus: ForemanBus;
  harness: AgentHarness;
  mock: MockProvider;
  dir: string;
}

export function makeRig(script: Record<string, string[]>): TestRig {
  const dir = mkdtempSync(join(tmpdir(), "foreman-test-"));
  const config = makeConfig(join(dir, "runs"));
  const store = new Store(join(dir, "test.db"));
  const bus = new ForemanBus();
  const mock = new MockProvider(script);
  const harness = new AgentHarness(config, store, bus, { mock });
  return { config, store, bus, harness, mock, dir };
}

/** Canned script for a 2-task happy-path run. */
export const HAPPY_SCRIPT: Record<string, string[]> = {
  "pm-model": [
    JSON.stringify({
      summary: "Build a landing page",
      requirements: ["Single index.html", "Dark theme"],
      constraints: [],
      confidence: 0.95,
      questions: [],
    }),
  ],
  "arch-model": [
    JSON.stringify({
      tasks: [
        {
          id: "t1",
          class: "build",
          description: "Create index.html",
          acceptanceCriteria: [
            { type: "rubric", check: "Has hero and features sections" },
          ],
          deps: [],
        },
        {
          id: "t2",
          class: "build",
          description: "Create style.css",
          acceptanceCriteria: [
            { type: "rubric", check: "Dark theme variables defined" },
          ],
          deps: ["t1"],
        },
      ],
    }),
  ],
  "build-model": [
    JSON.stringify({
      files: [{ path: "index.html", content: "<!doctype html><title>F</title>" }],
      notes: "",
    }),
    JSON.stringify({
      files: [{ path: "style.css", content: ":root{--bg:#0d1117}" }],
      notes: "",
    }),
  ],
  "judge-model": [
    JSON.stringify({ score: 0.95, pass: true, feedback: "good" }),
    JSON.stringify({ score: 0.9, pass: true, feedback: "good" }),
  ],
};
