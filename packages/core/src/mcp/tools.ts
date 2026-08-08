import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpTool, ToolResult } from "../agents/tools.js";
import type { McpServerRow } from "../store/db.js";

/**
 * Turns the MCP servers a user connected in Settings into tools the builder
 * can actually call. Previously servers could be registered and tested but
 * nothing ever invoked them — they were inert.
 *
 * Connections are opened per call and closed after. That's slower than a pool,
 * but a builder makes a handful of tool calls over minutes, and a pooled stdio
 * child process that dies mid-run is a much worse failure than a reconnect.
 */

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 120_000;

async function withClient<T>(
  server: McpServerRow,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StdioClientTransport({
    command: server.command,
    args: JSON.parse(server.args) as string[],
    stderr: "pipe",
  });
  const client = new Client({ name: "foreman", version: "0.1.0" });
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("connect timeout")), CONNECT_TIMEOUT_MS),
      ),
    ]);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

function renderResult(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks
    .map((b) => {
      const block = b as { type?: string; text?: string };
      if (block.type === "text" && block.text) return block.text;
      return `[${block.type ?? "unknown"} block]`;
    })
    .join("\n");
  return text || "(tool returned no content)";
}

/**
 * Discovers the tools every enabled server exposes. Best-effort per server: a
 * server that's down must never stop a run, it just contributes no tools.
 */
export async function loadMcpTools(
  servers: McpServerRow[],
  onProblem?: (server: string, error: string) => void,
): Promise<McpTool[]> {
  const tools: McpTool[] = [];

  for (const server of servers) {
    try {
      const listed = await withClient(server, async (c) => (await c.listTools()).tools);
      for (const t of listed) {
        tools.push({
          // namespaced: two servers may both expose "generate"
          name: `${server.name}.${t.name}`,
          description: t.description ?? "",
          call: async (args): Promise<ToolResult> => {
            try {
              const result = await withClient(server, (c) =>
                Promise.race([
                  c.callTool({ name: t.name, arguments: args }),
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error("tool call timed out")), CALL_TIMEOUT_MS),
                  ),
                ]),
              );
              return {
                ok: !(result as { isError?: boolean }).isError,
                output: renderResult((result as { content?: unknown }).content),
              };
            } catch (err) {
              return { ok: false, output: err instanceof Error ? err.message : String(err) };
            }
          },
        });
      }
    } catch (err) {
      onProblem?.(server.name, err instanceof Error ? err.message : String(err));
    }
  }

  return tools;
}
