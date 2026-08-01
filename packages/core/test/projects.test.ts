import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { makeRig } from "./helpers.js";

const FULL_PAYLOAD = {
  name: "Rovik Capital",
  memory_dir: "~/foreman-memory/rovik-capital",
  memory_repo: "git@github.com:rovik/rovik-capital-memory.git",
  workspace_dirs: ["~/code/rovik-capital", "~/code/rovik-scripts"],
  code_repos: ["git@github.com:rovik/rovik-capital.git"],
};

describe("projects API", () => {
  it("creates a project with the full payload and lists it", async () => {
    const app = createApp(makeRig({}));
    const create = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(FULL_PAYLOAD),
    });
    expect(create.status).toBe(201);
    const p = (await create.json()) as Record<string, unknown>;
    expect(p.slug).toBe("rovik-capital");
    expect(p.memory_repo).toBe(FULL_PAYLOAD.memory_repo);
    expect(JSON.parse(p.workspace_dirs as string)).toHaveLength(2);
    expect(JSON.parse(p.code_repos as string)).toHaveLength(1);

    const list = await app.request("/projects");
    expect(((await list.json()) as unknown[]).length).toBe(1);
  });

  it("rejects duplicates with 409", async () => {
    const app = createApp(makeRig({}));
    const post = () =>
      app.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Rovik Capital" }),
      });
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(409);
  });

  it("deletes a project and 404s on unknown slugs", async () => {
    const app = createApp(makeRig({}));
    await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Temp Project" }),
    });
    const del = await app.request("/projects/temp-project", { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(((await (await app.request("/projects")).json()) as unknown[]).length).toBe(0);
    expect((await app.request("/projects/ghost", { method: "DELETE" })).status).toBe(404);
  });

  it("binds runs to a project and rejects unknown ones", async () => {
    const rig = makeRig({});
    const app = createApp(rig);
    await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bound Project" }),
    });

    const ok = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "x", project: "bound-project" }),
    });
    expect(ok.status).toBe(201);
    const { id } = (await ok.json()) as { id: string };
    expect(rig.store.getRun(id).product).toBe("bound-project");

    const bad = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "x", project: "nope" }),
    });
    expect(bad.status).toBe(400);
  });
});
