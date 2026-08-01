import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../store/db.js";

/**
 * Renders the run journal — the chain of custody for one run:
 * who (slot+model) did what, why (spec/decisions), how (iterations,
 * feedback), and what it cost. Pure markdown, human-first.
 */
export function renderJournal(store: Store, runId: string): string {
  const run = store.getRun(runId);
  const tasks = store.listTasks(runId);
  const messages = store.listMessages(runId) as {
    role: string;
    slot: string | null;
    content: string;
    created_at: string;
  }[];
  const costs = store.listCosts(runId);
  const artifacts = store.listArtifacts(runId) as {
    kind: string;
    path: string;
  }[];

  const lines: string[] = [
    `# Run Journal — ${run.prompt.split("\n")[0]!.slice(0, 80)}`,
    "",
    `- **run:** \`${run.id}\``,
    `- **product:** ${run.product ?? "misc"}`,
    `- **status:** ${run.status}`,
    `- **started:** ${run.created_at} · **updated:** ${run.updated_at}`,
    `- **total cost:** $${run.cost_usd.toFixed(4)}`,
    "",
    `## Prompt`,
    "",
    run.prompt,
    "",
    `## Plan & execution`,
    "",
    "| # | task | class | slot | status | iterations | cost |",
    "|---|------|-------|------|--------|-----------|------|",
    ...tasks.map(
      (t) =>
        `| ${t.seq} | ${t.description.replace(/\|/g, "\\|")} | ${t.class} | ${t.slot ?? "-"} | ${t.status} | ${t.iterations} | $${t.cost_usd.toFixed(4)} |`,
    ),
    "",
  ];

  const decisions = messages.filter((m) =>
    ["user", "pm", "system"].includes(m.role),
  );
  if (decisions.length > 0) {
    lines.push("## Decisions, steering & escalations", "");
    for (const m of decisions) {
      lines.push(
        `- \`${m.created_at}\` **${m.role}**: ${m.content.slice(0, 400).replace(/\n/g, " ")}`,
      );
    }
    lines.push("");
  }

  if (artifacts.length > 0) {
    lines.push("## Artifacts", "");
    for (const a of artifacts) lines.push(`- [${a.kind}] ${a.path}`);
    lines.push("");
  }

  lines.push(
    "## Cost ledger",
    "",
    "| slot | model | tokens (in/out) | $ |",
    "|------|-------|-----------------|---|",
    ...costs.map(
      (c) =>
        `| ${c.slot} | ${c.model} | ${c.prompt_tokens}/${c.completion_tokens} | $${c.cost_usd.toFixed(4)} |`,
    ),
    "",
  );

  return lines.join("\n");
}

export function writeJournal(
  memoryRoot: string,
  product: string,
  runId: string,
  markdown: string,
): string {
  const dir = join(memoryRoot, "products", product, "journal");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const file = join(dir, `${stamp}_${runId.slice(0, 8)}.md`);
  writeFileSync(file, markdown);
  return file;
}
