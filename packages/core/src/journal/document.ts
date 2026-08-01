import { join } from "node:path";
import { distillRun } from "../memory/distiller.js";
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

  try {
    const mirrorDir = deps.memoryDir
      ? join(deps.memoryDir, "products", product, "memory")
      : undefined;
    const added = await distillRun(harness, store, runId, mirrorDir);
    if (added > 0) {
      store.addMessage({
        runId,
        role: "system",
        content: `Memory: +${added} durable entries`,
      });
      deps.bus.emit({ type: "message", runId, data: { role: "memory", added } });
    }
  } catch (err) {
    store.addMessage({
      runId,
      role: "system",
      content: `memory distillation skipped: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (!deps.memoryDir) return;

  try {
    writeJournal(
      deps.memoryDir,
      product,
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

  const repoDir = join(deps.memoryDir, "products", product);
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
