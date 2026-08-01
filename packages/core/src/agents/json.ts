import type { z, ZodTypeAny } from "zod";

/**
 * Pulls the first JSON value out of a model response that may be fenced
 * (```json ... ```) or wrapped in prose. Finds the earliest opener and
 * balance-scans to its matching closer.
 */
export function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fence?.[1] ?? text).trim();

  const openIdx = candidate.search(/[{[]/);
  if (openIdx === -1) throw new Error("no JSON found in model output");

  const open = candidate[openIdx]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = openIdx; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) return candidate.slice(openIdx, i + 1);
    }
  }
  throw new Error("unbalanced JSON in model output");
}

export function parseJson<S extends ZodTypeAny>(text: string, schema: S): z.output<S> {
  return schema.parse(JSON.parse(extractJson(text)));
}
