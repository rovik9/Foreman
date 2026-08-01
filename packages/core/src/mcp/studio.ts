import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AssetStudioConfig } from "../config/schema.js";

export type AssetKind = "video" | "audio" | "image";

export interface StudioResult {
  ok: boolean;
  artifacts: { path: string; kind: AssetKind }[];
  error?: string;
}

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Asset studio — talks to external generation tools (Higgsfield video, audio
 * MCPs) over MCP stdio. Design rule: the studio must NEVER crash a run. Any
 * failure (server missing, tool error, timeout) degrades to ok:false and the
 * pipeline continues without assets.
 */
export class AssetStudio {
  constructor(
    private readonly cfg: AssetStudioConfig,
    private readonly kind: AssetKind,
  ) {}

  async generate(prompt: string): Promise<StudioResult> {
    let client: Client | undefined;
    try {
      const transport = new StdioClientTransport({
        command: this.cfg.command,
        args: this.cfg.args,
        stderr: "pipe",
      });
      client = new Client({ name: "foreman", version: "0.1.0" });
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("connect timeout")), CONNECT_TIMEOUT_MS),
        ),
      ]);

      const { tools } = await client.listTools();
      const tool = tools.find((t) =>
        /generate|create|render|make/i.test(t.name),
      );
      if (!tool) {
        return {
          ok: false,
          artifacts: [],
          error: `studio "${this.cfg.command}" exposes no generation tool (found: ${tools.map((t) => t.name).join(", ") || "none"})`,
        };
      }

      const result = await client.callTool({
        name: tool.name,
        arguments: { prompt, kind: this.kind },
      });

      // MCP tool results are content blocks; studios are expected to return
      // saved file paths as text blocks (one per line) or structured content.
      const texts = (result.content as { type: string; text?: string }[])
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!);
      const paths = texts
        .flatMap((t) => t.split("\n"))
        .map((l) => l.trim())
        .filter((l) => l.startsWith("/") || l.startsWith("./"));

      return {
        ok: paths.length > 0,
        artifacts: paths.map((path) => ({ path, kind: this.kind })),
        ...(paths.length === 0
          ? { error: "studio returned no artifact paths" }
          : {}),
      };
    } catch (err) {
      return {
        ok: false,
        artifacts: [],
        error: `asset studio unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      if (client) {
        await client.close().catch(() => {});
      }
    }
  }
}
