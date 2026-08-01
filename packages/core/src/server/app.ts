import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { syncProductRepo } from "../journal/gitsync.js";
import { runPipeline, type RunnerDeps } from "../pipeline/runner.js";
import { githubCreateRepo, scaffoldProjectRepo, slugify } from "./projects.js";
import { MISSION_CONTROL_HTML } from "./ui.js";

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

  app.get("/", (c) => c.html(MISSION_CONTROL_HTML));

  app.post("/runs", async (c) => {
    const body = await c.req
      .json<{ prompt?: string; project?: string }>()
      .catch((): { prompt?: string; project?: string } => ({}));
    if (!body.prompt?.trim()) return c.json({ error: "prompt required" }, 400);
    const run = store.createRun(body.prompt.trim());
    if (body.project?.trim()) {
      try {
        store.getProject(body.project.trim());
        store.setRunProduct(run.id, body.project.trim());
      } catch {
        return c.json({ error: `unknown project: ${body.project}` }, 400);
      }
    }
    store.addMessage({ runId: run.id, role: "user", content: body.prompt.trim() });
    setImmediate(() => void runPipeline(deps, run.id));
    return c.json({ id: run.id }, 201);
  });

  app.get("/projects", (c) => c.json(store.listProjects()));

  app.post("/projects", async (c) => {
    const body = await c.req
      .json<{ name?: string; repo_url?: string }>()
      .catch((): { name?: string; repo_url?: string } => ({}));
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

    // remote: user-pasted URL wins; else auto-create via GitHub token
    let repoUrl = body.repo_url?.trim() || undefined;
    if (!repoUrl && process.env.GITHUB_TOKEN) {
      try {
        repoUrl = await githubCreateRepo(process.env.GITHUB_TOKEN, `${slug}-memory`);
      } catch (err) {
        return c.json(
          { error: `github: ${err instanceof Error ? err.message : String(err)}` },
          502,
        );
      }
    }

    const project = store.createProject({ name: body.name.trim(), slug, repoUrl });
    if (deps.memoryDir) {
      scaffoldProjectRepo(deps.memoryDir, slug);
      // remote configured later if one exists — first push happens on accept
      if (repoUrl) {
        syncProductRepo(
          join(deps.memoryDir, "products", slug),
          "project created",
          repoUrl,
        );
      }
    }
    return c.json({ ...project, repo_url: repoUrl ?? null }, 201);
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

  return app;
}
