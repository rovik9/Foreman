import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramAdapter } from "../src/gateway/telegram.js";
import type { InboundMessage } from "../src/gateway/types.js";

function apiOk(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

describe("TelegramAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes messages from allowlisted users, ignores strangers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(apiOk(true)));
    const adapter = new TelegramAdapter("tok", new Set(["111"]));
    const received: InboundMessage[] = [];
    await adapter.start((m) => {
      received.push(m);
      return Promise.resolve();
    });

    await adapter.handleUpdate({
      update_id: 1,
      message: { message_id: 1, text: "hello", from: { id: 111 }, chat: { id: 222 } },
    });
    await adapter.handleUpdate({
      update_id: 2,
      message: { message_id: 2, text: "intruder", from: { id: 999 }, chat: { id: 222 } },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      platform: "telegram",
      userId: "111",
      chatId: "222",
      text: "hello",
    });
    await adapter.stop();
  });

  it("maps callback queries to actions and acknowledges them", async () => {
    const fetchMock = vi.fn().mockResolvedValue(apiOk(true));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new TelegramAdapter("tok", new Set(["111"]));
    const received: InboundMessage[] = [];
    await adapter.start((m) => {
      received.push(m);
      return Promise.resolve();
    });

    await adapter.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cb1",
        data: "approve:run-123",
        from: { id: 111 },
        message: { chat: { id: 222 } },
      },
    });

    expect(received[0]!.action).toEqual({ name: "approve", runId: "run-123" });
    const ackCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("answerCallbackQuery"),
    );
    expect(ackCall).toBeDefined();
    await adapter.stop();
  });

  it("sends approval buttons as inline keyboards", async () => {
    const fetchMock = vi.fn().mockResolvedValue(apiOk({ message_id: 5 }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new TelegramAdapter("tok", new Set(["111"]));

    await adapter.send({
      chatId: "222",
      text: "needs you",
      buttons: [
        { label: "✅ Approve", action: "approve", runId: "r1" },
        { label: "🛑 Stop", action: "stop", runId: "r1" },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("sendMessage");
    const body = JSON.parse(init.body as string);
    expect(body.reply_markup.inline_keyboard[0][0]).toEqual({
      text: "✅ Approve",
      callback_data: "approve:r1",
    });
    expect(body.reply_markup.inline_keyboard[0][1].callback_data).toBe("stop:r1");
  });

  it("throws a clear error when the API rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, description: "chat not found" })),
      ),
    );
    const adapter = new TelegramAdapter("tok", new Set(["111"]));
    await expect(adapter.send({ chatId: "x", text: "hi" })).rejects.toThrow(
      /chat not found/,
    );
  });
});
