import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { GitCredential } from "./git-auth.js";
import { syncProductRepo } from "../journal/gitsync.js";
import { runPipeline, type RunnerDeps } from "../pipeline/runner.js";
import { DEFAULT_RUN_MODE, type ProjectRow } from "../store/db.js";
import { deliverRunCode } from "./deliver.js";
import { checkRepoAccess, cloneRepo, listDirectories } from "./fs.js";
import { githubCreateRepo, scaffoldProjectRepo, slugify } from "./projects.js";
import { applyOverride, isValidOverrideKey, resetOverride } from "../config/overrides.js";
import { loadConfig } from "../config/load.js";
import { ENV_VAR_FOR } from "../providers/factory.js";
import { isProbeable, probeApiKey, probeCustomProvider, probeMcpServer } from "./probe.js";
import { KNOWN_API_KEYS, RESTART_REQUIRED } from "./settings.js";

function repoBasename(url: string): string {
  const cleaned = url.replace(/\.git$/, "").replace(/\/+$/, "");
  const name = cleaned.split(/[/:]/).pop() || "repo";
  return name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60) || "repo";
}

/** Static mission-control app (Claude Code owns everything under public/). */
const PUBLIC_DIR = resolve(import.meta.dirname, "../../public");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

export function createApp(deps: RunnerDeps): Hono {
  const { store, bus } = deps;
  const app = new Hono();
  app.use("*", cors());

  app.get("/", (c) => {
    try {
      return c.html(readFileSync(join(PUBLIC_DIR, "index.html"), "utf8"));
    } catch {
      return c.text("mission control app missing — see packages/core/public/", 500);
    }
  });
  app.use("/css/*", serveStatic({ root: PUBLIC_DIR }));
  app.use("/js/*", serveStatic({ root: PUBLIC_DIR }));

  app.post("/runs", async (c) => {
    const body = await c.req
      .json<{ prompt?: string; project?: string; mode?: string; yolo?: boolean }>()
      .catch((): { prompt?: string; project?: string; mode?: string; yolo?: boolean } => ({}));
    if (!body.prompt?.trim()) return c.json({ error: "prompt required" }, 400);
    const mode = ["discuss", "full", "plan", "design"].includes(body.mode ?? "")
      ? body.mode!
      : DEFAULT_RUN_MODE;
    if (body.project?.trim()) {
      try {
        store.getProject(body.project.trim());
      } catch {
        return c.json({ error: `unknown project: ${body.project}` }, 400);
      }
    }
    const run = store.createRun(body.prompt.trim(), {
      product: body.project?.trim() || undefined,
      mode,
      yolo: body.yolo === true,
    });
    store.addMessage({ runId: run.id, role: "user", content: body.prompt.trim() });
    setImmediate(() => void runPipeline(deps, run.id));
    return c.json({ id: run.id }, 201);
  });

  // local folder browser for the "new project" modal (see server/fs.ts)
  app.get("/fs/list", (c) => {
    try {
      return c.json(listDirectories(c.req.query("path")));
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "cannot read directory" },
        400,
      );
    }
  });

  app.post("/fs/check-repo", async (c) => {
    const body = await c.req
      .json<{ url?: string; credential?: GitCredential }>()
      .catch((): { url?: string; credential?: GitCredential } => ({}));
    if (!body.url?.trim()) return c.json({ error: "url required" }, 400);
    return c.json(await checkRepoAccess(body.url.trim(), body.credential));
  });

  app.get("/projects", (c) =>
    c.json(
      store.listProjects().map((p) => ({
        ...p,
        cost_usd: store.projectCost(p.slug),
      })),
    ),
  );

  app.delete("/projects/:slug", (c) => {
    return store.deleteProject(c.req.param("slug"))
      ? c.body(null, 204)
      : c.json({ error: "not found" }, 404);
  });

  app.post("/projects", async (c) => {
    const body = await c.req
      .json<{
        name?: string;
        repo_url?: string; // legacy alias of memory_repo
        memory_dir?: string;
        memory_repo?: string;
        workspace_dirs?: string[];
        code_repos?: string[];
        monorepo?: boolean;
        credentials?: Record<string, GitCredential>;
      }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.name?.trim()) return c.json({ error: "name required" }, 400);

    let slug: string;
    try {
      slug = slugify(body.name);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    try {
      store.getProject(slug);
      return c.json({ error: `project "${slug}" already exists` }, 409);
    } catch {
      // not found — good
    }

    // memory remote: explicit URL wins; else auto-create via GitHub token
    // (settings-managed key wins, falls back to .env — same pattern as model providers)
    const githubToken = store.getApiKey("GITHUB_TOKEN") ?? process.env.GITHUB_TOKEN;
    let memoryRepo = body.memory_repo?.trim() || body.repo_url?.trim() || undefined;
    if (!memoryRepo && githubToken) {
      try {
        memoryRepo = await githubCreateRepo(githubToken, `${slug}-memory`);
      } catch (err) {
        return c.json(
          { error: `github: ${err instanceof Error ? err.message : String(err)}` },
          502,
        );
      }
    }

    store.createProject({
      name: body.name.trim(),
      slug,
      memoryDir: body.memory_dir?.trim() || undefined,
      memoryRepo,
      workspaceDirs: body.workspace_dirs ?? [],
      codeRepos: body.code_repos ?? [],
      monorepo: body.monorepo,
    });
    if (deps.memoryDir) {
      scaffoldProjectRepo(deps.memoryDir, slug);
      if (memoryRepo) {
        syncProductRepo(
          join(deps.memoryDir, "products", slug),
          "project created",
          memoryRepo,
        );
      }
    }

    // real, proof-of-connectivity clone per code repo — best-effort, never
    // blocks project creation (same posture as GitHub auto-repo-create above)
    const cloneResults: { url: string; ok: boolean; path?: string; error?: string }[] = [];
    if (body.code_repos?.length && deps.projectsDir) {
      const cloned: string[] = [];
      for (const url of body.code_repos) {
        const dest = join(deps.projectsDir, slug, repoBasename(url));
        const result = await cloneRepo(url, dest, body.credentials?.[url]);
        if (result.ok) {
          cloned.push(result.path);
          cloneResults.push({ url, ok: true, path: result.path });
        } else {
          cloneResults.push({ url, ok: false, error: result.error });
        }
      }
      store.addWorkspaceDirs(slug, cloned);
    }

    return c.json({ ...store.getProject(slug), clone_results: cloneResults }, 201);
  });

  app.post("/runs/:id/accept", (c) => {
    const id = c.req.param("id");
    try {
      const run = store.getRun(id);
      if (run.status !== "completed") {
        return c.json({ error: `run is ${run.status}, not completed` }, 400);
      }
      const product = run.product ?? "misc";
      let project: ProjectRow | undefined;
      try {
        project = store.getProject(product);
      } catch {
        // run not tied to a registered project — local-only
      }

      // 1. the built code goes to the project's real checkout (this is the
      //    part that used to be missing — work was stranded in the run dir)
      const codeRepos = project ? (JSON.parse(project.code_repos) as string[]) : [];
      const code = deliverRunCode(run, project, { remote: codeRepos[0] });

      // 2. the memory/journal repo, as before
      if (!deps.memoryDir) {
        return c.json({ code, committed: false, pushed: false, error: "no memory dir" });
      }
      const memory = syncProductRepo(
        join(deps.memoryDir, "products", product),
        `accepted run ${id.slice(0, 8)} — $${run.cost_usd.toFixed(4)}`,
        project?.repo_url ?? undefined,
      );
      // top-level committed/pushed stay memory's, for backwards compatibility
      return c.json({ ...memory, memory, code });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  app.get("/runs", (c) => c.json(store.listRuns()));

  app.delete("/runs/:id", (c) => {
    return store.deleteRun(c.req.param("id"))
      ? c.body(null, 204)
      : c.json({ error: "not found" }, 404);
  });

  app.get("/memories", (c) => c.json(store.listMemories(50)));

  // user decision on critical memory writes (governance: human gate)
  app.post("/memories/:id/decision", async (c) => {
    const body = await c.req
      .json<{ decision?: string }>()
      .catch((): { decision?: string } => ({}));
    if (!["approve", "reject"].includes(body.decision ?? "")) {
      return c.json({ error: "decision must be approve|reject" }, 400);
    }
    const id = c.req.param("id");
    const found = store.listMemories(1000).some((m) => m.id === id);
    if (!found) return c.json({ error: "not found" }, 404);
    store.setMemoryStatus(id, body.decision === "approve" ? "approved" : "rejected");
    return c.json({ ok: true, status: body.decision === "approve" ? "approved" : "rejected" });
  });

  app.get("/runs/:id", (c) => {
    try {
      const run = store.getRun(c.req.param("id"));
      return c.json({
        run,
        tasks: store.listTasks(run.id),
        messages: store.listMessages(run.id),
        artifacts: store.listArtifacts(run.id),
      });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  app.get("/runs/:id/events", (c) =>
    streamSSE(c, async (stream) => {
      const id = c.req.param("id");
      const unsub = bus.subscribe(id, (e) => {
        void stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
      });
      stream.onAbort(unsub);
      await new Promise(() => {}); // hold the stream open
    }),
  );

  app.get("/runs/:id/files/*", (c) => {
    const id = c.req.param("id");
    try {
      const run = store.getRun(id);
      if (!run.workspace_dir) return c.json({ error: "no workspace" }, 404);
      const rel = c.req.path.split(`/runs/${id}/files/`)[1] ?? "";
      const base = resolve(run.workspace_dir);
      const target = resolve(base, rel);
      if (target !== base && !target.startsWith(base + sep)) {
        return c.json({ error: "forbidden" }, 403);
      }
      if (!existsSync(target)) return c.json({ error: "not found" }, 404);
      return new Response(readFileSync(target), {
        headers: {
          "Content-Type":
            MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
        },
      });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  app.post("/runs/:id/stop", (c) => {
    try {
      const run = store.getRun(c.req.param("id"));
      store.setRunStatus(run.id, "stopped");
      bus.emit({ type: "run_status", runId: run.id, data: { status: "stopped" } });
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  /** Greenlights the build after the discuss phase — this is the moment the
   *  rest of the crew (architect, builders, verifier) is allowed to start. */
  app.post("/runs/:id/approve", (c) => {
    try {
      const run = store.getRun(c.req.param("id"));
      store.approveRun(run.id);
      store.addMessage({ runId: run.id, role: "user", content: "Approved — start building." });
      setImmediate(() => void runPipeline(deps, run.id));
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  app.post("/runs/:id/budget", async (c) => {
    const body = await c.req
      .json<{ add_usd?: number }>()
      .catch((): { add_usd?: number } => ({}));
    if (!body.add_usd || body.add_usd <= 0) {
      return c.json({ error: "add_usd must be positive" }, 400);
    }
    try {
      const run = store.getRun(c.req.param("id"));
      store.raiseBudget(run.id, body.add_usd);
      const fresh = store.getRun(run.id);
      if (fresh.status === "paused_budget") {
        setImmediate(() => void runPipeline(deps, run.id));
      }
      return c.json({ ok: true, budget_raise: fresh.budget_raise, resumed: fresh.status === "paused_budget" });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  app.post("/runs/:id/chat", async (c) => {
    const id = c.req.param("id");
    const body = await c.req
      .json<{ message?: string }>()
      .catch((): { message?: string } => ({}));
    if (!body.message?.trim()) return c.json({ error: "message required" }, 400);
    store.addMessage({ runId: id, role: "user", content: body.message.trim() });
    bus.emit({
      type: "message",
      runId: id,
      data: { role: "user", content: body.message.trim() },
    });
    const run = store.getRun(id);
    if (["awaiting_user", "paused_budget", "failed"].includes(run.status)) {
      setImmediate(() => void runPipeline(deps, id));
    }
    return c.json({ ok: true });
  });

  // ---- settings: the product's control plane — API keys & MCP servers,
  // live-editable, no .env/YAML hand-editing, no restart needed for model keys ----

  app.get("/settings/api-keys", (c) => {
    const stored = new Map(store.listApiKeyNames().map((k) => [k.name, k.updated_at]));
    const known = KNOWN_API_KEYS.map((k) => ({
      ...k,
      set: stored.has(k.name) || Boolean(process.env[k.name]),
      source: stored.has(k.name) ? "settings" : process.env[k.name] ? "env" : "unset",
      updated_at: stored.get(k.name) ?? null,
      restart_required: RESTART_REQUIRED.has(k.name),
    }));
    // anything else the user added by raw name still shows up and stays editable
    const extra = [...stored.keys()]
      .filter((name) => !KNOWN_API_KEYS.some((k) => k.name === name))
      .map((name) => ({
        name,
        label: name,
        group: "custom" as const,
        set: true,
        source: "settings" as const,
        updated_at: stored.get(name) ?? null,
        restart_required: false,
      }));
    return c.json([...known, ...extra]);
  });

  app.post("/settings/api-keys", async (c) => {
    const body = await c.req
      .json<{ name?: string; value?: string }>()
      .catch((): { name?: string; value?: string } => ({}));
    if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
    store.setApiKey(body.name.trim(), body.value ?? "");
    return c.json({ ok: true });
  });

  app.delete("/settings/api-keys/:name", (c) => {
    store.setApiKey(c.req.param("name"), "");
    return c.body(null, 204);
  });

  /** Real auth check against the vendor — proves a saved key actually works.
   *  Uses each vendor's model-list endpoint, so it costs zero tokens. */
  app.post("/settings/api-keys/:name/test", async (c) => {
    const name = c.req.param("name");
    const body = await c.req
      .json<{ value?: string }>()
      .catch((): { value?: string } => ({}));
    // test the pasted value if given (before saving), else whatever is in effect
    const key = body.value?.trim() || store.getApiKey(name) || process.env[name];
    if (!key) return c.json({ ok: false, error: "no key set" });
    if (!isProbeable(name)) return c.json({ ok: false, error: "no connection test available for this key" });
    return c.json(await probeApiKey(name, key));
  });

  // custom providers — anything that isn't one of the built-in fixed-URL vendors
  app.get("/settings/providers", (c) =>
    c.json(
      store.listCustomProviders().map((p) => ({
        id: p.id, name: p.name, label: p.label, base_url: p.base_url,
        wire: p.wire, has_key: Boolean(p.api_key), created_at: p.created_at,
      })),
    ),
  );

  app.post("/settings/providers", async (c) => {
    const body = await c.req
      .json<{ name?: string; label?: string; base_url?: string; api_key?: string; wire?: string }>()
      .catch(() => ({}) as Record<string, never>);
    const name = body.name?.trim();
    const baseUrl = body.base_url?.trim();
    if (!name) return c.json({ error: "name required" }, 400);
    if (!/^[a-z0-9_-]+$/i.test(name)) {
      return c.json({ error: "name must be letters, digits, dash or underscore (it's the slot's `via`)" }, 400);
    }
    if (!baseUrl) return c.json({ error: "base_url required" }, 400);
    if (ENV_VAR_FOR[name]) return c.json({ error: `"${name}" is a built-in vendor` }, 409);
    if (store.getCustomProviderByName(name)) return c.json({ error: `"${name}" already exists` }, 409);
    try {
      return c.json(
        store.createCustomProvider({
          name,
          label: body.label?.trim() || name,
          baseUrl,
          apiKey: body.api_key?.trim() || undefined,
          wire: body.wire === "anthropic" ? "anthropic" : "openai",
        }),
        201,
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete("/settings/providers/:id", (c) =>
    store.deleteCustomProvider(c.req.param("id"))
      ? c.body(null, 204)
      : c.json({ error: "not found" }, 404),
  );

  /** Hits {base_url}/models to prove the endpoint is reachable and authorised. */
  app.post("/settings/providers/:id/test", async (c) => {
    let p;
    try {
      p = store.getCustomProvider(c.req.param("id"));
    } catch {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(await probeCustomProvider(p.base_url, p.api_key, p.wire));
  });

  /** Everything the engine is actually running with — YAML defaults plus any
   *  Settings edits, flagged so the UI can show what's been changed. */
  app.get("/settings/config", (c) => {
    const overridden = new Set(store.listConfigOverrides().map((o) => o.key));
    return c.json({
      limits: deps.config.limits,
      roles: deps.config.models.roles,
      slots: Object.fromEntries(
        Object.entries(deps.config.models.slots).map(([name, s]) => [
          name,
          { provider: s.provider, model: s.model, via: s.via, cost_weight: deps.config.models.cost_weights[name] ?? null },
        ]),
      ),
      memory: { mirror_dir: deps.config.memory.mirror_dir, auto_push: deps.config.memory.auto_push },
      overridden: [...overridden],
    });
  });

  /** Applies onto the live config object (every agent holds it by reference),
   *  then persists — so the change lands on the next model call, no restart. */
  app.patch("/settings/config", async (c) => {
    const body = await c.req
      .json<{ key?: string; value?: unknown }>()
      .catch((): { key?: string; value?: unknown } => ({}));
    if (!body.key) return c.json({ error: "key required" }, 400);
    const err = applyOverride(deps.config, body.key, body.value);
    if (err) return c.json({ error: err }, 400);
    store.setConfigOverride(body.key, body.value);
    return c.json({ ok: true });
  });

  /** Drops the override and restores the value from config/*.yaml. */
  app.delete("/settings/config/:key", (c) => {
    const key = c.req.param("key");
    if (!isValidOverrideKey(key)) return c.json({ error: `unknown setting "${key}"` }, 400);
    if (!deps.configDir) return c.json({ error: "server has no config dir configured" }, 500);

    // re-read the YAML before dropping the override, so a failure here leaves
    // the stored override intact rather than half-reset
    let fresh;
    try {
      fresh = loadConfig(deps.configDir);
    } catch (err) {
      return c.json(
        { error: `could not re-read config: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }
    const problem = resetOverride(deps.config, fresh, key);
    if (problem) return c.json({ error: problem }, 400);
    store.clearConfigOverride(key);
    return c.json({ ok: true });
  });

  /** Spend analytics — cost ledger aggregated per project (or whole workspace). */
  app.get("/spend", (c) => {
    const product = c.req.query("project");
    return c.json(store.spendReport(product || undefined));
  });

  app.get("/settings/mcp-servers", (c) =>
    c.json(
      store.listMcpServers().map((s) => ({
        ...s,
        args: JSON.parse(s.args),
        tools: JSON.parse(s.tools),
      })),
    ),
  );

  app.post("/settings/mcp-servers", async (c) => {
    const body = await c.req
      .json<{ name?: string; kind?: string; command?: string; args?: string[] }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
    if (!body.command?.trim()) return c.json({ error: "command required" }, 400);
    const s = store.createMcpServer({
      name: body.name.trim(),
      kind: body.kind?.trim() || undefined,
      command: body.command.trim(),
      args: body.args ?? [],
    });
    return c.json({ ...s, args: JSON.parse(s.args), tools: JSON.parse(s.tools) }, 201);
  });

  app.patch("/settings/mcp-servers/:id", async (c) => {
    const body = await c.req
      .json<{ enabled?: boolean }>()
      .catch((): { enabled?: boolean } => ({}));
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be boolean" }, 400);
    const ok = store.setMcpServerEnabled(c.req.param("id"), body.enabled);
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  app.delete("/settings/mcp-servers/:id", (c) => {
    return store.deleteMcpServer(c.req.param("id"))
      ? c.body(null, 204)
      : c.json({ error: "not found" }, 404);
  });

  /** Actually spawns the server over stdio and lists its tools — the only
   *  honest way to know it works before a run depends on it. */
  app.post("/settings/mcp-servers/:id/test", async (c) => {
    let server;
    try {
      server = store.getMcpServer(c.req.param("id"));
    } catch {
      return c.json({ error: "not found" }, 404);
    }
    const result = await probeMcpServer(server.command, JSON.parse(server.args) as string[]);
    store.recordMcpProbe(server.id, {
      ok: result.ok,
      error: result.ok ? undefined : result.error,
      tools: result.ok ? result.tools : [],
    });
    return c.json(result);
  });

  return app;
}
