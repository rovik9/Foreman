import { describe, expect, it } from "vitest";
import { AssetStudio } from "../src/mcp/studio.js";

describe("AssetStudio", () => {
  it("degrades gracefully when the studio command does not exist", async () => {
    const studio = new AssetStudio(
      { type: "mcp", command: "definitely-not-a-real-foreman-studio", args: [] },
      "video",
    );
    const result = await studio.generate("a hero video");
    expect(result.ok).toBe(false);
    expect(result.artifacts).toEqual([]);
    expect(result.error).toMatch(/unavailable|timeout|ENOENT|spawn/i);
  }, 20_000);
});
