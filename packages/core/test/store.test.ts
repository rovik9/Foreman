import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";

describe("Store", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-store-"));
    store = new Store(join(dir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates and reads a run", () => {
    const run = store.createRun("build me a landing page");
    expect(run.status).toBe("queued");
    expect(run.cost_usd).toBe(0);
    expect(store.getRun(run.id).prompt).toBe("build me a landing page");
  });

  it("round-trips tasks with deps and criteria", () => {
    const run = store.createRun("p");
    const t1 = store.createTask({
      runId: run.id,
      seq: 1,
      class: "build",
      description: "scaffold",
      acceptanceCriteria: [{ type: "command", run: "pnpm build" }],
    });
    store.createTask({
      runId: run.id,
      seq: 2,
      class: "build",
      description: "feature",
      deps: [t1.id],
    });
    const tasks = store.listTasks(run.id);
    expect(tasks).toHaveLength(2);
    expect(JSON.parse(tasks[0]!.acceptance_criteria)).toHaveLength(1);
    expect(JSON.parse(tasks[1]!.deps)).toEqual([t1.id]);
  });

  it("logs messages in order", () => {
    const run = store.createRun("p");
    store.addMessage({ runId: run.id, role: "user", content: "hi" });
    store.addMessage({ runId: run.id, role: "pm", slot: "pm", content: "hello" });
    const msgs = store.listMessages(run.id) as { content: string }[];
    expect(msgs.map((m) => m.content)).toEqual(["hi", "hello"]);
  });

  it("accumulates cost onto run and task atomically", () => {
    const run = store.createRun("p");
    const task = store.createTask({
      runId: run.id,
      seq: 1,
      class: "build",
      description: "x",
    });
    store.addCost({
      runId: run.id,
      taskId: task.id,
      slot: "builder_a",
      model: "kimi-k3",
      promptTokens: 100,
      completionTokens: 50,
      costUsd: 0.012,
    });
    store.addCost({
      runId: run.id,
      slot: "pm",
      model: "claude-sonnet-5",
      promptTokens: 10,
      completionTokens: 5,
      costUsd: 0.003,
    });
    expect(store.runCost(run.id)).toBeCloseTo(0.015, 6);
    expect(store.getRun(run.id).cost_usd).toBeCloseTo(0.015, 6);
    expect(store.getTask(task.id).cost_usd).toBeCloseTo(0.012, 6);
  });

  it("records artifacts", () => {
    const run = store.createRun("p");
    store.addArtifact({ runId: run.id, path: "out/hero.mp4", kind: "video" });
    const arts = store.listArtifacts(run.id) as { kind: string }[];
    expect(arts[0]!.kind).toBe("video");
  });

  it("throws on unknown run", () => {
    expect(() => store.getRun("nope")).toThrow(/run not found/);
  });
});
