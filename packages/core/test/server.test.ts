import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { HAPPY_SCRIPT, makeRig } from "./helpers.js";

async function pollUntil(
  fn: () => Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("poll timed out");
}

describe("server", () => {
  it("serves mission control UI", async () => {
    const rig = makeRig({});
    const app = createApp(rig);
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("FOREMAN");
  });

  it("rejects empty prompt", async () => {
    const rig = makeRig({});
    const app = createApp(rig);
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "  " }),
    });
    expect(res.status).toBe(400);
  });

  it("runs a full pipeline over HTTP", async () => {
    const rig = makeRig(HAPPY_SCRIPT);
    const app = createApp(rig);

    const create = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // "full" = skip the discuss gate; this test is about the build pipeline
      body: JSON.stringify({ prompt: "build me a landing page", mode: "full" }),
    });
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as { id: string };

    await pollUntil(async () => {
      const res = await app.request(`/runs/${id}`);
      const body = (await res.json()) as { run: { status: string } };
      return body.run.status === "completed";
    });

    const res = await app.request(`/runs/${id}`);
    const body = (await res.json()) as {
      run: { cost_usd: number };
      tasks: { status: string }[];
    };
    expect(body.tasks.every((t) => t.status === "passed")).toBe(true);
    expect(body.run.cost_usd).toBeGreaterThan(0);

    const list = await app.request("/runs");
    expect(((await list.json()) as unknown[]).length).toBe(1);
  });

  it("defaults to discuss mode — a bare prompt never dispatches the crew", async () => {
    const rig = makeRig({
      "pm-model": [JSON.stringify({ reply: "What should it do exactly?", ready: false })],
    });
    const app = createApp(rig);

    const create = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "make me something" }),
    });
    const { id } = (await create.json()) as { id: string };

    await pollUntil(async () => {
      const body = (await (await app.request(`/runs/${id}`)).json()) as { run: { status: string } };
      return body.run.status === "awaiting_user";
    });

    const body = (await (await app.request(`/runs/${id}`)).json()) as {
      run: { mode: string; approved: number };
      tasks: unknown[];
      messages: { role: string; content: string }[];
    };
    expect(body.run.mode).toBe("discuss");
    expect(body.run.approved).toBe(0);
    expect(body.tasks).toHaveLength(0);
    expect(body.messages.some((m) => m.role === "interface")).toBe(true);
    // nothing downstream of the Interface AI was ever called
    expect(rig.mock.calls.every((c) => c.model === "pm-model")).toBe(true);
  });

  it("approve releases the crew", async () => {
    const rig = makeRig({});
    const app = createApp(rig);
    const run = rig.store.createRun("x", { mode: "discuss" });
    const res = await app.request(`/runs/${run.id}/approve`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(rig.store.getRun(run.id).approved).toBe(1);
  });

  it("accepts mid-run chat", async () => {
    const rig = makeRig(HAPPY_SCRIPT);
    const app = createApp(rig);
    const run = rig.store.createRun("p");
    const res = await app.request(`/runs/${run.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "steer left" }),
    });
    expect(res.status).toBe(200);
    const msgs = rig.store.listMessages(run.id) as { content: string }[];
    expect(msgs.some((m) => m.content === "steer left")).toBe(true);
  });

  it("settings/api-keys: lists known keys unset, then set after a save, never leaks the value", async () => {
    const rig = makeRig({});
    const app = createApp(rig);

    const before = (await (await app.request("/settings/api-keys")).json()) as { name: string; set: boolean }[];
    expect(before.some((k) => k.name === "ANTHROPIC_API_KEY" && !k.set)).toBe(true);

    const save = await app.request("/settings/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ANTHROPIC_API_KEY", value: "sk-super-secret" }),
    });
    expect(save.status).toBe(200);

    const after = (await (await app.request("/settings/api-keys")).json()) as
      { name: string; set: boolean; source: string }[];
    const row = after.find((k) => k.name === "ANTHROPIC_API_KEY")!;
    expect(row.set).toBe(true);
    expect(row.source).toBe("settings");
    expect(JSON.stringify(after)).not.toContain("sk-super-secret");

    const del = await app.request("/settings/api-keys/ANTHROPIC_API_KEY", { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(rig.store.getApiKey("ANTHROPIC_API_KEY")).toBeUndefined();
  });

  it("settings/mcp-servers: full CRUD over HTTP", async () => {
    const rig = makeRig({});
    const app = createApp(rig);

    const create = await app.request("/settings/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "higgsfield", kind: "video", command: "higgsfield-mcp", args: ["--x"] }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string; args: string[] };
    expect(created.args).toEqual(["--x"]);

    const list = (await (await app.request("/settings/mcp-servers")).json()) as { id: string }[];
    expect(list).toHaveLength(1);

    const toggle = await app.request(`/settings/mcp-servers/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(toggle.status).toBe(200);
    expect(rig.store.getMcpServer(created.id).enabled).toBe(0);

    const del = await app.request(`/settings/mcp-servers/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(await app.request(`/settings/mcp-servers/${created.id}`, { method: "DELETE" }).then((r) => r.status)).toBe(404);
  });
});
