import { describe, expect, it } from "vitest";
import { distillRun } from "../src/memory/distiller.js";
import { reviewMemories } from "../src/memory/review.js";
import { makeRig } from "./helpers.js";

describe("memory governance", () => {
  it("distilled entries start pending and are invisible to recall", async () => {
    const rig = makeRig({
      "memo-model": [
        JSON.stringify({
          memories: [
            { kind: "fact", text: "The fund uses Foundry for contracts", tags: ["defi"], confidence: 0.9 },
          ],
        }),
      ],
    });
    const run = rig.store.createRun("build defi stuff with foundry");
    rig.store.addMessage({
      runId: run.id,
      role: "user",
      content:
        "Build the fund's contract suite with Foundry. " +
        "We discussed architecture, testing with forge, slither gates, " +
        "deployment order, gas optimization, invariant coverage, and the " +
        "full audit checklist for the vault and strategy modules.",
    });

    const added = await distillRun(rig.harness, rig.store, run.id);
    expect(added).toBe(1);

    // pending → recall must NOT see it
    expect(rig.store.searchMemories("foundry")).toHaveLength(0);
    expect(rig.store.listPendingMemories()).toHaveLength(1);
  });

  it("interface review approves/rejects/parks-critical correctly", async () => {
    const rig = makeRig({
      "memo-model": [
        JSON.stringify({
          memories: [
            { kind: "preference", text: "User likes dark themes", tags: [], confidence: 0.9 },
            { kind: "fact", text: "It rained on tuesday", tags: [], confidence: 0.5 },
            { kind: "decision", text: "Rotate all API keys monthly", tags: ["security"], confidence: 0.9 },
          ],
        }),
      ],
      "pm-model": [
        JSON.stringify({
          decisions: [
            { index: 0, decision: "approve", reason: "durable preference" },
            { index: 1, decision: "reject", reason: "trivia" },
            { index: 2, decision: "critical", reason: "security policy — user must confirm" },
          ],
        }),
      ],
    });
    const run = rig.store.createRun("x");
    rig.store.addMessage({
      runId: run.id,
      role: "user",
      content:
        "A long conversation about preferences, project facts, and security policy. " +
        "We covered UI taste, how the fund operates, and how credentials " +
        "should be rotated and stored across the infrastructure.",
    });

    await distillRun(rig.harness, rig.store, run.id);
    const counts = await reviewMemories(rig.harness, rig.store, run.id);

    expect(counts).toEqual({ approved: 1, rejected: 1, critical: 1 });

    // approved is recallable; rejected and awaiting_user are not
    const hits = rig.store.searchMemories("dark themes");
    expect(hits).toHaveLength(1);
    expect(rig.store.searchMemories("rained")).toHaveLength(0);
    expect(rig.store.searchMemories("rotate keys")).toHaveLength(0);

    // critical waits for the human decision endpoint path
    const all = rig.store.listMemories(10);
    expect(all.find((m) => m.text.includes("Rotate"))!.status ?? "awaiting_user").toBeTruthy();
    expect(rig.store.listPendingMemories()).toHaveLength(0);
  });

  it("user decision resolves a critical memory", async () => {
    const rig = makeRig({});
    const id = rig.store.addMemory({
      kind: "decision",
      text: "Move the fund to a new chain",
      status: "awaiting_user",
      proposedBy: "interface",
    });
    expect(rig.store.searchMemories("new chain")).toHaveLength(0);

    rig.store.setMemoryStatus(id, "approved");
    expect(rig.store.searchMemories("new chain")).toHaveLength(1);
  });
});
