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
  product: string | null;
  mode: string; // full | plan | design
  yolo: number; // 1 = bypass permission gates
  budget_raise: number; // extra USD on top of the run cap (top-ups)
  approved: number;     // 1 = user greenlit the build after the discuss phase
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

export interface MemoryRow {
  id: string;
  kind: string;
  text: string;
  tags: string; // JSON string[]
  confidence: number;
  source_run_id: string | null;
  access_count: number;
  created_at: string;
  last_accessed_at: string;
}

export interface CostRow {
  id: number;
  run_id: string;
  task_id: string | null;
  slot: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  repo_url: string | null;      // legacy alias of memory_repo (kept for compat)
  memory_dir: string | null;    // custom local memory folder (default: memory/products/<slug>)
  memory_repo: string | null;   // memory git remote
  workspace_dirs: string;       // JSON string[] — project local folders
  code_repos: string;           // JSON string[] — project git remotes
  monorepo: number;             // 1 = one repo, 0 = polyrepo
  created_at: string;
}

export interface CustomProviderRow {
  id: string;
  name: string;      // used as a slot's `via` in models.yaml
  label: string;
  base_url: string;
  api_key: string | null;
  wire: string;      // openai | anthropic
  created_at: string;
}

export interface MessageRow {
  id: number;
  run_id: string;
  task_id: string | null;
  role: string;   // user | pm | interface | architect | builder | judge | context | system
  slot: string | null;
  content: string;
  created_at: string;
}

export interface McpServerRow {
  id: string;
  name: string;
  kind: string;    // video | audio | image | general
  command: string;
  args: string;     // JSON string[]
  enabled: number;  // 1 = usable, 0 = disabled without deleting
  created_at: string;
  last_status: string | null;    // ok | error | null (never tested)
  last_error: string | null;
  tools: string;                 // JSON string[] — discovered on last successful probe
  last_checked_at: string | null;
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
  `
  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,             -- preference | fact | decision | lesson | convention
    text TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    confidence REAL NOT NULL DEFAULT 0.8,
    source_run_id TEXT,
    access_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE VIRTUAL TABLE memories_fts USING fts5(
    text, tags, content='memories', content_rowid='rowid'
  );

  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, text, tags)
      VALUES ('delete', old.rowid, old.text, old.tags);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, text, tags)
      VALUES ('delete', old.rowid, old.text, old.tags);
    INSERT INTO memories_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
  END;
  `,
  `
  ALTER TABLE runs ADD COLUMN product TEXT;
  `,
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    repo_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  `
  ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
  ALTER TABLE memories ADD COLUMN proposed_by TEXT;
  `,
  `
  ALTER TABLE projects ADD COLUMN memory_dir TEXT;
  ALTER TABLE projects ADD COLUMN memory_repo TEXT;
  ALTER TABLE projects ADD COLUMN workspace_dirs TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE projects ADD COLUMN code_repos TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE projects ADD COLUMN monorepo INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'full';
  ALTER TABLE runs ADD COLUMN yolo INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE runs ADD COLUMN budget_raise REAL NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE api_keys (
    name TEXT PRIMARY KEY,           -- env var name, e.g. ANTHROPIC_API_KEY
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'general',   -- video | audio | image | general
    command TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '[]',        -- JSON string[]
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  `
  ALTER TABLE mcp_servers ADD COLUMN last_status TEXT;
  ALTER TABLE mcp_servers ADD COLUMN last_error TEXT;
  ALTER TABLE mcp_servers ADD COLUMN tools TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE mcp_servers ADD COLUMN last_checked_at TEXT;
  `,
  `
  ALTER TABLE runs ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE custom_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,        -- the slot's "via" value in models.yaml
    label TEXT NOT NULL,
    base_url TEXT NOT NULL,           -- e.g. http://localhost:11434/v1 (Ollama)
    api_key TEXT,                     -- optional: local servers often need none
    wire TEXT NOT NULL DEFAULT 'openai',  -- openai | anthropic
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // NOTE: migrations are append-only. Editing an existing entry does nothing on
  // a database that already applied it — always add a new one at the end.
  `
  CREATE TABLE config_overrides (
    key TEXT PRIMARY KEY,          -- dotted path, e.g. limits.max_cost_per_run_usd
    value TEXT NOT NULL,           -- JSON-encoded
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
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

  createRun(
    prompt: string,
    opts: { product?: string; mode?: string; yolo?: boolean } = {},
  ): RunRow {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO runs (id, prompt, product, mode, yolo) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, prompt, opts.product ?? null, opts.mode ?? "full", opts.yolo ? 1 : 0);
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

  setRunProduct(id: string, product: string): void {
    this.db
      .prepare("UPDATE runs SET product = ?, updated_at = datetime('now') WHERE id = ?")
      .run(product, id);
  }

  /** User greenlit the build after discussing — lets the pipeline past the discuss gate. */
  approveRun(id: string): void {
    this.db
      .prepare("UPDATE runs SET approved = 1, updated_at = datetime('now') WHERE id = ?")
      .run(id);
  }

  raiseBudget(id: string, addUsd: number): void {
    this.db
      .prepare("UPDATE runs SET budget_raise = budget_raise + ?, updated_at = datetime('now') WHERE id = ?")
      .run(addUsd, id);
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

  /** Deletes a run and cascades to its tasks/messages/artifacts/cost_ledger rows (FK ON DELETE CASCADE). */
  deleteRun(id: string): boolean {
    const r = this.db.prepare("DELETE FROM runs WHERE id = ?").run(id);
    return r.changes > 0;
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

  // ---- spend analytics (cost_ledger joined to runs for project attribution) ----

  /** Every aggregate the spend view needs, scoped to one project or the whole workspace. */
  spendReport(product?: string): {
    totals: { cost: number; calls: number; promptTokens: number; completionTokens: number };
    byModel: { model: string; slot: string; cost: number; calls: number; promptTokens: number; completionTokens: number }[];
    byDay: { day: string; cost: number }[];
    byRun: { run_id: string; prompt: string; status: string; cost: number; calls: number }[];
  } {
    const where = product ? "WHERE r.product = ?" : "";
    const p = product ? [product] : [];

    const totals = this.db
      .prepare(
        `SELECT COALESCE(SUM(c.cost_usd), 0) AS cost, COUNT(*) AS calls,
                COALESCE(SUM(c.prompt_tokens), 0) AS promptTokens,
                COALESCE(SUM(c.completion_tokens), 0) AS completionTokens
         FROM cost_ledger c JOIN runs r ON r.id = c.run_id ${where}`,
      )
      .get(...p) as { cost: number; calls: number; promptTokens: number; completionTokens: number };

    const byModel = this.db
      .prepare(
        `SELECT c.model, c.slot, SUM(c.cost_usd) AS cost, COUNT(*) AS calls,
                SUM(c.prompt_tokens) AS promptTokens, SUM(c.completion_tokens) AS completionTokens
         FROM cost_ledger c JOIN runs r ON r.id = c.run_id ${where}
         GROUP BY c.model, c.slot ORDER BY cost DESC`,
      )
      .all(...p) as { model: string; slot: string; cost: number; calls: number; promptTokens: number; completionTokens: number }[];

    const byDay = this.db
      .prepare(
        `SELECT date(c.created_at) AS day, SUM(c.cost_usd) AS cost
         FROM cost_ledger c JOIN runs r ON r.id = c.run_id ${where}
         GROUP BY day ORDER BY day`,
      )
      .all(...p) as { day: string; cost: number }[];

    const byRun = this.db
      .prepare(
        `SELECT c.run_id, r.prompt, r.status, SUM(c.cost_usd) AS cost, COUNT(*) AS calls
         FROM cost_ledger c JOIN runs r ON r.id = c.run_id ${where}
         GROUP BY c.run_id ORDER BY cost DESC LIMIT 50`,
      )
      .all(...p) as { run_id: string; prompt: string; status: string; cost: number; calls: number }[];

    return { totals, byModel, byDay, byRun };
  }

  runCost(runId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_ledger WHERE run_id = ?")
      .get(runId) as { total: number };
    return row.total;
  }

  // ---- memories (cross-run durable knowledge) ----

  addMemory(m: {
    kind: string;
    text: string;
    tags?: string[];
    confidence?: number;
    sourceRunId?: string;
    status?: string;
    proposedBy?: string;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO memories (id, kind, text, tags, confidence, source_run_id, status, proposed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        m.kind,
        m.text,
        JSON.stringify(m.tags ?? []),
        m.confidence ?? 0.8,
        m.sourceRunId ?? null,
        m.status ?? "approved",
        m.proposedBy ?? null,
      );
    return id;
  }

  setMemoryStatus(id: string, status: string): void {
    this.db.prepare("UPDATE memories SET status = ? WHERE id = ?").run(status, id);
  }

  listPendingMemories(): MemoryRow[] {
    return this.db
      .prepare("SELECT * FROM memories WHERE status = 'pending' ORDER BY created_at")
      .all() as MemoryRow[];
  }

  /**
   * Crash recovery: a process kill leaves runs frozen in "running" and
   * tasks in "running"/"verifying". Sweep marks runs failed (resumable)
   * and resets tasks to pending. Returns the affected run ids.
   */
  recoverInterruptedRuns(): string[] {
    const stuck = this.db
      .prepare("SELECT id FROM runs WHERE status = 'running'")
      .all() as { id: string }[];
    if (stuck.length === 0) return [];
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE status = 'running'")
        .run();
      this.db
        .prepare("UPDATE tasks SET status = 'pending' WHERE status IN ('running', 'verifying')")
        .run();
      const note = this.db.prepare(
        "INSERT INTO messages (run_id, role, content) VALUES (?, 'system', ?)",
      );
      for (const r of stuck) {
        note.run(r.id, "Run interrupted by process restart — recovered and resumable.");
      }
    })();
    return stuck.map((r) => r.id);
  }

  /**
   * Full-text recall. Terms OR-matched with prefix wildcard, bm25 ranked.
   * Returned memories get access_count/last_accessed bumped — the recall
   * loop can later weigh frequency + recency.
   */
  searchMemories(query: string, limit = 5): MemoryRow[] {
    const terms = query
      .replace(/['"()*:^]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2)
      .slice(0, 8);
    if (terms.length === 0) return [];
    const match = terms.map((t) => `"${t}"*`).join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memories_fts f
         JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ? AND m.status = 'approved'
         ORDER BY bm25(memories_fts)
         LIMIT ?`,
      )
      .all(match, limit) as MemoryRow[];
    if (rows.length > 0) {
      const bump = this.db.prepare(
        "UPDATE memories SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?",
      );
      this.db.transaction(() => {
        for (const r of rows) bump.run(r.id);
      })();
    }
    return rows;
  }

  listMemories(limit = 50): MemoryRow[] {
    return this.db
      .prepare("SELECT * FROM memories ORDER BY created_at DESC LIMIT ?")
      .all(limit) as MemoryRow[];
  }

  listCosts(runId: string): CostRow[] {
    return this.db
      .prepare("SELECT * FROM cost_ledger WHERE run_id = ? ORDER BY id")
      .all(runId) as CostRow[];
  }

  // ---- projects ----

  createProject(p: {
    name: string;
    slug: string;
    repoUrl?: string;
    memoryDir?: string;
    memoryRepo?: string;
    workspaceDirs?: string[];
    codeRepos?: string[];
    monorepo?: boolean;
  }): ProjectRow {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, slug, repo_url, memory_dir, memory_repo, workspace_dirs, code_repos, monorepo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        p.name,
        p.slug,
        p.memoryRepo ?? p.repoUrl ?? null,
        p.memoryDir ?? null,
        p.memoryRepo ?? p.repoUrl ?? null,
        JSON.stringify(p.workspaceDirs ?? []),
        JSON.stringify(p.codeRepos ?? []),
        p.monorepo === false ? 0 : 1,
      );
    return this.getProject(p.slug);
  }

  deleteProject(slug: string): boolean {
    const r = this.db.prepare("DELETE FROM projects WHERE slug = ?").run(slug);
    return r.changes > 0;
  }

  /** Appends local checkout paths (e.g. from a fresh clone) to a project's workspace_dirs. */
  addWorkspaceDirs(slug: string, dirs: string[]): void {
    if (dirs.length === 0) return;
    const project = this.getProject(slug);
    const existing = JSON.parse(project.workspace_dirs) as string[];
    const merged = [...new Set([...existing, ...dirs])];
    this.db
      .prepare("UPDATE projects SET workspace_dirs = ? WHERE slug = ?")
      .run(JSON.stringify(merged), slug);
  }

  projectCost(slug: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM runs WHERE product = ?")
      .get(slug) as { total: number };
    return row.total;
  }

  getProject(slug: string): ProjectRow {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE slug = ?")
      .get(slug) as ProjectRow | undefined;
    if (!row) throw new Error(`project not found: ${slug}`);
    return row;
  }

  listProjects(): ProjectRow[] {
    return this.db
      .prepare("SELECT * FROM projects ORDER BY created_at DESC")
      .all() as ProjectRow[];
  }

  // ---- api keys (live-editable — no .env restart needed; see providers/factory.ts) ----

  /** Empty/blank value clears the key instead of storing an empty string. */
  setApiKey(name: string, value: string): void {
    if (!value.trim()) {
      this.db.prepare("DELETE FROM api_keys WHERE name = ?").run(name);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO api_keys (name, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(name, value);
  }

  /** Raw value — used only by provider resolution, never returned over the API. */
  getApiKey(name: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM api_keys WHERE name = ?").get(name) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  /** Which keys are set, without ever exposing the values — for the settings UI. */
  listApiKeyNames(): { name: string; updated_at: string }[] {
    return this.db
      .prepare("SELECT name, updated_at FROM api_keys ORDER BY name")
      .all() as { name: string; updated_at: string }[];
  }

  // ---- mcp servers (generic registry — asset studios today, agent tools later) ----

  createMcpServer(s: { name: string; kind?: string; command: string; args?: string[] }): McpServerRow {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO mcp_servers (id, name, kind, command, args) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, s.name, s.kind ?? "general", s.command, JSON.stringify(s.args ?? []));
    return this.getMcpServer(id);
  }

  getMcpServer(id: string): McpServerRow {
    const row = this.db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as
      | McpServerRow
      | undefined;
    if (!row) throw new Error(`mcp server not found: ${id}`);
    return row;
  }

  listMcpServers(): McpServerRow[] {
    return this.db
      .prepare("SELECT * FROM mcp_servers ORDER BY created_at")
      .all() as McpServerRow[];
  }

  /** Records the outcome of a real connection probe (see server/probe.ts). */
  recordMcpProbe(id: string, r: { ok: boolean; error?: string; tools?: string[] }): void {
    this.db
      .prepare(
        `UPDATE mcp_servers
         SET last_status = ?, last_error = ?, tools = ?, last_checked_at = datetime('now')
         WHERE id = ?`,
      )
      .run(r.ok ? "ok" : "error", r.error ?? null, JSON.stringify(r.tools ?? []), id);
  }

  /** Enabled servers only — what the pipeline is allowed to actually call. */
  listEnabledMcpServers(kind?: string): McpServerRow[] {
    return kind
      ? (this.db
          .prepare("SELECT * FROM mcp_servers WHERE enabled = 1 AND kind = ? ORDER BY created_at")
          .all(kind) as McpServerRow[])
      : (this.db
          .prepare("SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY created_at")
          .all() as McpServerRow[]);
  }

  setMcpServerEnabled(id: string, enabled: boolean): boolean {
    const r = this.db
      .prepare("UPDATE mcp_servers SET enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, id);
    return r.changes > 0;
  }

  deleteMcpServer(id: string): boolean {
    const r = this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
    return r.changes > 0;
  }

  // ---- config overrides (YAML stays the default; the UI edits win) ----

  setConfigOverride(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO config_overrides (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value));
  }

  clearConfigOverride(key: string): void {
    this.db.prepare("DELETE FROM config_overrides WHERE key = ?").run(key);
  }

  listConfigOverrides(): { key: string; value: unknown; updated_at: string }[] {
    return (
      this.db.prepare("SELECT * FROM config_overrides ORDER BY key").all() as {
        key: string; value: string; updated_at: string;
      }[]
    ).map((r) => ({ key: r.key, value: JSON.parse(r.value) as unknown, updated_at: r.updated_at }));
  }

  // ---- custom providers (Ollama, Azure, vLLM, any OpenAI-compatible proxy) ----

  createCustomProvider(p: {
    name: string; label: string; baseUrl: string; apiKey?: string; wire?: string;
  }): CustomProviderRow {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO custom_providers (id, name, label, base_url, api_key, wire) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, p.name, p.label, p.baseUrl, p.apiKey ?? null, p.wire ?? "openai");
    return this.getCustomProvider(id);
  }

  getCustomProvider(id: string): CustomProviderRow {
    const row = this.db.prepare("SELECT * FROM custom_providers WHERE id = ?").get(id) as
      | CustomProviderRow
      | undefined;
    if (!row) throw new Error(`custom provider not found: ${id}`);
    return row;
  }

  /** Looked up by a slot's `via` value during provider resolution. */
  getCustomProviderByName(name: string): CustomProviderRow | undefined {
    return this.db.prepare("SELECT * FROM custom_providers WHERE name = ?").get(name) as
      | CustomProviderRow
      | undefined;
  }

  listCustomProviders(): CustomProviderRow[] {
    return this.db
      .prepare("SELECT * FROM custom_providers ORDER BY created_at")
      .all() as CustomProviderRow[];
  }

  deleteCustomProvider(id: string): boolean {
    const r = this.db.prepare("DELETE FROM custom_providers WHERE id = ?").run(id);
    return r.changes > 0;
  }
}
