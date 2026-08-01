import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  Provider,
} from "./types.js";

/**
 * Scriptable fake provider — queue canned responses per model id.
 * Powers the E2E demo and tests without burning API keys.
 */
export class MockProvider implements Provider {
  private readonly queues: Record<string, string[]>;
  readonly calls: { model: string; input: string }[] = [];

  constructor(script: Record<string, string[]>) {
    this.queues = structuredClone(script);
  }

  chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const q = this.queues[opts.model];
    const content = q && q.length > 0 ? q.shift()! : "{}";
    this.calls.push({
      model: opts.model,
      input: messages[messages.length - 1]?.content ?? "",
    });
    return Promise.resolve({
      content,
      model: opts.model,
      promptTokens: 120,
      completionTokens: 60,
      costUsd: 0.0011,
    });
  }
}
