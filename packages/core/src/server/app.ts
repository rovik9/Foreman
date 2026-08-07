import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { GitCredential } from "./git-auth.js";
import { syncProductRepo } from "../journal/gitsync.js";
import { runPipeline, type RunnerDeps } from "../pipeline/runner.js";
import { checkRepoAccess, cloneRepo, listDirectories } from "./fs.js";
import { githubCreateRepo, scaffoldProjectRepo, slugify } from "./projects.js";
import { KNOWN_API_KEYS } from "./settings.js";

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
    const mode = ["full", "plan", "design"].includes(body.mode ?? "")
      ? body.mode!
      : "full";
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

  app.delete("/projects/:slug", (c) => {
    const removed = store.deleteProject(c.req.param("slug"));
    return removed ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });

  app.post("/runs/:id/accept", (c) => {
    const id = c.req.param("id");
    try {
      const run = store.getRun(id);
      if (run.status !== "completed") {
        return c.json({ error: `run is ${run.status}, not completed` }, 400);
      }
      const product = run.product ?? "misc";
      let repoUrl: string | undefined;
      try {
        repoUrl = store.getProject(product).repo_url ?? undefined;
      } catch {
        // run not tied to a registered project — local-only
      }
      if (!deps.memoryDir) {
        return c.json({ committed: false, pushed: false, error: "no memory dir" });
      }
      const result = syncProductRepo(
        join(deps.memoryDir, "products", product),
        `accepted run ${id.slice(0, 8)} — $${run.cost_usd.toFixed(4)}`,
        repoUrl,
      );
      return c.json(result);
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
    }));
    // any key set via settings that isn't in the known list (raw env var name) still shows up
    const extra = [...stored.keys()]
      .filter((name) => !KNOWN_API_KEYS.some((k) => k.name === name))
      .map((name) => ({
        name,
        label: name,
        group: "integration" as const,
        set: true,
        source: "settings" as const,
        updated_at: stored.get(name) ?? null,
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

  app.get("/settings/mcp-servers", (c) =>
    c.json(store.listMcpServers().map((s) => ({ ...s, args: JSON.parse(s.args) }))),
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
    return c.json({ ...s, args: JSON.parse(s.args) }, 201);
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

  return app;
}
