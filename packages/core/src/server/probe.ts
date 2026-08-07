import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type ProbeResult =
  | { ok: true; detail: string }
  | { ok: false; error: string };

/**
 * Where to send a cheap, read-only auth check per vendor. Deliberately the
 * model-list endpoint rather than a completion: it proves the key is valid
 * without burning a single token of the user's credit.
 */
const KEY_PROBES: Record<string, { url: string; headers: (key: string) => Record<string, string> }> = {
  ANTHROPIC_API_KEY: {
    url: "https://api.anthropic.com/v1/models?limit=1",
    headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }),
  },
  OPENAI_API_KEY: {
    url: "https://api.openai.com/v1/models",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  MOONSHOT_API_KEY: {
    url: "https://api.moonshot.ai/v1/models",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  GROQ_API_KEY: {
    url: "https://api.groq.com/openai/v1/models",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  OPENROUTER_API_KEY: {
    url: "https://openrouter.ai/api/v1/key",
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  GITHUB_TOKEN: {
    url: "https://api.github.com/user",
    headers: (k) => ({ Authorization: `Bearer ${k}`, "User-Agent": "foreman" }),
  },
};

export function isProbeable(name: string): boolean {
  return name in KEY_PROBES;
}

/** Chat endpoint per vendor, used for the generation half of the probe. */
const GEN_PROBES: Record<string, { url: string; body: (model: string) => unknown }> = {
  ANTHROPIC_API_KEY: {
    url: "https://api.anthropic.com/v1/messages",
    body: (model) => ({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  },
  OPENAI_API_KEY: {
    url: "https://api.openai.com/v1/chat/completions",
    body: (model) => ({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  },
  MOONSHOT_API_KEY: {
    url: "https://api.moonshot.ai/v1/chat/completions",
    body: (model) => ({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  },
  GROQ_API_KEY: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    body: (model) => ({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
  },
};

function explainStatus(status: number, body: string): string {
  const snippet = body.replace(/\s+/g, " ").slice(0, 180);
  if (status === 401 || status === 403) return `key rejected (${status})`;
  if (status === 429) {
    return /balance|quota|credit|suspend|billing/i.test(body)
      ? `account out of credit / suspended — ${snippet}`
      : `rate limited (429) — ${snippet}`;
  }
  return `provider returned ${status}${snippet ? ` — ${snippet}` : ""}`;
}

/**
 * Two-step check, because auth alone lies: a suspended account still returns
 * 200 from /models while every actual generation 429s. So we authenticate,
 * then attempt a 1-token completion — the only thing that proves a run will
 * really work. Never echoes the key back, even inside an error string.
 */
export async function probeApiKey(name: string, key: string): Promise<ProbeResult> {
  const probe = KEY_PROBES[name];
  if (!probe) return { ok: false, error: "no connection test available for this key" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    // ---- step 1: does the key authenticate at all?
    const res = await fetch(probe.url, { headers: probe.headers(key), signal: controller.signal });
    if (!res.ok) {
      return { ok: false, error: explainStatus(res.status, await res.text().catch(() => "")) };
    }

    const listed = await res.json().catch(() => ({}));
    const models = ((listed as { data?: { id?: string }[] })?.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");

    // ---- step 2: can it actually generate? (this is what catches no-credit)
    const gen = GEN_PROBES[name];
    if (!gen || models.length === 0) {
      return {
        ok: true,
        detail: models.length ? `${models.length} models — auth OK (generation not tested)` : "authenticated",
      };
    }

    const genRes = await fetch(gen.url, {
      method: "POST",
      headers: { ...probe.headers(key), "Content-Type": "application/json" },
      body: JSON.stringify(gen.body(models[0]!)),
      signal: controller.signal,
    });
    if (genRes.ok) {
      return { ok: true, detail: `${models.length} models, generation works` };
    }
    return {
      ok: false,
      error: `key is valid but generation failed: ${explainStatus(genRes.status, await genRes.text().catch(() => ""))}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.includes("abort") ? "timed out after 20s" : msg.slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reachability + auth check for a user-registered custom endpoint (Ollama,
 * Azure, vLLM, any OpenAI-compatible proxy). Unlike the built-in vendors the
 * URL is the user's, so a clear "can't reach this host" matters more than
 * anything else here.
 */
export async function probeCustomProvider(
  baseUrl: string,
  apiKey: string | null,
  wire: string,
): Promise<ProbeResult> {
  const url = wire === "anthropic"
    ? `${baseUrl.replace(/\/$/, "")}/v1/models?limit=1`
    : `${baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = wire === "anthropic"
    ? { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" }
    : apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (res.ok) {
      const detail = await res
        .json()
        .then((b: unknown) => {
          const data = (b as { data?: unknown[] })?.data;
          return Array.isArray(data) ? `${data.length} models available` : "endpoint reachable";
        })
        .catch(() => "endpoint reachable");
      return { ok: true, detail };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, error: "endpoint rejected the key (401/403)" };
    if (res.status === 404) return { ok: false, error: `no /models endpoint at ${url} — check the base URL` };
    return { ok: false, error: `endpoint returned ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort")) return { ok: false, error: "timed out after 12s — is the server running?" };
    return { ok: false, error: `cannot reach ${baseUrl}: ${msg.slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Actually spawns the MCP server over stdio and lists its tools — the only
 * honest way to know a registered server works before a run depends on it.
 */
export async function probeMcpServer(
  command: string,
  args: string[],
): Promise<ProbeResult & { tools?: string[] }> {
  let client: Client | undefined;
  try {
    const transport = new StdioClientTransport({ command, args, stderr: "pipe" });
    client = new Client({ name: "foreman-probe", version: "0.1.0" });
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => setTimeout(() => reject(new Error("connect timeout")), 10_000)),
    ]);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    return {
      ok: true,
      detail: names.length ? `${names.length} tool(s): ${names.slice(0, 6).join(", ")}` : "connected, exposes no tools",
      tools: names,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 200) };
  } finally {
    if (client) await client.close().catch(() => {});
  }
}
