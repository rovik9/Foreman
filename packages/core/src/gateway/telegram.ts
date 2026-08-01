import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type {
  InboundHandler,
  OutboundMessage,
  PlatformAdapter,
} from "./types.js";

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    from?: { id: number };
    chat: { id: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: { chat: { id: number } };
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Telegram adapter — raw Bot API, zero dependencies.
 * Long-polling: works behind home NAT, no public endpoint needed.
 */
export class TelegramAdapter implements PlatformAdapter {
  readonly name = "telegram";
  private handler?: InboundHandler;
  private offset = 0;
  private readonly abort = new AbortController();

  constructor(
    private readonly token: string,
    private readonly allowed: Set<string>,
    private readonly apiBase = "https://api.telegram.org",
  ) {}

  start(handler: InboundHandler): Promise<void> {
    this.handler = handler;
    void this.pollLoop();
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.abort.abort();
    return Promise.resolve();
  }

  private async api(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<unknown> {
    const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(timeoutMs),
      ]),
    });
    const body = (await res.json()) as {
      ok: boolean;
      result?: unknown;
      description?: string;
    };
    if (!body.ok) {
      throw new Error(`telegram ${method}: ${body.description ?? res.status}`);
    }
    return body.result;
  }

  private async pollLoop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        const updates = (await this.api(
          "getUpdates",
          { offset: this.offset, timeout: 30 },
          35_000,
        )) as TgUpdate[];
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handleUpdate(u);
        }
      } catch {
        if (!this.abort.signal.aborted) await sleep(3000);
      }
    }
  }

  /** Public for tests: normalize one update into an InboundMessage. */
  async handleUpdate(u: TgUpdate): Promise<void> {
    if (u.message?.text && u.message.from) {
      const userId = String(u.message.from.id);
      if (!this.allowed.has(userId)) return; // authz: strangers get nothing
      await this.handler?.({
        platform: "telegram",
        userId,
        chatId: String(u.message.chat.id),
        text: u.message.text,
      });
      return;
    }
    if (u.callback_query) {
      const cb = u.callback_query;
      const userId = String(cb.from.id);
      if (!this.allowed.has(userId)) return;
      const [name = "", runId = ""] = (cb.data ?? "").split(":");
      await this.handler?.({
        platform: "telegram",
        userId,
        chatId: String(cb.message?.chat.id ?? ""),
        action: { name, runId },
      });
      await this.api("answerCallbackQuery", { callback_query_id: cb.id }).catch(
        () => {},
      );
    }
  }

  async send(msg: OutboundMessage): Promise<void> {
    await this.api("sendMessage", {
      chat_id: msg.chatId,
      text: msg.text,
      ...(msg.buttons
        ? {
            reply_markup: {
              inline_keyboard: [
                msg.buttons.map((b) => ({
                  text: b.label,
                  callback_data: `${b.action}:${b.runId}`,
                })),
              ],
            },
          }
        : {}),
    });
  }

  async sendMedia(chatId: string, path: string, caption?: string): Promise<void> {
    const ext = extname(path).toLowerCase();
    const [method, field] = [".mp4", ".webm", ".mov"].includes(ext)
      ? ["sendVideo", "video"]
      : [".mp3", ".wav", ".m4a"].includes(ext)
        ? ["sendAudio", "audio"]
        : [".png", ".jpg", ".jpeg", ".webp"].includes(ext)
          ? ["sendPhoto", "photo"]
          : ["sendDocument", "document"];

    const form = new FormData();
    form.set("chat_id", chatId);
    if (caption) form.set("caption", caption);
    form.set(field, new Blob([readFileSync(path)]), basename(path));

    const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: "POST",
      body: form,
      signal: this.abort.signal,
    });
    const body = (await res.json()) as { ok: boolean; description?: string };
    if (!body.ok) {
      throw new Error(`telegram ${method}: ${body.description ?? res.status}`);
    }
  }
}
