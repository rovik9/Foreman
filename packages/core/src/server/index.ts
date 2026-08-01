import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { AgentHarness } from "../agents/harness.js";
import { loadConfig } from "../config/load.js";
import { ForemanBus } from "../events/bus.js";
import { buildProvidersFromEnv } from "../providers/factory.js";
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

const app = createApp({
  config,
  store,
  bus,
  harness,
  memoryDir: resolve(root, config.memory.mirror_dir),
});

const port = Number(process.env.PORT ?? 7700);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`\n  ● FOREMAN mission control → http://localhost:${info.port}\n`);
  console.log(
    `  providers: ${Object.keys(providers).join(", ") || "none (set keys in .env)"}`,
  );
});
