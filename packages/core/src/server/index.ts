import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { AgentHarness } from "../agents/harness.js";
import { loadConfig } from "../config/load.js";
import { ForemanBus } from "../events/bus.js";
import { GatewayBridge } from "../gateway/bridge.js";
import { DiscordAdapter } from "../gateway/discord.js";
import { TelegramAdapter } from "../gateway/telegram.js";
import { buildProvidersFromEnv } from "../providers/factory.js";
import { runPipeline, type RunnerDeps } from "../pipeline/runner.js";
import { Store } from "../store/db.js";
import { createApp } from "./app.js";

try {
  process.loadEnvFile();
} catch {
  // no .env yet — providers for missing keys will error clearly at call time
}

const root = resolve(import.meta.dirname, "../../../..");
const config = loadConfig(resolve(root, "config"));
const store = new Store(resolve(root, "foreman.db"));
const bus = new ForemanBus();
const providers = buildProvidersFromEnv();
const harness = new AgentHarness(config, store, bus, providers);

const runnerDeps: RunnerDeps = {
  config,
  store,
  bus,
  harness,
  memoryDir: resolve(root, config.memory.mirror_dir),
};

const app = createApp(runnerDeps);

// ---- DM gateway (Telegram + Discord); adapters boot only with tokens ----
const bridge = new GatewayBridge({
  store,
  bus,
  startRun: (runId) => void runPipeline(runnerDeps, runId),
});
const idSet = (v?: string): Set<string> =>
  new Set((v ?? "").split(",").map((s) => s.trim()).filter(Boolean));

if (process.env.TELEGRAM_BOT_TOKEN) {
  await bridge.register(
    new TelegramAdapter(
      process.env.TELEGRAM_BOT_TOKEN,
      idSet(process.env.TELEGRAM_ALLOWED_USER_IDS),
    ),
  );
  console.log("  telegram: online");
}
if (process.env.DISCORD_BOT_TOKEN) {
  await bridge.register(
    new DiscordAdapter(
      process.env.DISCORD_BOT_TOKEN,
      idSet(process.env.DISCORD_ALLOWED_USER_IDS),
      process.env.DISCORD_GUILD_ID,
    ),
  );
  console.log("  discord: online");
}

const port = Number(process.env.PORT ?? 7700);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`\n  ● FOREMAN mission control → http://localhost:${info.port}\n`);
  console.log(
    `  providers: ${Object.keys(providers).join(", ") || "none (set keys in .env)"}`,
  );
});
