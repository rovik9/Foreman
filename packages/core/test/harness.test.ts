import { describe, expect, it } from "vitest";
import type { ForemanEvent } from "../src/events/bus.js";
import { makeRig } from "./helpers.js";

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
});
