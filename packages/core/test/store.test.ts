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

  it("recoverInterruptedRuns sweeps zombies to a resumable state", () => {
    const run = store.createRun("interrupted");
    const task = store.createTask({
      runId: run.id,
      seq: 1,
      class: "build",
      description: "x",
    });
    store.setRunStatus(run.id, "running");
    store.updateTask(task.id, { status: "running" });

    const recovered = store.recoverInterruptedRuns();

    expect(recovered).toEqual([run.id]);
    expect(store.getRun(run.id).status).toBe("failed");
    expect(store.getTask(task.id).status).toBe("pending");
    const msgs = store.listMessages(run.id) as { content: string }[];
    expect(msgs.some((m) => m.content.includes("interrupted"))).toBe(true);
    // idempotent: nothing left to recover
    expect(store.recoverInterruptedRuns()).toEqual([]);
  });

  it("deleteRun cascades to its tasks, messages, and artifacts", () => {
    const run = store.createRun("clean me up");
    const task = store.createTask({ runId: run.id, seq: 1, class: "build", description: "x" });
    store.addMessage({ runId: run.id, role: "user", content: "hi" });
    store.addArtifact({ runId: run.id, taskId: task.id, path: "out.txt", kind: "doc" });

    expect(store.deleteRun(run.id)).toBe(true);

    expect(() => store.getRun(run.id)).toThrow();
    expect(store.listTasks(run.id)).toHaveLength(0);
    expect(store.listMessages(run.id)).toHaveLength(0);
    expect(store.listArtifacts(run.id)).toHaveLength(0);
    // idempotent: already gone
    expect(store.deleteRun(run.id)).toBe(false);
  });

  it("api keys: set, get, list names without values, clear on blank", () => {
    expect(store.getApiKey("ANTHROPIC_API_KEY")).toBeUndefined();

    store.setApiKey("ANTHROPIC_API_KEY", "sk-test-123");
    expect(store.getApiKey("ANTHROPIC_API_KEY")).toBe("sk-test-123");

    const names = store.listApiKeyNames();
    expect(names.map((n) => n.name)).toEqual(["ANTHROPIC_API_KEY"]);

    // update overwrites, never leaks in the listing
    store.setApiKey("ANTHROPIC_API_KEY", "sk-test-456");
    expect(store.getApiKey("ANTHROPIC_API_KEY")).toBe("sk-test-456");

    // blank clears
    store.setApiKey("ANTHROPIC_API_KEY", "  ");
    expect(store.getApiKey("ANTHROPIC_API_KEY")).toBeUndefined();
    expect(store.listApiKeyNames()).toHaveLength(0);
  });

  it("spendReport aggregates by model, run and day, scoped per project", () => {
    const a = store.createRun("project a work", { product: "alpha" });
    const b = store.createRun("project b work", { product: "beta" });
    const cost = (runId: string, model: string, slot: string, usd: number) =>
      store.addCost({ runId, slot, model, promptTokens: 100, completionTokens: 50, costUsd: usd });

    cost(a.id, "claude-sonnet-5", "pm", 0.10);
    cost(a.id, "claude-sonnet-5", "pm", 0.05);
    cost(a.id, "kimi-k3", "builder_a", 0.02);
    cost(b.id, "kimi-k3", "builder_a", 0.99);

    const all = store.spendReport();
    expect(all.totals.cost).toBeCloseTo(1.16, 6);
    expect(all.totals.calls).toBe(4);
    expect(all.totals.promptTokens).toBe(400);
    expect(all.totals.completionTokens).toBe(200);

    const alpha = store.spendReport("alpha");
    expect(alpha.totals.cost).toBeCloseTo(0.17, 6);
    expect(alpha.totals.calls).toBe(3);
    // grouped by model, most expensive first
    expect(alpha.byModel[0]!.model).toBe("claude-sonnet-5");
    expect(alpha.byModel[0]!.cost).toBeCloseTo(0.15, 6);
    expect(alpha.byModel[0]!.calls).toBe(2);
    expect(alpha.byModel[1]!.model).toBe("kimi-k3");
    // beta's spend never leaks into alpha
    expect(alpha.byRun).toHaveLength(1);
    expect(alpha.byRun[0]!.run_id).toBe(a.id);
    expect(alpha.byDay.reduce((s, d) => s + d.cost, 0)).toBeCloseTo(0.17, 6);
  });

  it("custom providers: create, look up by name, delete", () => {
    const p = store.createCustomProvider({
      name: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1",
    });
    expect(p.wire).toBe("openai");
    expect(p.api_key).toBeNull();
    expect(store.getCustomProviderByName("ollama")?.base_url).toBe("http://localhost:11434/v1");
    expect(store.getCustomProviderByName("nope")).toBeUndefined();
    expect(store.listCustomProviders()).toHaveLength(1);
    expect(store.deleteCustomProvider(p.id)).toBe(true);
    expect(store.listCustomProviders()).toHaveLength(0);
  });

  it("mcp servers: create, list, toggle, delete", () => {
    const s = store.createMcpServer({ name: "higgsfield", kind: "video", command: "higgsfield-mcp", args: ["--fast"] });
    expect(s.enabled).toBe(1);
    expect(JSON.parse(s.args)).toEqual(["--fast"]);

    expect(store.listMcpServers()).toHaveLength(1);

    expect(store.setMcpServerEnabled(s.id, false)).toBe(true);
    expect(store.getMcpServer(s.id).enabled).toBe(0);

    expect(store.deleteMcpServer(s.id)).toBe(true);
    expect(store.listMcpServers()).toHaveLength(0);
    expect(store.deleteMcpServer(s.id)).toBe(false);
  });
});
