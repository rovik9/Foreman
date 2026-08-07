import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../src/agents/harness.js";
import type { ForemanEvent } from "../src/events/bus.js";
import { ForemanBus } from "../src/events/bus.js";
import { MockProvider } from "../src/providers/mock.js";
import { Store } from "../src/store/db.js";
import { makeConfig, makeRig } from "./helpers.js";

describe("AgentHarness", () => {
  it("routes through the slot, records cost, logs messages, emits events", async () => {
    const rig = makeRig({ "pm-model": ["hello world"] });
    const events: ForemanEvent[] = [];
    rig.bus.subscribeAll((e) => events.push(e));

    const run = rig.store.createRun("test prompt");
    const result = await rig.harness.run({
      runId: run.id,
      slot: "pm",
      role: "pm",
      system: "sys",
      input: "do the thing",
    });

    expect(result.output).toBe("hello world");
    expect(rig.store.runCost(run.id)).toBeCloseTo(0.0011, 6);
    expect(rig.store.getRun(run.id).cost_usd).toBeCloseTo(0.0011, 6);

    const msgs = rig.store.listMessages(run.id) as { content: string }[];
    expect(msgs.map((m) => m.content)).toContain("do the thing");
    expect(msgs.map((m) => m.content)).toContain("hello world");

    expect(events.filter((e) => e.type === "agent_call")).toHaveLength(2);
    expect(events.some((e) => e.type === "cost")).toBe(true);
  });

  it("throws on unknown slot", async () => {
    const rig = makeRig({});
    const run = rig.store.createRun("p");
    await expect(
      rig.harness.run({ runId: run.id, slot: "ghost", role: "pm", system: "", input: "" }),
    ).rejects.toThrow(/unknown slot "ghost"/);
  });

  it("falls back to the live resolver when the static map is missing the via", async () => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-harness-"));
    const config = makeConfig(dir);
    const store = new Store(join(dir, "test.db"));
    const bus = new ForemanBus();
    const mock = new MockProvider({ "pm-model": ["from the resolver"] });
    // static map is empty — only the resolver fallback can serve "anthropic"
    const harness = new AgentHarness(config, store, bus, {}, (via) =>
      via === "anthropic" ? mock : undefined,
    );

    const run = store.createRun("test");
    const result = await harness.run({
      runId: run.id,
      slot: "pm",
      role: "pm",
      system: "sys",
      input: "hi",
    });
    expect(result.output).toBe("from the resolver");
  });

  it("prefers the static provider map over the live resolver", async () => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-harness-"));
    const config = makeConfig(dir);
    const store = new Store(join(dir, "test.db"));
    const bus = new ForemanBus();
    const staticMock = new MockProvider({ "pm-model": ["from the static map"] });
    const resolverMock = new MockProvider({ "pm-model": ["from the resolver"] });
    const harness = new AgentHarness(config, store, bus, { anthropic: staticMock }, () =>
      resolverMock,
    );

    const run = store.createRun("test");
    const result = await harness.run({
      runId: run.id,
      slot: "pm",
      role: "pm",
      system: "sys",
      input: "hi",
    });
    expect(result.output).toBe("from the static map");
  });
});
