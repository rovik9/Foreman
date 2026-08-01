import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectGates,
  gatesSummary,
  runGates,
  type ExecFn,
} from "../src/pipeline/verifier.js";

describe("detectGates", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-gates-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds no gates in an empty workspace", () => {
    expect(detectGates(dir)).toEqual([]);
  });

  it("finds no gates without package.json", () => {
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    expect(detectGates(dir)).toEqual([]);
  });

  it("detects tsc gate", () => {
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    expect(detectGates(dir)).toEqual([["npx", "tsc", "--noEmit"]]);
  });

  it("detects vitest gate from test dir", () => {
    writeFileSync(join(dir, "package.json"), "{}");
    mkdirSync(join(dir, "test"));
    expect(detectGates(dir)).toEqual([["npx", "vitest", "run"]]);
  });
});

describe("runGates", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foreman-gates-"));
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "tsconfig.json"), "{}");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes when exec returns 0", async () => {
    const exec: ExecFn = () => Promise.resolve({ code: 0, output: "ok" });
    const results = await runGates(dir, ["npx"], exec);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
  });

  it("fails when exec returns nonzero and keeps the output tail", async () => {
    const exec: ExecFn = () => Promise.resolve({ code: 2, output: "TS error" });
    const results = await runGates(dir, ["npx"], exec);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.output).toContain("TS error");
  });

  it("blocks binaries not on the allowlist", async () => {
    const exec: ExecFn = () => Promise.resolve({ code: 0, output: "" });
    const results = await runGates(dir, [], exec);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.output).toMatch(/not in sandbox allowlist/);
  });
});

describe("gatesSummary", () => {
  it("reports empty gates", () => {
    expect(gatesSummary([])).toMatch(/No deterministic gates/);
  });
});
