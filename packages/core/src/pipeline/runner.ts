import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { AgentHarness } from "../agents/harness.js";
import { planTasks } from "../agents/architect.js";
import { refinePrompt, type PmSpec } from "../agents/pm.js";
import { buildTaskAgentic } from "../agents/builder.js";
import { docTask } from "../agents/doc.js";
import { judgeTask } from "../agents/judge.js";
import { getRealtimeFeed } from "../agents/realtime.js";
import { discussWithUser, routeTasks } from "../agents/interface.js";
import { synthesizeContext, CONTEXT_SYNTH_THRESHOLD } from "../agents/context.js";
import type { ForemanConfig } from "../config/schema.js";
import type { ForemanBus } from "../events/bus.js";
import { documentRun } from "../journal/document.js";
import { AssetStudio } from "../mcp/studio.js";
import { loadMcpTools } from "../mcp/tools.js";
import { recallBlock } from "../memory/recall.js";
import { Router } from "../router/router.js";
import { forgetWorkspace, type McpTool } from "../agents/tools.js";
import type { MessageRow, Store, TaskRow } from "../store/db.js";
import { topoOrder } from "./dag.js";
import { gatesSummary, runGates } from "./verifier.js";

export interface RunnerDeps {
  config: ForemanConfig;
  store: Store;
  bus: ForemanBus;
  harness: AgentHarness;
  /** Local memory vault root (from config.memory.mirror_dir, resolved). */
  memoryDir?: string;
  /** Root under which project code repos get cloned (server/app.ts POST /projects). */
  projectsDir?: string;
  /** config/ directory, so a cleared override can be re-read from YAML. */
  configDir?: string;
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

    // ---- stage 0: discuss — the Interface AI talks it through with the user
    // first, and nothing downstream runs until they explicitly approve. The
    // user's message is never blind-dumped into the whole crew. ----
    if (run.mode === "discuss" && !run.approved && !run.yolo) {
      const transcript = (store.listMessages(runId) as MessageRow[])
        .filter((m) => ["user", "interface", "pm"].includes(m.role))
        .map((m) => ({ role: m.role, content: m.content }));

      const turn = await discussWithUser(harness, runId, transcript);
      store.addMessage({
        runId,
        role: "interface",
        slot: harness.roleSlot("interface"),
        content: turn.reply,
      });
      store.setRunStatus(runId, "awaiting_user");
      bus.emit({
        type: "message",
        runId,
        data: { role: "interface", content: turn.reply },
      });
      bus.emit({
        type: "run_status",
        runId,
        data: { status: "awaiting_user", phase: "discuss", ready: turn.ready },
      });
      return;
    }

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
      // a project pre-selected at dispatch wins over the PM's suggestion
      if (!run.product) {
        store.setRunProduct(runId, spec.product);
      }

      if (
        !run.yolo &&
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

      const drafts = await planTasks(harness, runId, spec, [
        realtimeContext ? `Realtime context (current as of now):\n${realtimeContext}` : "",
        memory
          ? memory.length > CONTEXT_SYNTH_THRESHOLD
            ? await synthesizeContext(harness, runId, spec.summary, memory).catch(() => `Shared project memory (read-only):\n${memory}`)
            : `Shared project memory (read-only):\n${memory}`
          : "",
      ].filter(Boolean).join("\n\n") || undefined);

      // the Interface AI routes each task across preselected options,
      // with logged reasoning; static router is the fallback
      let slots: Map<string, string>;
      let reasons = new Map<string, string>();
      try {
        ({ slots, reasons } = await routeTasks(harness, runId, drafts, config));
      } catch {
        const router = new Router(config);
        slots = new Map(drafts.map((d) => [d.id, router.pick(d.class)]));
      }

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
        const slot = slots.get(d.id)!;
        store.updateTask(row.id, { slot });
        if (reasons.get(d.id)) {
          store.addMessage({
            runId,
            role: "interface",
            content: `${d.id} → ${slot}: ${reasons.get(d.id)}`,
          });
        }
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

      // plan mode: hold for user approval before any execution
      if (run.mode === "plan" && !run.yolo) {
        store.setRunStatus(runId, "awaiting_user");
        store.addMessage({
          runId,
          role: "interface",
          content:
            `Plan ready — ${tasks.length} task(s):\n` +
            tasks.map((t) => `${t.seq}. [${t.class}→${t.slot}] ${t.description}`).join("\n") +
            `\n\nReply "build" to execute, or steer the plan.`,
        });
        bus.emit({
          type: "run_status",
          runId,
          data: { status: "awaiting_user", mode: "plan" },
        });
        return;
      }
    }

    // ---- stage 2: execute DAG (level-parallel) ----
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
    const depsOf = new Map(ordered.map((t) => [t.id, JSON.parse(t.deps) as string[]]));

    const specForBuild: PmSpec = spec ?? {
      summary: run.prompt,
      product: run.product ?? "misc",
      requirements: [run.prompt],
      constraints: [],
      confidence: 1,
      questions: [],
    };

    const finished = new Set<string>(
      ordered.filter((t) => t.status === "passed").map((t) => t.id),
    );

    // design mode: documents only — build-class tasks skip ahead of execution
    for (const task of ordered) {
      if (run.mode === "design" && task.class === "build" && !finished.has(task.id)) {
        store.updateTask(task.id, { status: "skipped" });
        bus.emit({
          type: "task_status",
          runId,
          taskId: task.id,
          data: { status: "skipped", reason: "design mode" },
        });
        finished.add(task.id);
      }
    }

    while (finished.size < ordered.length) {
      const fresh = store.getRun(runId);

      // /stop from any surface halts at the next level boundary
      if (fresh.status === "stopped") {
        bus.emit({ type: "run_status", runId, data: { status: "stopped" } });
        return;
      }

      // run-level budget gate (raises via POST /runs/:id/budget)
      if (store.runCost(runId) >= limits.max_cost_per_run_usd + fresh.budget_raise) {
        store.setRunStatus(runId, "paused_budget");
        bus.emit({
          type: "run_status",
          runId,
          data: { status: "paused_budget", costUsd: store.runCost(runId) },
        });
        return;
      }

      const ready = ordered.filter(
        (t) => !finished.has(t.id) && (depsOf.get(t.id) ?? []).every((d) => finished.has(d)),
      );
      if (ready.length === 0) {
        // blocked: survivors depend on tasks that can never pass
        const blocked = ordered.filter((t) => !finished.has(t.id));
        store.setRunStatus(runId, "awaiting_user");
        store.addMessage({
          runId,
          role: "system",
          content: `Blocked: ${blocked.map((t) => t.description).join("; ")} — dependencies did not pass. Reply with guidance.`,
        });
        bus.emit({
          type: "run_status",
          runId,
          data: { status: "awaiting_user", blocked: blocked.map((t) => t.id) },
        });
        return;
      }

      // tools from the MCP servers the user connected in Settings — discovered
      // once per level, best-effort: a server that's down contributes nothing
      // rather than failing the run
      const mcpTools = await loadMcpTools(
        store.listEnabledMcpServers(),
        (server, error) =>
          store.addMessage({
            runId,
            role: "system",
            content: `MCP server "${server}" unavailable: ${error}`,
          }),
      );

      const results = await runPool(ready, limits.max_parallel_builders, (task) =>
        runTask(deps, runId, task, workspace, specForBuild, mcpTools),
      );

      let escalation: TaskOutcome | undefined;
      for (const r of results) {
        if (r.outcome === "passed") {
          finished.add(r.task.id);
          continue;
        }
        if (r.outcome === "stopped") {
          bus.emit({ type: "run_status", runId, data: { status: "stopped" } });
          return;
        }
        if (r.outcome === "budget") {
          store.setRunStatus(runId, "paused_budget");
          bus.emit({
            type: "run_status",
            runId,
            data: { status: "paused_budget", costUsd: store.runCost(runId) },
          });
          return;
        }
        escalation ??= r;
      }

      if (escalation) {
        const task = escalation.task;
        store.updateTask(task.id, { status: "escalated" });
        store.setRunStatus(runId, "awaiting_user");
        store.addMessage({
          runId,
          taskId: task.id,
          role: "system",
          content: `Task "${task.description}" failed after ${limits.max_iterations_per_task} attempts or hit its budget. Last feedback:\n${escalation.feedback ?? "budget exhausted"}\n\nReply with guidance, or say "retry" / "skip".`,
        });
        bus.emit({
          type: "task_status",
          runId,
          taskId: task.id,
          data: { status: "escalated", feedback: escalation.feedback },
        });
        bus.emit({ type: "run_status", runId, data: { status: "awaiting_user" } });
        return;
      }
    }

    // ---- asset studios (best-effort; never blocks the report) ----
    const assetText = spec
      ? `${spec.summary} ${spec.requirements.join(" ")}`
      : run.prompt;
    if (ASSET_TRIGGER.test(assetText)) {
      // servers registered in Settings win; config/models.yaml is the legacy fallback
      const registered = store
        .listEnabledMcpServers()
        .filter((s) => ["video", "audio", "image"].includes(s.kind))
        .map((s) => ({
          name: s.name,
          kind: s.kind as "video" | "audio" | "image",
          cfg: { type: "mcp" as const, command: s.command, args: JSON.parse(s.args) as string[] },
        }));
      const studios = registered.length
        ? registered
        : Object.entries(config.models.asset_studios).map(([name, cfg]) => ({
            name,
            kind: (["video", "audio", "image"].includes(name) ? name : "image") as
              | "video"
              | "audio"
              | "image",
            cfg,
          }));

      for (const { name, kind, cfg } of studios) {
        const result = await new AssetStudio(cfg, kind).generate(
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
  } finally {
    // the run is over either way — drop its file-ownership table
    forgetWorkspace(join(limits.sandbox.workspace_root, runId, "workspace"));
  }
}

// ---- level-parallel execution helpers ----

interface TaskOutcome {
  task: TaskRow;
  outcome: "passed" | "escalated" | "stopped" | "budget";
  feedback?: string;
}

/** Bounded worker pool — at most `size` tasks in flight, start order kept. */
async function runPool<T, R>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  async function next(): Promise<void> {
    while (i < items.length) {
      const item = items[i++]!;
      results.push(await worker(item));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, () => next()),
  );
  return results;
}

/**
 * One task's full build→verify→retry cycle. Self-contained so the pool can
 * run several concurrently; all shared state goes through the store.
 */
async function runTask(
  deps: RunnerDeps,
  runId: string,
  task: TaskRow,
  workspace: string,
  specForBuild: PmSpec,
  mcpTools: McpTool[] = [],
): Promise<TaskOutcome> {
  const { config, store, bus, harness } = deps;
  const { limits } = config;

  store.updateTask(task.id, { status: "running" });
  bus.emit({ type: "task_status", runId, taskId: task.id, data: { status: "running" } });

  let feedback: string | undefined;
  const maxIter = limits.max_iterations_per_task;

  for (let attempt = 1; attempt <= maxIter; attempt++) {
    const fresh = store.getRun(runId);
    if (fresh.status === "stopped") return { task, outcome: "stopped" };
    if (store.runCost(runId) >= limits.max_cost_per_run_usd + fresh.budget_raise) {
      return { task, outcome: "budget" };
    }
    // per-task budget gate
    if (store.getTask(task.id).cost_usd >= limits.max_cost_per_task_usd) break;

    store.updateTask(task.id, { iterations: attempt });

    try {
      const taskMemory = recallBlock(store, task.description, 4);
      if (task.class === "build") {
        // real tool use: the builder runs commands and reacts to output rather
        // than emitting files blind (see agents/tools.ts for the sandbox)
        const built = await buildTaskAgentic(
          harness,
          runId,
          task,
          specForBuild,
          workspace,
          {
            workspace,
            allowlist: limits.sandbox.shell_allowlist,
            commandTimeoutMs: limits.sandbox.command_timeout_ms,
            mcpTools,
            taskId: task.id,
            // parallel tasks are meant to touch disjoint files; when the
            // architect gets that wrong, say so instead of silently clobbering
            onWriteConflict: ({ path, otherTaskId }) => {
              const other = store.getTask(otherTaskId);
              store.addMessage({
                runId,
                taskId: task.id,
                role: "system",
                content:
                  `Write conflict on "${path}": also written by task "${other.description}". ` +
                  `These ran in parallel, so the later write won. If that's wrong, the two ` +
                  `tasks should have been sequenced.`,
              });
              bus.emit({
                type: "message",
                runId,
                taskId: task.id,
                data: { role: "system", conflict: path, otherTaskId },
              });
            },
          },
          feedback,
          recentUserSteering(store, runId),
          taskMemory,
          {
            maxSteps: limits.sandbox.max_tool_steps,
            shouldStop: () =>
              store.getRun(runId).status === "stopped" ||
              store.runCost(runId) >= limits.max_cost_per_run_usd + store.getRun(runId).budget_raise,
            onStep: (s) =>
              bus.emit({
                type: "tool_call",
                runId,
                taskId: task.id,
                data: { tool: s.tool, args: s.args, ok: s.ok, output: s.output },
              }),
          },
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
      } else {
        // plan / fetch / critique → markdown document
        const docPath = await docTask(
          harness,
          runId,
          task,
          specForBuild,
          workspace,
          feedback,
          recentUserSteering(store, runId),
          taskMemory,
        );
        store.addArtifact({ runId, taskId: task.id, path: docPath, kind: "doc" });
        bus.emit({
          type: "artifact",
          runId,
          taskId: task.id,
          data: { path: docPath, kind: "doc" },
        });
      }
    } catch (err) {
      // a crashed attempt is feedback, not a dead run
      feedback = `Attempt ${attempt} crashed: ${err instanceof Error ? err.message : String(err)}\nFix the underlying issue and respond in the required format.`;
      bus.emit({
        type: "task_status",
        runId,
        taskId: task.id,
        data: { status: "retry", attempt, error: feedback.slice(0, 200) },
      });
      continue;
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
      store.updateTask(task.id, { status: "passed", output: feedback ?? null });
      bus.emit({ type: "task_status", runId, taskId: task.id, data: { status: "passed" } });
      return { task, outcome: "passed" };
    }
    feedback = [
      gatesOk ? "" : `Gate failures:\n${gatesSummary(gates)}`,
      `Judge (score ${verdict.score}): ${verdict.feedback}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return { task, outcome: "escalated", feedback };
}
