import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { runPipeline, type RunnerDeps } from "../pipeline/runner.js";
import { MISSION_CONTROL_HTML } from "./ui.js";

export function createApp(deps: RunnerDeps): Hono {
  const { store, bus } = deps;
  const app = new Hono();
  app.use("*", cors());

  app.get("/", (c) => c.html(MISSION_CONTROL_HTML));

  app.post("/runs", async (c) => {
    const body = await c.req
      .json<{ prompt?: string }>()
      .catch((): { prompt?: string } => ({}));
    if (!body.prompt?.trim()) return c.json({ error: "prompt required" }, 400);
    const run = store.createRun(body.prompt.trim());
    store.addMessage({ runId: run.id, role: "user", content: body.prompt.trim() });
    setImmediate(() => void runPipeline(deps, run.id));
    return c.json({ id: run.id }, 201);
  });

  app.get("/runs", (c) => c.json(store.listRuns()));

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
