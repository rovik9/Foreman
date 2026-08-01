import { describe, expect, it } from "vitest";
import { RealtimeFeed } from "../src/agents/realtime.js";
import { makeRig } from "./helpers.js";

describe("RealtimeFeed", () => {
  it("fetches a digest through the realtime slot", async () => {
    const rig = makeRig({
      "rt-model": [
        JSON.stringify({
          digest: "ETH up 4% on ETF inflows",
          sources: ["feed"],
        }),
      ],
    });
    const feed = new RealtimeFeed(rig.harness);
    const run = rig.store.createRun("market check");
    const d = await feed.digest(run.id, "ETH market");
    expect(d.digest).toContain("ETH up 4%");
    expect(rig.mock.calls[0]!.model).toBe("rt-model");
  });

  it("serves repeat asks from the TTL cache without new provider calls", async () => {
    const rig = makeRig({
      "rt-model": [
        JSON.stringify({ digest: "fresh", sources: [] }),
      ],
    });
    const feed = new RealtimeFeed(rig.harness);
    const run = rig.store.createRun("x");
    await feed.digest(run.id, "same topic");
    const again = await feed.digest(run.id, "Same Topic"); // case-insensitive key
    expect(again.digest).toBe("fresh");
    expect(rig.mock.calls.filter((c) => c.model === "rt-model")).toHaveLength(1);
  });
});
