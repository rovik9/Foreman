/**
 * Keyless E2E demo: full pipeline with a scripted mock provider.
 * Run: pnpm demo   (from packages/core, or pnpm --filter @foreman/core demo)
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentHarness } from "../src/agents/harness.js";
import { loadConfig } from "../src/config/load.js";
import { ForemanBus } from "../src/events/bus.js";
import { runPipeline } from "../src/pipeline/runner.js";
import { MockProvider } from "../src/providers/mock.js";
import { Store } from "../src/store/db.js";

const config = loadConfig(resolve(import.meta.dirname, "../../../config"));
const dir = mkdtempSync(join(tmpdir(), "foreman-demo-"));
const store = new Store(join(dir, "demo.db"));
const bus = new ForemanBus();

// canned responses keyed by the model ids in config/models.yaml
const mock = new MockProvider({
  "claude-sonnet-5": [
    // pm
    JSON.stringify({
      summary: "Build a landing page for Foreman",
      requirements: ["Single index.html", "Dark theme", "Hero + features"],
      constraints: [],
      confidence: 0.95,
      questions: [],
    }),
    // judge (task 1, task 2)
    JSON.stringify({ score: 0.95, pass: true, feedback: "Meets criteria" }),
    JSON.stringify({ score: 0.9, pass: true, feedback: "Clean" }),
  ],
  "gpt-5.6-sol": [
    JSON.stringify({
      tasks: [
        {
          id: "t1",
          class: "build",
          description: "Create index.html with hero and features sections",
          acceptanceCriteria: [
            { type: "rubric", check: "Hero and features sections present" },
          ],
          deps: [],
        },
        {
          id: "t2",
          class: "build",
          description: "Create style.css with dark theme",
          acceptanceCriteria: [
            { type: "rubric", check: "Dark color variables defined" },
          ],
          deps: ["t1"],
        },
      ],
    }),
  ],
  "kimi-k3": [
    JSON.stringify({
      files: [
        {
          path: "index.html",
          content:
            "<!doctype html><html><head><title>Foreman</title><link rel=stylesheet href=style.css></head>" +
            "<body><section class=hero><h1>Foreman</h1><p>You talk to one guy. He runs the crew.</p></section>" +
            "<section class=features><h2>Features</h2><ul><li>Plan</li><li>Build</li><li>Verify</li></ul></section></body></html>",
        },
      ],
      notes: "landing page",
    }),
    JSON.stringify({
      files: [
        {
          path: "style.css",
          content:
            ":root{--bg:#0d1117;--fg:#e6edf3;--accent:#f0b429}body{background:var(--bg);color:var(--fg)}",
        },
      ],
      notes: "dark theme",
    }),
  ],
});

const harness = new AgentHarness(config, store, bus, { mock });

bus.subscribeAll((e) => {
  const data = JSON.stringify(e.data).slice(0, 120);
  console.log(`  [${e.at.slice(11, 19)}] ${e.type.padEnd(12)} ${data}`);
});

const run = store.createRun("Build a landing page for Foreman, dark theme");
store.addMessage({ runId: run.id, role: "user", content: run.prompt });

console.log("\n● FOREMAN demo — full pipeline, mock provider (no API keys burned)\n");
await runPipeline({ config, store, bus, harness }, run.id);

const final = store.getRun(run.id);
console.log(`\n  status:  ${final.status}`);
console.log(`  tasks:   ${store.listTasks(run.id).map((t) => `${t.description} [${t.status}]`).join(" | ")}`);
console.log(`  cost:    $${final.cost_usd.toFixed(4)} (mock-metered)`);
console.log(`  workspace: ${final.workspace_dir}\n`);
store.close();
