import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterProvider } from "../src/providers/openrouter.js";

const OK_BODY = {
  choices: [{ message: { content: "ship it" } }],
  model: "moonshotai/kimi-k3",
  usage: { prompt_tokens: 120, completion_tokens: 40, cost: 0.0042 },
};

describe("OpenRouterProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns content and meters usage/cost", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(OK_BODY), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const p = new OpenRouterProvider("sk-test");
    const r = await p.chat([{ role: "user", content: "hi" }], {
      model: "moonshotai/kimi-k3",
    });

    expect(r.content).toBe("ship it");
    expect(r.promptTokens).toBe(120);
    expect(r.completionTokens).toBe(40);
    expect(r.costUsd).toBeCloseTo(0.0042, 6);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const sent = JSON.parse(init.body);
    expect(sent.usage).toEqual({ include: true });
    expect(sent.model).toBe("moonshotai/kimi-k3");
  });

  it("throws with provider message on error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
        }),
      ),
    );
    const p = new OpenRouterProvider("sk-bad");
    await expect(
      p.chat([{ role: "user", content: "hi" }], { model: "m" }),
    ).rejects.toThrow(/401.*bad key/);
  });

  it("defaults cost to 0 when provider omits it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "x" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200 },
        ),
      ),
    );
    const p = new OpenRouterProvider("sk-test");
    const r = await p.chat([{ role: "user", content: "hi" }], { model: "m" });
    expect(r.costUsd).toBe(0);
  });
});
