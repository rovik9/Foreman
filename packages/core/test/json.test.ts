import { z } from "zod";
import { describe, expect, it } from "vitest";
import { extractJson, parseJson } from "../src/agents/json.js";

describe("extractJson", () => {
  it("parses bare JSON", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it("parses fenced JSON", () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("parses JSON wrapped in prose", () => {
    expect(extractJson('Sure! {"a": {"b": [1,2]}} hope that helps')).toBe(
      '{"a": {"b": [1,2]}}',
    );
  });

  it("handles braces inside strings", () => {
    expect(extractJson('{"code": "if (x) { return }"}')).toBe(
      '{"code": "if (x) { return }"}',
    );
  });

  it("handles escaped quotes inside strings", () => {
    const raw = '{"s": "he said \\"hi\\"}"}';
    expect(extractJson(raw)).toBe(raw);
  });

  it("throws when no JSON present", () => {
    expect(() => extractJson("no json here")).toThrow(/no JSON found/);
  });

  it("throws on unbalanced JSON", () => {
    expect(() => extractJson('{"a": ')).toThrow(/unbalanced/);
  });
});

describe("parseJson", () => {
  it("validates against schema", () => {
    const schema = z.object({ n: z.number() });
    expect(parseJson('{"n": 5}', schema)).toEqual({ n: 5 });
    expect(() => parseJson('{"n": "x"}', schema)).toThrow();
  });
});
