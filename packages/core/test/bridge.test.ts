import { describe, expect, it, vi } from "vitest";
import { GatewayBridge } from "../src/gateway/bridge.js";
import type {
  InboundHandler,
  OutboundMessage,
  PlatformAdapter,
} from "../src/gateway/types.js";
import { DEFAULT_RUN_MODE } from "../src/store/db.js";
import { makeRig } from "./helpers.js";

/** Capturing fake adapter — the bridge tests exercise all logic through it. */
class FakeAdapter implements PlatformAdapter {
  readonly name: string;
  sent: OutboundMessage[] = [];
  media: { chatId: string; path: string }[] = [];
  handler?: InboundHandler;

  constructor(name = "fake") {
    this.name = name;
  }

  start(handler: InboundHandler): Promise<void> {
    this.handler = handler;
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
    return Promise.resolve();
  }
  sendMedia(chatId: string, path: string): Promise<void> {
    this.media.push({ chatId, path });
    return Promise.resolve();
  }
}

function makeBridge() {
  const rig = makeRig({});
  const startRun = vi.fn();
  const bridge = new GatewayBridge({
    store: rig.store,
    bus: rig.bus,
    startRun,
  });
  const adapter = new FakeAdapter();
  return { rig, bridge, adapter, startRun };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe("GatewayBridge", () => {
  it("plain text with no active run creates a run and starts the pipeline", async () => {
    const { rig, bridge, adapter, startRun } = makeBridge();
    await bridge.register(adapter);

    await adapter.handler!({
      platform: "fake",
      userId: "u1",
      chatId: "c1",
      text: "build me a defi dashboard",
    });

    expect(startRun).toHaveBeenCalledOnce();
    const runs = rig.store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.prompt).toBe("build me a defi dashboard");
    expect(adapter.sent.at(-1)!.text).toContain("dispatched");
    // A DM must not dump straight into the crew either. This defaulted to
    // "full" while HTTP defaulted to "discuss", so Telegram/Discord silently
    // skipped the discuss gate.
    expect(runs[0]!.mode).toBe(DEFAULT_RUN_MODE);
    expect(runs[0]!.approved).toBe(0);
  });

  it("plain text with an active running run becomes steering (no resume)", async () => {
    const { rig, bridge, adapter, startRun } = makeBridge();
    await bridge.register(adapter);
    await adapter.handler!({ platform: "fake", userId: "u1", chatId: "c1", text: "task one" });
    const runId = rig.store.listRuns()[0]!.id;
    rig.store.setRunStatus(runId, "running");
    startRun.mockClear();

    await adapter.handler!({ platform: "fake", userId: "u1", chatId: "c1", text: "use dark theme" });

    expect(startRun).not.toHaveBeenCalled();
    const msgs = rig.store.listMessages(runId) as { content: string }[];
    expect(msgs.some((m) => m.content.includes("dark theme"))).toBe(true);
    expect(adapter.sent.at(-1)!.text).toContain("steering");
  });

  it("plain text resumes an awaiting_user run", async () => {
    const { rig, bridge, adapter, startRun } = makeBridge();
    await bridge.register(adapter);
    await adapter.handler!({ platform: "fake", userId: "u1", chatId: "c1", text: "task one" });
    const runId = rig.store.listRuns()[0]!.id;
    rig.store.setRunStatus(runId, "awaiting_user");
    startRun.mockClear();

    await adapter.handler!({ platform: "fake", userId: "u1", chatId: "c1", text: "answer: web app" });

    expect(startRun).toHaveBeenCalledWith(runId);
    expect(adapter.sent.at(-1)!.text).toContain("Resuming");
  });

  it("/status reports the active run", async () => {
    const { rig, bridge, adapter } = makeBridge();
    await bridge.register(adapter);
    await adapter.handler!({ platform: "fake", userId: "u1", chatId: "c1", text: "task one" });
    await adapter.handler!({ platform: "fake", userId: "u1", chatId: "c1", text: "/status" });

    const runId = rig.store.listRuns()[0]!.id;
    expect(adapter.sent.at(-1)!.text).toContain(runId.slice(0, 8));
  });

  it("/stop marks the run stopped", async () => {
    const { rig, bridge, adapter } = makeBridge();
    await bridge.register(adapter);
    await adapter.handler!({ platform: "fake", userId: "u1", chatId: "c1", text: "task one" });
    const runId = rig.store.listRuns()[0]!.id;

    await adapter.handler!({ platform: "fake", userId: "u1", chatId: "c1", text: "/stop" });

    expect(rig.store.getRun(runId).status).toBe("stopped");
  });

  it("approve action resumes the run", async () => {
    const { rig, bridge, adapter, startRun } = makeBridge();
    await bridge.register(adapter);
    await adapter.handler!({ platform: "fake", userId: "u1", chatId: "c1", text: "task one" });
    const runId = rig.store.listRuns()[0]!.id;
    rig.store.setRunStatus(runId, "awaiting_user");
    startRun.mockClear();

    await adapter.handler!({
      platform: "fake",
      userId: "u1",
      chatId: "c1",
      action: { name: "approve", runId },
    });

    expect(startRun).toHaveBeenCalledWith(runId);
  });

  it("fans run status out to the origin chat with approval buttons", async () => {
    const { rig, bridge, adapter } = makeBridge();
    await bridge.register(adapter);
    await adapter.handler!({ platform: "fake", userId: "u1", chatId: "c1", text: "task one" });
    const runId = rig.store.listRuns()[0]!.id;

    rig.bus.emit({ type: "run_status", runId, data: { status: "awaiting_user", questions: ["Web or CLI?"] } });
    await tick();

    const ask = adapter.sent.at(-1)!;
    expect(ask.text).toContain("Web or CLI?");
    expect(ask.buttons!.map((b) => b.action)).toEqual(["approve", "iterate", "stop"]);
  });

  it("delivers media artifacts to the origin chat", async () => {
    const { rig, bridge, adapter } = makeBridge();
    await bridge.register(adapter);
    await adapter.handler!({ platform: "fake", userId: "u1", chatId: "c1", text: "task one" });
    const runId = rig.store.listRuns()[0]!.id;

    rig.bus.emit({ type: "artifact", runId, data: { path: "/tmp/hero.mp4", kind: "video" } });
    await tick();

    expect(adapter.media).toEqual([{ chatId: "c1", path: "/tmp/hero.mp4" }]);
  });
});
