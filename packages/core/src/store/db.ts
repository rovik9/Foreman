import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_user"
  | "paused_budget"
  | "completed"
  | "failed"
  | "stopped";

export type TaskStatus =
  | "pending"
  | "running"
  | "verifying"
  | "passed"
  | "failed"
  | "escalated"
  | "skipped";

export interface RunRow {
  id: string;
  prompt: string;
  status: RunStatus;
  workspace_dir: string | null;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: string;
  run_id: string;
  seq: number;
  class: string;
  slot: string | null;
  description: string;
  acceptance_criteria: string; // JSON
  deps: string; // JSON string[]
  status: TaskStatus;
  iterations: number;
  cost_usd: number;
  output: string | null;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    workspace_dir TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    class TEXT NOT NULL,
    slot TEXT,
    description TEXT NOT NULL,
    acceptance_criteria TEXT NOT NULL DEFAULT '[]',
    deps TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    iterations INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    output TEXT
  );
  CREATE INDEX idx_tasks_run ON tasks(run_id, seq);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    task_id TEXT,
    role TEXT NOT NULL,           -- user | pm | architect | builder | judge | system
    slot TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_messages_run ON messages(run_id, id);

  CREATE TABLE artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    task_id TEXT,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,           -- code | video | audio | image | doc
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_artifacts_run ON artifacts(run_id);

  CREATE TABLE cost_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    task_id TEXT,
    slot TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_cost_run ON cost_ledger(run_id);
  `,
];

export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
    );
    const applied = this.db
      .prepare("SELECT COALESCE(MAX(n), 0) AS n FROM _migrations")
      .get() as { n: number };
    for (let i = applied.n; i < MIGRATIONS.length; i++) {
      const sql = MIGRATIONS[i];
      if (!sql) continue;
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db
          .prepare("INSERT INTO _migrations (n) VALUES (?)")
          .run(i + 1);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- runs ----

  createRun(prompt: string): RunRow {
    const id = randomUUID();
    this.db.prepare("INSERT INTO runs (id, prompt) VALUES (?, ?)").run(id, prompt);
    return this.getRun(id);
  }

  getRun(id: string): RunRow {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | RunRow
      | undefined;
    if (!row) throw new Error(`run not found: ${id}`);
    return row;
  }

  setRunStatus(id: string, status: RunStatus): void {
    this.db
      .prepare("UPDATE runs SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, id);
  }

  setRunWorkspace(id: string, dir: string): void {
    this.db
      .prepare("UPDATE runs SET workspace_dir = ?, updated_at = datetime('now') WHERE id = ?")
      .run(dir, id);
  }

  // ---- tasks ----

  createTask(t: {
    runId: string;
    seq: number;
    class: string;
    description: string;
    acceptanceCriteria?: unknown[];
    deps?: string[];
  }): TaskRow {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tasks (id, run_id, seq, class, description, acceptance_criteria, deps)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        t.runId,
        t.seq,
        t.class,
        t.description,
        JSON.stringify(t.acceptanceCriteria ?? []),
        JSON.stringify(t.deps ?? []),
      );
    return this.getTask(id);
  }

  getTask(id: string): TaskRow {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | TaskRow
      | undefined;
    if (!row) throw new Error(`task not found: ${id}`);
    return row;
  }

  listTasks(runId: string): TaskRow[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE run_id = ? ORDER BY seq")
      .all(runId) as TaskRow[];
  }

  setTaskDeps(id: string, deps: string[]): void {
    this.db
      .prepare("UPDATE tasks SET deps = ? WHERE id = ?")
      .run(JSON.stringify(deps), id);
  }

  listRuns(limit = 100): RunRow[] {
    return this.db
      .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as RunRow[];
  }

  updateTask(
    id: string,
    patch: Partial<
      Pick<TaskRow, "status" | "slot" | "output" | "iterations">
    >,
  ): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      fields.push(`${k} = ?`);
      values.push(v);
    }
    if (fields.length === 0) return;
    values.push(id);
    this.db
      .prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`)
      .run(...(values as never[]));
  }

  // ---- messages (chat + agent event log) ----

  addMessage(m: {
    runId: string;
    taskId?: string;
    role: string;
    slot?: string;
    content: string;
  }): number {
    const r = this.db
      .prepare(
        "INSERT INTO messages (run_id, task_id, role, slot, content) VALUES (?, ?, ?, ?, ?)",
      )
      .run(m.runId, m.taskId ?? null, m.role, m.slot ?? null, m.content);
    return Number(r.lastInsertRowid);
  }

  listMessages(runId: string): unknown[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE run_id = ? ORDER BY id")
      .all(runId);
  }

  // ---- artifacts ----

  addArtifact(a: {
    runId: string;
    taskId?: string;
    path: string;
    kind: string;
  }): number {
    const r = this.db
      .prepare(
        "INSERT INTO artifacts (run_id, task_id, path, kind) VALUES (?, ?, ?, ?)",
      )
      .run(a.runId, a.taskId ?? null, a.path, a.kind);
    return Number(r.lastInsertRowid);
  }

  listArtifacts(runId: string): unknown[] {
    return this.db
      .prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY id")
      .all(runId);
  }

  // ---- cost ledger ----

  addCost(c: {
    runId: string;
    taskId?: string;
    slot: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  }): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO cost_ledger
             (run_id, task_id, slot, model, prompt_tokens, completion_tokens, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          c.runId,
          c.taskId ?? null,
          c.slot,
          c.model,
          c.promptTokens,
          c.completionTokens,
          c.costUsd,
        );
      this.db
        .prepare(
          "UPDATE runs SET cost_usd = cost_usd + ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(c.costUsd, c.runId);
      if (c.taskId) {
        this.db
          .prepare("UPDATE tasks SET cost_usd = cost_usd + ? WHERE id = ?")
          .run(c.costUsd, c.taskId);
      }
    })();
  }

  runCost(runId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_ledger WHERE run_id = ?")
      .get(runId) as { total: number };
    return row.total;
  }
}
