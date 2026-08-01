import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.js";

const OK_BODY = {
  content: [
    { type: "text", text: "part one. " },
    { type: "text", text: "part two." },
  ],
  model: "claude-sonnet-5",
  usage: { input_tokens: 50, output_tokens: 12 },
};

describe("AnthropicProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends system separately and maps native usage fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(OK_BODY), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const p = new AnthropicProvider("sk-ant-test");
    const r = await p.chat(
      [
        { role: "system", content: "you are the PM" },
        { role: "user", content: "hi" },
      ],
      { model: "claude-sonnet-5" },
    );

    expect(r.content).toBe("part one. part two.");
    expect(r.promptTokens).toBe(50);
    expect(r.completionTokens).toBe(12);
    expect(r.costUsd).toBe(0); // price table estimates instead

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("sk-ant-test");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    const sent = JSON.parse(init.body);
    expect(sent.system).toBe("you are the PM");
    expect(sent.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("throws with provider message on error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), {
          status: 401,
        }),
      ),
    );
    const p = new AnthropicProvider("bad");
    await expect(
      p.chat([{ role: "user", content: "hi" }], { model: "m" }),
    ).rejects.toThrow(/401.*invalid x-api-key/);
  });
});
