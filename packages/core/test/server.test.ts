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
      body: JSON.stringify({ prompt: "build me a landing page" }),
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
});
