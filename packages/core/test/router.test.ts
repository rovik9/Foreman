import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Router } from "../src/router/router.js";
import { makeConfig } from "./helpers.js";

describe("Router", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-router-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("picks the cheapest slot in a class", () => {
    const router = new Router(makeConfig(dir));
    expect(router.pick("build")).toBe("builder_a"); // weight 1.0
    expect(router.pick("plan")).toBe("architect");
    expect(router.pick("fetch")).toBe("realtime"); // weight 0.2
  });

  it("orders fallback chains cheapest-first", () => {
    const config = makeConfig(dir);
    config.models.tiers.build = ["builder_a", "judge"]; // 1.0 vs 1.5
    const router = new Router(config);
    expect(router.chain("build")).toEqual(["builder_a", "judge"]);
  });

  it("throws on an unconfigured class", () => {
    const config = makeConfig(dir);
    delete config.models.tiers.critique;
    const router = new Router(config);
    expect(() => router.pick("critique")).toThrow(/no slots configured/);
  });
});
