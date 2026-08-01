import { join } from "node:path";
import { distillRun } from "../memory/distiller.js";
import { reviewMemories } from "../memory/review.js";
import type { RunnerDeps } from "../pipeline/runner.js";
import { syncProductRepo } from "./gitsync.js";
import { renderJournal, writeJournal } from "./journal.js";

/**
 * Post-run documentation — the chain of custody. Runs on completion AND
 * failure (failures carry the lessons). Three steps, each best-effort:
 * 1. distill durable memories (cheapest slot) into SQLite+FTS and markdown
 * 2. render the run journal (who/what/why/how/cost) to markdown
 * 3. git-commit the product's memory repo; push if configured
 */
export async function documentRun(
  deps: RunnerDeps,
  runId: string,
): Promise<void> {
  const { store, harness, config } = deps;
  const run = store.getRun(runId);
  const product = run.product ?? "misc";

  // product repo root: the project's custom memory folder wins
  let repoDir = deps.memoryDir
    ? join(deps.memoryDir, "products", product)
    : undefined;
  try {
    const p = store.getProject(product);
    if (p.memory_dir) repoDir = p.memory_dir;
  } catch {
    // not a registered project — default layout
  }

  try {
    const mirrorDir = repoDir ? join(repoDir, "memory") : undefined;
    const added = await distillRun(harness, store, runId, mirrorDir);
    if (added > 0) {
      store.addMessage({
        runId,
        role: "system",
        content: `Memory: +${added} durable entries proposed`,
      });
      deps.bus.emit({ type: "message", runId, data: { role: "memory", added } });
      // governance: the Interface AI approves writes; critical goes to the
      // user — unless the run is yolo (bypass all permissions)
      await reviewMemories(harness, store, runId, { yolo: run.yolo === 1 });
    }
  } catch (err) {
    store.addMessage({
      runId,
      role: "system",
      content: `memory distillation skipped: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (!repoDir) return;

  try {
    writeJournal(
      repoDir,
      ".",
      runId,
      renderJournal(store, runId),
    );
  } catch (err) {
    store.addMessage({
      runId,
      role: "system",
      content: `journal write failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const remote = config.memory.auto_push
    ? config.memory.remotes[product]
    : undefined;
  const sync = syncProductRepo(
    repoDir,
    `run ${runId.slice(0, 8)} — ${run.status} — $${run.cost_usd.toFixed(4)}`,
    remote,
  );
  if (sync.error) {
    store.addMessage({
      runId,
      role: "system",
      content: `memory git sync: ${sync.error}`,
    });
  }
}
