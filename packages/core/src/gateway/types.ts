/** Platform-agnostic gateway types — one bridge, N adapters. */

export interface GatewayAction {
  name: "approve" | "iterate" | "stop" | string;
  runId: string;
}

export interface InboundMessage {
  platform: string;
  userId: string;
  chatId: string;
  text?: string;
  /** set when the chat context implies the run (e.g. a Discord run thread) */
  runId?: string;
  action?: GatewayAction;
}

export interface GatewayButton {
  label: string;
  action: string;
  runId: string;
}

export interface OutboundMessage {
  chatId: string;
  text: string;
  buttons?: GatewayButton[];
}

export type InboundHandler = (msg: InboundMessage) => Promise<void>;

/**
 * A platform adapter is a thin IO shell: it authenticates, filters
 * non-allowlisted users, normalizes inbound messages, and renders outbound
 * ones. ALL logic lives in the bridge.
 */
export interface PlatformAdapter {
  readonly name: string;
  start(handler: InboundHandler): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  sendMedia?(chatId: string, path: string, caption?: string): Promise<void>;
  /** optional: open a dedicated channel/thread for a run, return its chatId */
  openRunChannel?(runId: string, title: string): Promise<string | undefined>;
}
