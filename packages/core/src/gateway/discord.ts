import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import type {
  InboundHandler,
  OutboundMessage,
  PlatformAdapter,
} from "./types.js";

/**
 * Discord adapter (discord.js). Websocket gateway — no public endpoint.
 * Each run gets its own thread in the designated channel: the live build log.
 * DMs work too (thread context absent → active-run routing in the bridge).
 *
 * NOTE: requires a live bot token to integration-test; unit coverage lives
 * in the bridge tests with a fake adapter.
 */
export class DiscordAdapter implements PlatformAdapter {
  readonly name = "discord";
  private readonly client: Client;
  private handler?: InboundHandler;
  /** runId -> threadId */
  private readonly runThreads = new Map<string, string>();

  constructor(
    private readonly token: string,
    private readonly allowed: Set<string>,
    private readonly channelId?: string,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
  }

  async start(handler: InboundHandler): Promise<void> {
    this.handler = handler;

    this.client.on(Events.MessageCreate, (m) => {
      if (m.author.bot || !this.allowed.has(m.author.id)) return;
      const runId = [...this.runThreads.entries()].find(
        ([, tid]) => tid === m.channelId,
      )?.[0];
      void handler({
        platform: "discord",
        userId: m.author.id,
        chatId: m.channelId,
        text: m.content,
        runId,
      });
    });

    this.client.on(Events.InteractionCreate, (i) => {
      if (!i.isButton() || !this.allowed.has(i.user.id)) return;
      const [name = "", runId = ""] = i.customId.split(":");
      void handler({
        platform: "discord",
        userId: i.user.id,
        chatId: i.channelId ?? "",
        action: { name, runId },
      });
      void i.deferUpdate().catch(() => {});
    });

    await this.client.login(this.token);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  async openRunChannel(runId: string, title: string): Promise<string | undefined> {
    if (!this.channelId) return undefined;
    const ch = await this.client.channels.fetch(this.channelId);
    if (ch?.type !== ChannelType.GuildText) return undefined;
    const thread = await ch.threads.create({ name: title.slice(0, 90) });
    this.runThreads.set(runId, thread.id);
    return thread.id;
  }

  async send(msg: OutboundMessage): Promise<void> {
    const ch = await this.client.channels.fetch(msg.chatId);
    if (!ch?.isTextBased() || !("send" in ch)) return;
    const payload: Record<string, unknown> = { content: msg.text };
    if (msg.buttons) {
      payload.components = [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          msg.buttons.map((b) =>
            new ButtonBuilder()
              .setCustomId(`${b.action}:${b.runId}`)
              .setLabel(b.label)
              .setStyle(ButtonStyle.Primary),
          ),
        ),
      ];
    }
    await (ch as { send: (p: unknown) => Promise<unknown> }).send(payload);
  }

  async sendMedia(chatId: string, path: string, caption?: string): Promise<void> {
    const ch = await this.client.channels.fetch(chatId);
    if (!ch?.isTextBased() || !("send" in ch)) return;
    await (ch as { send: (p: unknown) => Promise<unknown> }).send({
      content: caption ?? "",
      files: [path],
    });
  }
}
