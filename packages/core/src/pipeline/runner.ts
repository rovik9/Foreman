import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { AgentHarness } from "../agents/harness.js";
import { planTasks } from "../agents/architect.js";
import { refinePrompt, type PmSpec } from "../agents/pm.js";
import { buildTask } from "../agents/builder.js";
import { judgeTask } from "../agents/judge.js";
import type { ForemanConfig } from "../config/schema.js";
import type { ForemanBus } from "../events/bus.js";
import type { Store } from "../store/db.js";
import { topoOrder } from "./dag.js";
import { gatesSummary, runGates } from "./verifier.js";

export interface RunnerDeps {
  config: ForemanConfig;
  store: Store;
  bus: ForemanBus;
  harness: AgentHarness;
}

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

/**
 * The pipeline: intake → plan → build/verify loop → report.
 * Resumable by design — stages already completed in the store are skipped,
 * so a run paused for budget or user input picks up where it left off.
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
      const userMessages = (store.listMessages(runId) as { role: string; content: string }[])
        .filter((m) => m.role === "user")
        .map((m) => m.content);

      spec = await refinePrompt(harness, runId, run.prompt, userMessages.slice(1));

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

      const drafts = await planTasks(harness, runId, spec);
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

    // ---- stage 2: execute DAG (sequential for Phase 1) ----
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
        const steering = (store.listMessages(runId) as { role: string; content: string }[])
          .filter((m) => m.role === "user")
          .slice(-5)
          .map((m) => m.content);

        const specForBuild: PmSpec = spec ?? {
          summary: run.prompt,
          requirements: [run.prompt],
          constraints: [],
          confidence: 1,
          questions: [],
        };

        await buildTask(
          harness,
          runId,
          task,
          specForBuild,
          workspace,
          feedback,
          steering,
        );

        store.updateTask(task.id, { status: "verifying" });
        bus.emit({ type: "task_status", runId, taskId: task.id, data: { status: "verifying", attempt } });

        const gates = await runGates(workspace, limits.sandbox.shell_allowlist);
        bus.emit({ type: "gate", runId, taskId: task.id, data: gates });

        const freshTask = store.getTask(task.id);
        const verdict = await judgeTask(
          harness,
          runId,
          freshTask,
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
  }
}
