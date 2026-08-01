import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForemanConfig } from "../src/config/schema.js";
import { AgentHarness } from "../src/agents/harness.js";
import { ForemanBus } from "../src/events/bus.js";
import { MockProvider } from "../src/providers/mock.js";
import { Store } from "../src/store/db.js";

export function makeConfig(dir: string): ForemanConfig {
  return {
    models: {
      slots: {
        pm: { provider: "anthropic", model: "pm-model", via: "anthropic" },
        architect: { provider: "openai", model: "arch-model", via: "openai" },
        builder_a: { provider: "moonshot", model: "build-model", via: "moonshot" },
        judge: { provider: "anthropic", model: "judge-model", via: "anthropic" },
        realtime: { provider: "groq", model: "rt-model", via: "groq" },
        memorizer: { provider: "moonshot", model: "memo-model", via: "moonshot" },
        context: { provider: "google", model: "ctx-model", via: "google" },
      },
      roles: {
        interface: { options: ["pm"], active: "pm" },
        architect: { options: ["architect"], active: "architect" },
        trend: { options: ["realtime"], active: "realtime" },
        context: { options: ["context"], active: "context" },
        builder: { options: ["builder_a"], active: "builder_a" },
        judge: { options: ["judge"], active: "judge" },
        memorizer: { options: ["memorizer"], active: "memorizer" },
      },
      tiers: {
        plan: ["architect"],
        build: ["builder_a"],
        critique: ["judge"],
        fetch: ["realtime"],
      },
      cost_weights: {
        architect: 3.0,
        builder_a: 1.0,
        judge: 1.5,
        realtime: 0.2,
        pm: 1.5,
        memorizer: 1.0,
      },
      asset_studios: {},
    },
    prices: {
      models: {
        "pm-model": [3.0, 15.0],
        "arch-model": [10.0, 30.0],
        "build-model": [0.6, 2.5],
        "judge-model": [3.0, 15.0],
        "rt-model": [0.1, 0.2],
        "memo-model": [0.6, 2.5],
      },
      default: [1.0, 3.0],
    },
    memory: {
      mirror_dir: join(dir, "memory"),
      auto_push: false,
      remotes: {},
    },
    limits: {
      max_iterations_per_task: 3,
      max_cost_per_run_usd: 5,
      max_cost_per_task_usd: 1,
      max_parallel_builders: 1,
      pm_clarify_confidence_threshold: 0.7,
      judge_pass_score: 0.85,
      sandbox: { workspace_root: join(dir, "runs"), shell_allowlist: ["npx"] },
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
  const config = makeConfig(dir);
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
    // memory governance review (documentRun → reviewMemories)
    JSON.stringify({
      decisions: [{ index: 0, decision: "approve", reason: "durable preference" }],
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
  "memo-model": [
    JSON.stringify({
      memories: [
        {
          kind: "preference",
          text: "User likes dark themes for web pages",
          tags: ["ui", "style"],
          confidence: 0.9,
        },
      ],
    }),
  ],
};
