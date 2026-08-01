import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../src/pipeline/runner.js";
import { HAPPY_SCRIPT, makeRig } from "./helpers.js";

describe("runPipeline", () => {
  it("runs the full loop: pm → architect → builders → judge → completed", async () => {
    const rig = makeRig(HAPPY_SCRIPT);
    const run = rig.store.createRun("build me a landing page");

    await runPipeline(
      {
        config: rig.config,
        store: rig.store,
        bus: rig.bus,
        harness: rig.harness,
        memoryDir: rig.config.memory.mirror_dir,
      },
      run.id,
    );

    const final = rig.store.getRun(run.id);
    expect(final.status).toBe("completed");
    expect(final.cost_usd).toBeGreaterThan(0);

    const tasks = rig.store.listTasks(run.id);
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.status === "passed")).toBe(true);
    // dependency order: style.css task ran after index.html task
    expect(tasks[0]!.description).toContain("index.html");
    // router assigned the cheapest build slot
    expect(tasks[0]!.slot).toBe("builder_a");

    const ws = join(rig.dir, "runs", run.id, "workspace");
    expect(existsSync(join(ws, "index.html"))).toBe(true);
    expect(existsSync(join(ws, "style.css"))).toBe(true);

    // builder files registered as artifacts
    expect(rig.store.listArtifacts(run.id).length).toBeGreaterThanOrEqual(2);

    // every agent fired in role order
    const models = rig.mock.calls.map((c) => c.model);
    expect(models[0]).toBe("pm-model");
    expect(models[1]).toBe("arch-model");
    expect(models.filter((m) => m === "build-model")).toHaveLength(2);
    expect(models.filter((m) => m === "judge-model")).toHaveLength(2);

    // ---- documentation chain of custody ----
    // 1. durable memory distilled into the store (FTS-searchable)
    expect(rig.store.listMemories()).toHaveLength(1);
    expect(rig.store.searchMemories("dark themes")).toHaveLength(1);
    // 2. memory mirrored to markdown (obsidian window)
    expect(
      existsSync(
        join(rig.dir, "memory", "products", "misc", "memory", "preference"),
      ),
    ).toBe(true);
    // 3. journal written
    expect(
      existsSync(join(rig.dir, "memory", "products", "misc", "journal")),
    ).toBe(true);
    // 4. product memory repo committed locally
    expect(
      existsSync(join(rig.dir, "memory", "products", "misc", ".git")),
    ).toBe(true);
  });

  it("pauses for clarification when PM confidence is low, resumes on answer", async () => {
    const rig = makeRig({
      "pm-model": [
        JSON.stringify({
          summary: "unclear",
          requirements: ["something"],
          constraints: [],
          confidence: 0.4,
          questions: ["Web or CLI?"],
        }),
        // second call after the user answers
        HAPPY_SCRIPT["pm-model"]![0]!,
      ],
      "arch-model": HAPPY_SCRIPT["arch-model"]!,
      "build-model": HAPPY_SCRIPT["build-model"]!,
      "judge-model": HAPPY_SCRIPT["judge-model"]!,
    });
    const run = rig.store.createRun("make the thing");
    // mirrors server flow: the prompt is always the first user message
    rig.store.addMessage({ runId: run.id, role: "user", content: "make the thing" });

    const deps = { config: rig.config, store: rig.store, bus: rig.bus, harness: rig.harness };
    await runPipeline(deps, run.id);
    expect(rig.store.getRun(run.id).status).toBe("awaiting_user");

    // user answers → pipeline resumes
    rig.store.addMessage({ runId: run.id, role: "user", content: "Web, dark theme" });
    await runPipeline(deps, run.id);

    expect(rig.store.getRun(run.id).status).toBe("completed");
    // PM saw the answer on its second call
    expect(rig.mock.calls[1]!.input).toContain("Web, dark theme");
  });

  it("escalates after max_iterations when the judge keeps failing", async () => {
    const rig = makeRig({
      "pm-model": HAPPY_SCRIPT["pm-model"]!,
      "arch-model": [
        JSON.stringify({
          tasks: [
            {
              id: "t1",
              class: "build",
              description: "impossible task",
              acceptanceCriteria: [{ type: "rubric", check: "unachievable" }],
              deps: [],
            },
          ],
        }),
      ],
      "build-model": [
        JSON.stringify({ files: [{ path: "a.txt", content: "x" }], notes: "" }),
        JSON.stringify({ files: [{ path: "a.txt", content: "x2" }], notes: "" }),
        JSON.stringify({ files: [{ path: "a.txt", content: "x3" }], notes: "" }),
      ],
      "judge-model": [
        JSON.stringify({ score: 0.3, pass: false, feedback: "not good enough" }),
        JSON.stringify({ score: 0.4, pass: false, feedback: "still no" }),
        JSON.stringify({ score: 0.5, pass: false, feedback: "closer" }),
      ],
    });
    const run = rig.store.createRun("do impossible");

    await runPipeline(
      { config: rig.config, store: rig.store, bus: rig.bus, harness: rig.harness },
      run.id,
    );

    const final = rig.store.getRun(run.id);
    expect(final.status).toBe("awaiting_user");
    const task = rig.store.listTasks(run.id)[0]!;
    expect(task.status).toBe("escalated");
    expect(task.iterations).toBe(3); // max_iterations_per_task from fixture
    // builder got judge feedback on retries
    expect(rig.mock.calls.filter((c) => c.model === "build-model")[1]!.input)
      .toContain("not good enough");
  });
});
