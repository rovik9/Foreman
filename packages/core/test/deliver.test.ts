import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectFiles, deliverRunCode, diffRunAgainstCheckout } from "../src/server/deliver.js";
import type { ProjectRow, RunRow } from "../src/store/db.js";

function project(dirs: string[]): ProjectRow {
  return {
    id: "p", name: "P", slug: "p", repo_url: null, memory_dir: null, memory_repo: null,
    workspace_dirs: JSON.stringify(dirs), code_repos: "[]", monorepo: 1,
    created_at: "",
  };
}

function run(workspace: string | null): RunRow {
  return {
    id: "run-1234abcd", prompt: "build the thing", status: "completed",
    workspace_dir: workspace, product: "p", mode: "full", yolo: 0, budget_raise: 0,
    approved: 1, cost_usd: 1.5, created_at: "", updated_at: "",
  };
}

describe("deliverRunCode", () => {
  let ws: string;
  let checkout: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "foreman-ws-"));
    checkout = mkdtempSync(join(tmpdir(), "foreman-checkout-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  });

  it("copies the built code into the project checkout and commits it", () => {
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src/index.ts"), "export const hi = 1;");
    writeFileSync(join(ws, "README.md"), "# built by foreman");

    const result = deliverRunCode(run(ws), project([checkout]));

    expect(result.delivered).toBe(true);
    expect(result.files).toBe(2);
    expect(result.committed).toBe(true);
    expect(readFileSync(join(checkout, "src/index.ts"), "utf8")).toBe("export const hi = 1;");
    expect(readFileSync(join(checkout, "README.md"), "utf8")).toBe("# built by foreman");

    const log = execFileSync("git", ["log", "--oneline"], { cwd: checkout, encoding: "utf8" });
    expect(log).toContain("build the thing");
  });

  it("never ships node_modules or a nested .git", () => {
    mkdirSync(join(ws, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(ws, "node_modules/pkg/index.js"), "huge");
    mkdirSync(join(ws, ".git"), { recursive: true });
    writeFileSync(join(ws, ".git/config"), "nope");
    writeFileSync(join(ws, "app.js"), "keep me");

    expect(collectFiles(ws)).toEqual(["app.js"]);

    deliverRunCode(run(ws), project([checkout]));
    expect(existsSync(join(checkout, "node_modules"))).toBe(false);
    expect(existsSync(join(checkout, "app.js"))).toBe(true);
    // the checkout has its own .git (syncProductRepo inits one); what must
    // never happen is the run's .git being copied over the top of it
    expect(readFileSync(join(checkout, ".git/config"), "utf8")).not.toContain("nope");
  });

  it("updates a file that already exists in the checkout", () => {
    writeFileSync(join(checkout, "app.js"), "old version");
    writeFileSync(join(ws, "app.js"), "new version");

    const result = deliverRunCode(run(ws), project([checkout]));

    expect(result.delivered).toBe(true);
    expect(readFileSync(join(checkout, "app.js"), "utf8")).toBe("new version");
  });

  it("explains itself when the project has no local folder", () => {
    writeFileSync(join(ws, "a.js"), "x");
    const result = deliverRunCode(run(ws), project([]));
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/no local folder/);
  });

  it("explains itself when the run never made a workspace", () => {
    const result = deliverRunCode(run(null), project([checkout]));
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/no workspace/);
  });

  it("reports nothing-to-deliver rather than an empty commit", () => {
    const result = deliverRunCode(run(ws), project([checkout]));
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/nothing to deliver/);
  });

  it("diffs new and modified files against the checkout", () => {
    writeFileSync(join(checkout, "existing.js"), "line one\nline two\nline three");
    writeFileSync(join(ws, "existing.js"), "line one\nline TWO changed\nline three");
    writeFileSync(join(ws, "brand-new.js"), "hello\nworld");
    writeFileSync(join(checkout, "untouched.js"), "same");
    writeFileSync(join(ws, "untouched.js"), "same");

    const diffs = diffRunAgainstCheckout(run(ws), project([checkout]));
    const by = (p: string) => diffs.find((d) => d.path === p)!;

    expect(by("brand-new.js").status).toBe("added");
    expect(by("brand-new.js").added).toBe(2);

    const mod = by("existing.js");
    expect(mod.status).toBe("modified");
    expect(mod.added).toBe(1);
    expect(mod.removed).toBe(1);
    expect(mod.hunk).toContain("- line two");
    expect(mod.hunk).toContain("+ line TWO changed");
    expect(mod.hunk).toContain("  line one"); // unchanged context kept

    expect(by("untouched.js").status).toBe("unchanged");
  });

  it("treats everything as added when the project has no checkout", () => {
    writeFileSync(join(ws, "a.js"), "x");
    const diffs = diffRunAgainstCheckout(run(ws), project([]));
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.status).toBe("added");
  });

  it("handles a run with no registered project", () => {
    writeFileSync(join(ws, "a.js"), "x");
    const result = deliverRunCode(run(ws), undefined);
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/no local folder/);
  });
});
