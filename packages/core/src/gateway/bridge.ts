import type { ForemanBus } from "../events/bus.js";
import type { Store } from "../store/db.js";
import type {
  InboundMessage,
  OutboundMessage,
  PlatformAdapter,
} from "./types.js";

export interface BridgeDeps {
  store: Store;
  bus: ForemanBus;
  /** kicks the pipeline for a run (create or resume) */
  startRun: (runId: string) => void;
}

const MEDIA_KINDS = new Set(["video", "audio", "image"]);

/**
 * The gateway brain. Adapters deliver normalized inbound messages; the
 * bridge owns all decisions: new run vs steering vs command vs approval,
 * status fan-out, approval buttons, asset delivery.
 *
 * Message semantics:
 * - "/run <prompt>" or plain text with no active run  -> new run
 * - plain text with an active run                     -> steering / answer
 * - "/status" | "/stop"                               -> controls
 * - button action approve/iterate/stop                -> approvals
 */
export class GatewayBridge {
  private readonly adapters: PlatformAdapter[] = [];
  /** "<platform>:<userId>" -> active runId */
  private readonly activeRuns = new Map<string, string>();
  /** runId -> origin chat */
  private readonly runChats = new Map<
    string,
    { platform: string; chatId: string }
  >();

  constructor(private readonly deps: BridgeDeps) {}

  async register(adapter: PlatformAdapter): Promise<void> {
    this.adapters.push(adapter);
    await adapter.start((msg) => this.onInbound(msg));
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.adapters.map((a) => a.stop().catch(() => {})));
  }

  private adapterFor(platform: string): PlatformAdapter | undefined {
    return this.adapters.find((a) => a.name === platform);
  }

  private async reply(msg: OutboundMessage & { platform?: string }): Promise<void> {
    const adapter = this.adapterFor(msg.platform ?? this.platformOfChat(msg.chatId));
    await adapter?.send(msg).catch(() => {});
  }

  private platformOfChat(chatId: string): string {
    for (const [, v] of this.runChats) {
      if (v.chatId === chatId) return v.platform;
    }
    return this.adapters[0]?.name ?? "";
  }

  async onInbound(msg: InboundMessage): Promise<void> {
    const key = `${msg.platform}:${msg.userId}`;

    if (msg.action) {
      await this.onAction(msg, key);
      return;
    }

    const text = msg.text?.trim() ?? "";
    if (!text) return;

    if (text.startsWith("/")) {
      await this.onCommand(msg, key, text);
      return;
    }

    const activeRunId = msg.runId ?? this.activeRuns.get(key);
    if (activeRunId) {
      const run = this.deps.store.getRun(activeRunId);
      this.deps.store.addMessage({
        runId: activeRunId,
        role: "user",
        content: `[${msg.platform}] ${text}`,
      });
      this.deps.bus.emit({
        type: "message",
        runId: activeRunId,
        data: { role: "user", content: text, via: msg.platform },
      });
      if (["awaiting_user", "paused_budget", "failed"].includes(run.status)) {
        await this.reply({
          platform: msg.platform,
          chatId: msg.chatId,
          text: "Resuming with your input…",
        });
        this.deps.startRun(activeRunId);
      } else {
        await this.reply({
          platform: msg.platform,
          chatId: msg.chatId,
          text: "Noted — the crew will see your steering on the next step.",
        });
      }
      return;
    }

    await this.createRun(msg, key, text);
  }

  private async onCommand(
    msg: InboundMessage,
    key: string,
    text: string,
  ): Promise<void> {
    const [cmd, ...rest] = text.split(/\s+/);
    switch (cmd) {
      case "/run": {
        const prompt = rest.join(" ").trim();
        if (!prompt) {
          await this.reply({ platform: msg.platform, chatId: msg.chatId, text: "Usage: /run <what to build>" });
          return;
        }
        await this.createRun(msg, key, prompt);
        return;
      }
      case "/status": {
        const runId = msg.runId ?? this.activeRuns.get(key);
        if (!runId) {
          await this.reply({ platform: msg.platform, chatId: msg.chatId, text: "No active run. Send me something to build." });
          return;
        }
        const run = this.deps.store.getRun(runId);
        const tasks = this.deps.store.listTasks(runId);
        await this.reply({
          platform: msg.platform,
          chatId: msg.chatId,
          text:
            `Run ${runId.slice(0, 8)} — ${run.status} — $${run.cost_usd.toFixed(4)}\n` +
            (tasks.length
              ? tasks.map((t) => `• ${t.status.padEnd(10)} ${t.description}`).join("\n")
              : "planning…"),
        });
        return;
      }
      case "/stop": {
        const runId = msg.runId ?? this.activeRuns.get(key);
        if (!runId) {
          await this.reply({ platform: msg.platform, chatId: msg.chatId, text: "No active run to stop." });
          return;
        }
        this.deps.store.setRunStatus(runId, "stopped");
        await this.reply({ platform: msg.platform, chatId: msg.chatId, text: `Run ${runId.slice(0, 8)} stopped.` });
        return;
      }
      default:
        await this.reply({
          platform: msg.platform,
          chatId: msg.chatId,
          text: "Commands: /run <prompt> · /status · /stop — or just tell me what to build.",
        });
    }
  }

  private async onAction(msg: InboundMessage, key: string): Promise<void> {
    const { name, runId } = msg.action!;
    switch (name) {
      case "approve":
        this.deps.store.addMessage({ runId, role: "user", content: `[${msg.platform}] approved — continue` });
        await this.reply({ platform: msg.platform, chatId: msg.chatId, text: "Approved. Resuming…" });
        this.deps.startRun(runId);
        return;
      case "iterate":
        this.deps.store.addMessage({ runId, role: "user", content: `[${msg.platform}] iterate on the feedback` });
        await this.reply({ platform: msg.platform, chatId: msg.chatId, text: "Iterating…" });
        this.deps.startRun(runId);
        return;
      case "stop":
        this.deps.store.setRunStatus(runId, "stopped");
        await this.reply({ platform: msg.platform, chatId: msg.chatId, text: `Run ${runId.slice(0, 8)} stopped.` });
        return;
      default:
        await this.reply({ platform: msg.platform, chatId: msg.chatId, text: `Unknown action: ${name}` });
    }
    void key;
  }

  private async createRun(
    msg: InboundMessage,
    key: string,
    prompt: string,
  ): Promise<void> {
    const run = this.deps.store.createRun(prompt);
    this.deps.store.addMessage({
      runId: run.id,
      role: "user",
      content: `[${msg.platform}] ${prompt}`,
    });
    this.activeRuns.set(key, run.id);

    let chatId = msg.chatId;
    const adapter = this.adapterFor(msg.platform);
    if (adapter?.openRunChannel) {
      const dedicated = await adapter
        .openRunChannel(run.id, `run-${run.id.slice(0, 8)} ${prompt}`)
        .catch(() => undefined);
      if (dedicated) chatId = dedicated;
    }
    this.runChats.set(run.id, { platform: msg.platform, chatId });
    this.forwardEvents(run.id);

    await this.reply({
      platform: msg.platform,
      chatId,
      text: `Run ${run.id.slice(0, 8)} dispatched: "${prompt.slice(0, 80)}"\nI'll report live. /status anytime, /stop to halt.`,
    });
    this.deps.startRun(run.id);
  }

  /** Fan run events out to the originating chat. */
  private forwardEvents(runId: string): void {
    const origin = this.runChats.get(runId);
    if (!origin) return;
    const adapter = this.adapterFor(origin.platform);
    if (!adapter) return;

    const unsub = this.deps.bus.subscribe(runId, (e) => {
      if (e.type === "run_status") {
        const data = e.data as { status: string; costUsd?: number; questions?: string[] };
        if (data.status === "awaiting_user") {
          void adapter.send({
            chatId: origin.chatId,
            text: `Run needs you${data.questions ? `:\n${data.questions.join("\n")}` : "."}`,
            buttons: [
              { label: "✅ Approve", action: "approve", runId },
              { label: "🔁 Iterate", action: "iterate", runId },
              { label: "🛑 Stop", action: "stop", runId },
            ],
          }).catch(() => {});
        } else if (["completed", "failed", "stopped", "paused_budget"].includes(data.status)) {
          void adapter.send({
            chatId: origin.chatId,
            text: `Run ${runId.slice(0, 8)} → ${data.status}${data.costUsd !== undefined ? ` ($${data.costUsd.toFixed(4)})` : ""}`,
          }).catch(() => {});
        }
      }
      if (e.type === "artifact") {
        const a = e.data as { path: string; kind: string };
        if (MEDIA_KINDS.has(a.kind) && adapter.sendMedia) {
          void adapter.sendMedia(origin.chatId, a.path, a.kind).catch(() => {});
        }
      }
      if (["completed", "failed", "stopped"].includes(
        (e.data as { status?: string }).status ?? "",
      )) {
        unsub();
      }
    });
  }
}
