import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyOverride,
  applyStoredOverrides,
  isValidOverrideKey,
  resetOverride,
} from "../src/config/overrides.js";
import { makeConfig } from "./helpers.js";

const cfg = () => makeConfig(mkdtempSync(join(tmpdir(), "foreman-ovr-")));

describe("config overrides", () => {
  it("accepts only known keys", () => {
    expect(isValidOverrideKey("limits.max_cost_per_run_usd")).toBe(true);
    expect(isValidOverrideKey("roles.builder")).toBe(true);
    expect(isValidOverrideKey("memory.auto_push")).toBe(true);

    expect(isValidOverrideKey("limits.sandbox")).toBe(false);
    expect(isValidOverrideKey("memory.mirror_dir")).toBe(false);
    expect(isValidOverrideKey("nonsense")).toBe(false);
  });

  it("rejects a role name the engine doesn't have", () => {
    // a typo'd role used to be accepted and silently added as dead config
    expect(isValidOverrideKey("roles.bogus")).toBe(false);
    const c = cfg();
    const err = applyOverride(c, "roles.bogus", { options: ["pm"], active: "pm" });
    expect(err).toMatch(/unknown setting/);
    expect(c.models.roles).not.toHaveProperty("bogus");
  });

  it("applies a valid limit and rejects an out-of-range one", () => {
    const c = cfg();
    expect(applyOverride(c, "limits.max_cost_per_run_usd", 12.5)).toBeNull();
    expect(c.limits.max_cost_per_run_usd).toBe(12.5);

    expect(applyOverride(c, "limits.judge_pass_score", 9)).toMatch(/less than or equal to 1/);
    expect(c.limits.judge_pass_score).toBe(0.85); // untouched
  });

  it("rejects a role pointing at a slot that doesn't exist", () => {
    const c = cfg();
    const err = applyOverride(c, "roles.builder", { options: ["ghost"], active: "ghost" });
    expect(err).toMatch(/unknown slot "ghost"/);
    expect(c.models.roles.builder.options).toEqual(["builder_a"]);
  });

  it("rejects an active slot that isn't among its options", () => {
    const c = cfg();
    const err = applyOverride(c, "roles.builder", { options: ["builder_a"], active: "judge" });
    expect(err).toMatch(/not one of its options/);
  });

  it("reset restores the YAML value", () => {
    const c = cfg();
    const fresh = cfg();
    applyOverride(c, "limits.max_cost_per_run_usd", 99);
    expect(c.limits.max_cost_per_run_usd).toBe(99);

    expect(resetOverride(c, fresh, "limits.max_cost_per_run_usd")).toBeNull();
    expect(c.limits.max_cost_per_run_usd).toBe(fresh.limits.max_cost_per_run_usd);
  });

  it("reset reports clearly when the role is gone from YAML", () => {
    const c = cfg();
    const fresh = cfg();
    // simulate the role having been removed from models.yaml
    delete (fresh.models.roles as Record<string, unknown>).context;
    expect(resetOverride(c, fresh, "roles.context")).toMatch(/not defined in config\/models\.yaml/);
  });

  it("boot replay skips a since-invalidated override instead of throwing", () => {
    const c = cfg();
    const store = {
      listConfigOverrides: () => [
        { key: "limits.max_cost_per_run_usd", value: 7 },
        { key: "roles.builder", value: { options: ["deleted_slot"], active: "deleted_slot" } },
      ],
    };
    const problems = applyStoredOverrides(c, store);

    expect(c.limits.max_cost_per_run_usd).toBe(7);          // good one applied
    expect(problems).toHaveLength(1);                        // bad one reported
    expect(problems[0]).toMatch(/unknown slot "deleted_slot"/);
    expect(c.models.roles.builder.options).toEqual(["builder_a"]); // left intact
  });
});
