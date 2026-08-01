import { describe, expect, it } from "vitest";
import { topoOrder } from "../src/pipeline/dag.js";

describe("topoOrder", () => {
  it("orders dependencies first", () => {
    const nodes = [
      { id: "c", deps: ["b"] },
      { id: "a", deps: [] },
      { id: "b", deps: ["a"] },
    ];
    expect(topoOrder(nodes).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("handles independent nodes", () => {
    const nodes = [{ id: "a", deps: [] }, { id: "b", deps: [] }];
    expect(topoOrder(nodes)).toHaveLength(2);
  });

  it("throws on unknown dep", () => {
    expect(() => topoOrder([{ id: "a", deps: ["ghost"] }])).toThrow(
      /unknown task "ghost"/,
    );
  });

  it("throws on cycle", () => {
    const nodes = [
      { id: "a", deps: ["b"] },
      { id: "b", deps: ["a"] },
    ];
    expect(() => topoOrder(nodes)).toThrow(/cycle detected/);
  });

  it("throws on self-dependency", () => {
    expect(() => topoOrder([{ id: "a", deps: ["a"] }])).toThrow(/cycle/);
  });
});
