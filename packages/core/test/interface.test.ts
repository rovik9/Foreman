import { describe, expect, it } from "vitest";
import { routeTasks } from "../src/agents/interface.js";
import { makeRig } from "./helpers.js";

const DRAFTS = [
  {
    id: "t1",
    class: "build" as const,
    description: "Write the landing page HTML",
    acceptanceCriteria: [{ type: "rubric" as const, check: "has hero" }],
    deps: [],
  },
  {
    id: "t2",
    class: "build" as const,
    description: "Write the CSS",
    acceptanceCriteria: [{ type: "rubric" as const, check: "dark theme" }],
    deps: ["t1"],
  },
];

describe("routeTasks (Interface AI)", () => {
  it("skips the model call when every role has a single option", async () => {
    const rig = makeRig({}); // single-option builder role in fixture config
    const run = rig.store.createRun("x");
    const result = await routeTasks(rig.harness, run.id, DRAFTS, rig.config);
    expect(result.slots.get("t1")).toBe("builder_a");
    expect(result.slots.get("t2")).toBe("builder_a");
    expect(rig.mock.calls).toHaveLength(0); // zero tokens spent
  });

  it("honors a valid interface choice and captures the reason", async () => {
    const rig = makeRig({
      "pm-model": [
        JSON.stringify({
          assignments: [
            { id: "t1", slot: "builder_b", reason: "markup is easy, fast model suffices" },
            { id: "t2", slot: "builder_a", reason: "design nuance needs the stronger code model" },
          ],
        }),
      ],
    });
    // give the builder role two options so routing actually engages
    rig.config.models.roles.builder = { options: ["builder_a", "builder_b"], active: "builder_a" };
    rig.config.models.slots.builder_b = { provider: "moonshot", model: "build-b-model", via: "moonshot" };

    const run = rig.store.createRun("x");
    const result = await routeTasks(rig.harness, run.id, DRAFTS, rig.config);

    expect(result.slots.get("t1")).toBe("builder_b");
    expect(result.slots.get("t2")).toBe("builder_a");
    expect(result.reasons.get("t1")).toContain("fast model");
  });

  it("falls back to the role active slot on an invalid pick", async () => {
    const rig = makeRig({
      "pm-model": [
        JSON.stringify({
          assignments: [
            { id: "t1", slot: "gpt-9000-ultra", reason: "invented a slot" },
            { id: "t2", slot: "builder_a", reason: "fine" },
          ],
        }),
      ],
    });
    rig.config.models.roles.builder = { options: ["builder_a", "builder_b"], active: "builder_a" };
    rig.config.models.slots.builder_b = { provider: "moonshot", model: "build-b-model", via: "moonshot" };

    const run = rig.store.createRun("x");
    const result = await routeTasks(rig.harness, run.id, DRAFTS, rig.config);

    expect(result.slots.get("t1")).toBe("builder_a"); // fell back
    expect(result.reasons.get("t1")).toContain("invalid slot");
    expect(result.slots.get("t2")).toBe("builder_a");
  });
});
