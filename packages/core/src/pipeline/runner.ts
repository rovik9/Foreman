import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { AgentHarness } from "../agents/harness.js";
import { planTasks } from "../agents/architect.js";
import { refinePrompt, type PmSpec } from "../agents/pm.js";
import { buildTask } from "../agents/builder.js";
import { judgeTask } from "../agents/judge.js";
import { getRealtimeFeed } from "../agents/realtime.js";
import type { ForemanConfig } from "../config/schema.js";
import type { ForemanBus } from "../events/bus.js";
import { documentRun } from "../journal/document.js";
import { AssetStudio } from "../mcp/studio.js";
import { recallBlock } from "../memory/recall.js";
import { Router } from "../router/router.js";
import type { Store } from "../store/db.js";
import { topoOrder } from "./dag.js";
import { gatesSummary, runGates } from "./verifier.js";

export interface RunnerDeps {
  config: ForemanConfig;
  store: Store;
  bus: ForemanBus;
  harness: AgentHarness;
  /** Local memory vault root (from config.memory.mirror_dir, resolved). */
  memoryDir?: string;
}

const REALTIME_TRIGGER =
  /\b(news|trends?|markets?|latest|today|current events?|prices?)\b/i;
const ASSET_TRIGGER = /(video|audio|image|logo|asset|thumbnail|clip)/i;

function listFiles(dir: string, base: string = dir): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

function recentUserSteering(store: Store, runId: string): string[] {
  return (store.listMessages(runId) as { role: string; content: string }[])
    .filter((m) => m.role === "user")
    .slice(-5)
    .map((m) => m.content);
}

/**
 * The pipeline: intake (memory-recalled) → plan (router-priced, realtime-fed)
 * → build/verify loop → asset studios → report → document (memory + journal
 * + git sync). Resumable by design — completed stages in the store are
 * skipped, so a paused run picks up where it left off.
 */
export async function runPipeline(deps: RunnerDeps, runId: string): Promise<void> {
  const { config, store, bus, harness } = deps;
  const { limits } = config;
  const run = store.getRun(runId);

  try {
    store.setRunStatus(runId, "running");
    bus.emit({ type: "run_status", runId, data: { status: "running" } });

    // ---- stage 1: intake + planning (skipped if tasks already exist) ----
    let tasks = store.listTasks(runId);
    let spec: PmSpec | null = null;

    if (tasks.length === 0) {
      const userMessages = recentUserSteering(store, runId);

      const memory = recallBlock(store, run.prompt);
      spec = await refinePrompt(
        harness,
        runId,
        run.prompt,
        userMessages.slice(1),
        memory,
      );
      store.setRunProduct(runId, spec.product);

      if (
        spec.confidence < limits.pm_clarify_confidence_threshold &&
        spec.questions.length > 0
      ) {
        store.setRunStatus(runId, "awaiting_user");
        bus.emit({
          type: "run_status",
          runId,
          data: { status: "awaiting_user", questions: spec.questions },
        });
        store.addMessage({
          runId,
          role: "pm",
          slot: "pm",
          content: `I need clarification before planning:\n${spec.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
        });
        return;
      }

      // realtime context for time-sensitive work (best-effort)
      const specText = `${spec.summary} ${spec.requirements.join(" ")}`;
      let realtimeContext: string | undefined;
      if (REALTIME_TRIGGER.test(specText)) {
        try {
          const digest = await getRealtimeFeed(harness).digest(runId, spec.summary);
          realtimeContext = digest.digest;
          bus.emit({
            type: "message",
            runId,
            data: { role: "realtime", digest: digest.digest },
          });
        } catch {
          // the feed is best-effort; planning proceeds without it
        }
      }

      const drafts = await planTasks(harness, runId, spec, realtimeContext);
      const router = new Router(config);
      const idMap = new Map<string, string>();
      for (const [i, d] of drafts.entries()) {
        const row = store.createTask({
          runId,
          seq: i + 1,
          class: d.class,
          description: d.description,
          acceptanceCriteria: d.acceptanceCriteria,
          deps: [],
        });
        store.updateTask(row.id, { slot: router.pick(d.class) });
        idMap.set(d.id, row.id);
      }
      // remap deps from architect-local ids to store uuids
      for (const d of drafts) {
        const mapped = d.deps.map((x) => {
          const uuid = idMap.get(x);
          if (!uuid) throw new Error(`architect emitted unknown dep "${x}"`);
          return uuid;
        });
        store.setTaskDeps(idMap.get(d.id)!, mapped);
      }
      tasks = store.listTasks(runId);
      bus.emit({
        type: "run_status",
        runId,
        data: { status: "planned", taskCount: tasks.length, spec },
      });
    }

    // ---- stage 2: execute DAG (sequential for now) ----
    const workspace = join(
      limits.sandbox.workspace_root,
      runId,
      "workspace",
    );
    mkdirSync(workspace, { recursive: true });
    store.setRunWorkspace(runId, workspace);

    const order = topoOrder(
      tasks.map((t) => ({ id: t.id, deps: JSON.parse(t.deps) as string[] })),
    );
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const ordered = order.map((o) => byId.get(o.id)!);

    for (const task of ordered) {
      if (task.status === "passed") continue;

      // /stop from any surface halts at the next task boundary
      if (store.getRun(runId).status === "stopped") {
        bus.emit({ type: "run_status", runId, data: { status: "stopped" } });
        return;
      }

      // run-level budget gate
      if (store.runCost(runId) >= limits.max_cost_per_run_usd) {
        store.setRunStatus(runId, "paused_budget");
        bus.emit({
          type: "run_status",
          runId,
          data: { status: "paused_budget", costUsd: store.runCost(runId) },
        });
        return;
      }

      store.updateTask(task.id, { status: "running" });
      bus.emit({ type: "task_status", runId, taskId: task.id, data: { status: "running" } });

      let feedback: string | undefined;
      let passed = false;
      const maxIter = limits.max_iterations_per_task;

      for (let attempt = 1; attempt <= maxIter; attempt++) {
        // per-task budget gate
        if (store.getTask(task.id).cost_usd >= limits.max_cost_per_task_usd) break;

        store.updateTask(task.id, { iterations: attempt });

        const specForBuild: PmSpec = spec ?? {
          summary: run.prompt,
          product: run.product ?? "misc",
          requirements: [run.prompt],
          constraints: [],
          confidence: 1,
          questions: [],
        };

        const built = await buildTask(
          harness,
          runId,
          task,
          specForBuild,
          workspace,
          feedback,
          recentUserSteering(store, runId),
        );

        // register everything the builder produced
        for (const f of built.files) {
          store.addArtifact({ runId, taskId: task.id, path: f.path, kind: "code" });
          bus.emit({
            type: "artifact",
            runId,
            taskId: task.id,
            data: { path: f.path, kind: "code" },
          });
        }

        store.updateTask(task.id, { status: "verifying" });
        bus.emit({ type: "task_status", runId, taskId: task.id, data: { status: "verifying", attempt } });

        const gates = await runGates(workspace, limits.sandbox.shell_allowlist);
        bus.emit({ type: "gate", runId, taskId: task.id, data: gates });

        const verdict = await judgeTask(
          harness,
          runId,
          store.getTask(task.id),
          gatesSummary(gates),
          listFiles(workspace),
        );
        bus.emit({ type: "judge", runId, taskId: task.id, data: verdict });

        const gatesOk = gates.every((g) => g.ok);
        if (gatesOk && verdict.pass && verdict.score >= limits.judge_pass_score) {
          passed = true;
          break;
        }
        feedback = [
          gatesOk ? "" : `Gate failures:\n${gatesSummary(gates)}`,
          `Judge (score ${verdict.score}): ${verdict.feedback}`,
        ]
          .filter(Boolean)
          .join("\n\n");
      }

      if (!passed) {
        store.updateTask(task.id, { status: "escalated" });
        store.setRunStatus(runId, "awaiting_user");
        store.addMessage({
          runId,
          taskId: task.id,
          role: "system",
          content: `Task "${task.description}" failed after ${maxIter} attempts or hit its budget. Last feedback:\n${feedback ?? "budget exhausted"}\n\nReply with guidance, or say "retry" / "skip".`,
        });
        bus.emit({
          type: "task_status",
          runId,
          taskId: task.id,
          data: { status: "escalated", feedback },
        });
        bus.emit({ type: "run_status", runId, data: { status: "awaiting_user" } });
        return;
      }

      store.updateTask(task.id, { status: "passed", output: feedback ?? null });
      bus.emit({ type: "task_status", runId, taskId: task.id, data: { status: "passed" } });
    }

    // ---- asset studios (best-effort; never blocks the report) ----
    const assetText = spec
      ? `${spec.summary} ${spec.requirements.join(" ")}`
      : run.prompt;
    if (ASSET_TRIGGER.test(assetText)) {
      for (const [name, studioCfg] of Object.entries(config.models.asset_studios)) {
        const kind = (["video", "audio", "image"].includes(name) ? name : "image") as
          | "video"
          | "audio"
          | "image";
        const result = await new AssetStudio(studioCfg, kind).generate(
          spec?.summary ?? run.prompt,
        );
        if (result.ok) {
          for (const a of result.artifacts) {
            store.addArtifact({ runId, path: a.path, kind: a.kind });
            bus.emit({ type: "artifact", runId, data: a });
          }
        } else if (result.error) {
          store.addMessage({
            runId,
            role: "system",
            content: `Asset studio "${name}" skipped: ${result.error}`,
          });
        }
      }
    }

    // ---- stage 3: report ----
    store.setRunStatus(runId, "completed");
    store.addMessage({
      runId,
      role: "pm",
      slot: "pm",
      content: `Run complete. ${ordered.length} task(s) passed. Total cost: $${store.runCost(runId).toFixed(4)}. Workspace: ${workspace}`,
    });
    bus.emit({
      type: "run_status",
      runId,
      data: { status: "completed", costUsd: store.runCost(runId) },
    });

    // ---- stage 4: document (memory distill + journal + git sync) ----
    await documentRun(deps, runId);
  } catch (err) {
    store.setRunStatus(runId, "failed");
    store.addMessage({
      runId,
      role: "system",
      content: `Run failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    bus.emit({
      type: "run_status",
      runId,
      data: { status: "failed", error: err instanceof Error ? err.message : String(err) },
    });
    // failures carry the lessons — document them too
    try {
      await documentRun(deps, runId);
    } catch {
      // documentation must never mask the original failure
    }
  }
}
