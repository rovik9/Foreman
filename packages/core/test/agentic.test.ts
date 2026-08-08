import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTaskAgentic } from "../src/agents/builder.js";
import type { PmSpec } from "../src/agents/pm.js";
import type { TaskRow } from "../src/store/db.js";
import { makeRig } from "./helpers.js";

const SPEC: PmSpec = {
  summary: "tiny node script",
  product: "misc",
  requirements: ["prints a greeting"],
  constraints: [],
  confidence: 1,
  questions: [],
};

function task(id: string): TaskRow {
  return {
    id, run_id: "r", seq: 1, class: "build", slot: "builder_a",
    description: "write greet.js that prints hello, then run it",
    acceptance_criteria: "[]", deps: "[]", status: "running",
    iterations: 0, cost_usd: 0, output: null,
  };
}

describe("agentic builder", () => {
  let ws: string;
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "foreman-agentic-")); });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  const ctx = () => ({ workspace: ws, allowlist: ["node"], commandTimeoutMs: 15_000 });

  it("writes a file, runs it for real, sees the output and finishes", async () => {
    const rig = makeRig({
      "build-model": [
        JSON.stringify({ tool: "list_files", args: { path: "." } }),
        JSON.stringify({
          tool: "write_file",
          args: { path: "greet.js", content: "console.log('hello from foreman')" },
        }),
        JSON.stringify({ tool: "run_command", args: { command: ["node", "greet.js"] } }),
        JSON.stringify({ done: true, notes: "wrote greet.js and ran it" }),
      ],
    });
    const run = rig.store.createRun("agentic");
    const steps: { tool: string; ok: boolean; output: string }[] = [];

    const out = await buildTaskAgentic(
      rig.harness, run.id, task("t1"), SPEC, ws, ctx(), undefined, [], undefined,
      { onStep: (s) => steps.push({ tool: s.tool, ok: s.ok, output: s.output }) },
    );

    // the file really exists and the command really ran
    expect(existsSync(join(ws, "greet.js"))).toBe(true);
    expect(readFileSync(join(ws, "greet.js"), "utf8")).toContain("hello from foreman");
    const ran = steps.find((s) => s.tool === "run_command")!;
    expect(ran.ok).toBe(true);
    expect(ran.output).toContain("hello from foreman");

    expect(steps.map((s) => s.tool)).toEqual(["list_files", "write_file", "run_command"]);
    expect(out.notes).toContain("ran it");
    expect(out.files.map((f) => f.path)).toContain("greet.js");
  }, 30_000);

  it("sees a real failure and fixes it — the whole point of tool use", async () => {
    const rig = makeRig({
      "build-model": [
        // deliberately broken
        JSON.stringify({ tool: "write_file", args: { path: "app.js", content: "syntax ( error" } }),
        JSON.stringify({ tool: "run_command", args: { command: ["node", "app.js"] } }),
        // model reacts to the error it just saw
        JSON.stringify({ tool: "write_file", args: { path: "app.js", content: "console.log('fixed')" } }),
        JSON.stringify({ tool: "run_command", args: { command: ["node", "app.js"] } }),
        JSON.stringify({ done: true, notes: "fixed a syntax error I caught by running it" }),
      ],
    });
    const run = rig.store.createRun("agentic");
    const steps: { ok: boolean; output: string }[] = [];

    await buildTaskAgentic(
      rig.harness, run.id, task("t2"), SPEC, ws, ctx(), undefined, [], undefined,
      { onStep: (s) => steps.push({ ok: s.ok, output: s.output }) },
    );

    const runs = steps.filter((s) => s.output.includes("[exit"));
    expect(runs[0]!.ok).toBe(false);              // first run genuinely failed
    expect(runs[0]!.output).toMatch(/SyntaxError/);
    expect(runs[1]!.ok).toBe(true);               // and the retry genuinely passed
    expect(readFileSync(join(ws, "app.js"), "utf8")).toContain("fixed");

    // the failure was fed back to the model, not swallowed
    const followUp = rig.mock.calls.filter((c) => c.model === "build-model")[2]!.input;
    expect(followUp).toMatch(/SyntaxError/);
  }, 30_000);

  it("refuses a non-allowlisted binary and tells the model why", async () => {
    const rig = makeRig({
      "build-model": [
        JSON.stringify({ tool: "run_command", args: { command: ["rm", "-rf", "/"] } }),
        JSON.stringify({ done: true, notes: "blocked" }),
      ],
    });
    const run = rig.store.createRun("agentic");
    const steps: { ok: boolean; output: string }[] = [];
    await buildTaskAgentic(
      rig.harness, run.id, task("t3"), SPEC, ws, ctx(), undefined, [], undefined,
      { onStep: (s) => steps.push({ ok: s.ok, output: s.output }) },
    );
    expect(steps[0]!.ok).toBe(false);
    expect(steps[0]!.output).toMatch(/not allowed/);
  }, 30_000);

  it("stops mid-loop when the budget/stop signal fires", async () => {
    const rig = makeRig({
      "build-model": Array.from({ length: 10 }, () =>
        JSON.stringify({ tool: "list_files", args: {} })),
    });
    const run = rig.store.createRun("agentic");
    let calls = 0;
    const out = await buildTaskAgentic(
      rig.harness, run.id, task("t4"), SPEC, ws, ctx(), undefined, [], undefined,
      { shouldStop: () => ++calls > 3 },
    );
    expect(rig.mock.calls.filter((c) => c.model === "build-model").length).toBeLessThan(6);
    expect(out.notes).toMatch(/stopped|step limit/);
  }, 30_000);

  it("can call a connected MCP tool, and the tool is advertised in the prompt", async () => {
    const rig = makeRig({
      "build-model": [
        JSON.stringify({ tool: "higgsfield.render", args: { prompt: "a logo" } }),
        JSON.stringify({ done: true, notes: "rendered via mcp" }),
      ],
    });
    const run = rig.store.createRun("agentic");
    const seen: Record<string, unknown>[] = [];
    const withMcp = {
      ...ctx(),
      mcpTools: [
        {
          name: "higgsfield.render",
          description: "render a video or image",
          call: async (args: Record<string, unknown>) => {
            seen.push(args);
            return { ok: true, output: "saved /tmp/out.mp4" };
          },
        },
      ],
    };
    const steps: { tool: string; ok: boolean; output: string }[] = [];

    await buildTaskAgentic(
      rig.harness, run.id, task("t6"), SPEC, ws, withMcp, undefined, [], undefined,
      { onStep: (s) => steps.push({ tool: s.tool, ok: s.ok, output: s.output }) },
    );

    // the tool really ran, with the model's args
    expect(seen).toEqual([{ prompt: "a logo" }]);
    expect(steps[0]).toMatchObject({ tool: "higgsfield.render", ok: true });
    expect(steps[0]!.output).toContain("out.mp4");
    // and the builder was told the tool exists
    expect(rig.mock.calls[0]!.system).toContain("higgsfield.render");
    expect(rig.mock.calls[0]!.system).toContain("render a video or image");
  }, 30_000);

  it("honours a single-shot file set without burning a second call", async () => {
    const rig = makeRig({
      "build-model": [
        JSON.stringify({ files: [{ path: "one.txt", content: "shot" }], notes: "single shot" }),
      ],
    });
    const run = rig.store.createRun("agentic");
    const out = await buildTaskAgentic(rig.harness, run.id, task("t5"), SPEC, ws, ctx());
    expect(readFileSync(join(ws, "one.txt"), "utf8")).toBe("shot");
    expect(out.notes).toBe("single shot");
    expect(rig.mock.calls.filter((c) => c.model === "build-model")).toHaveLength(1);
  }, 30_000);
});
