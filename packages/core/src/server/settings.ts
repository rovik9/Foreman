/**
 * The known, nameable API keys the settings UI always shows a row for
 * (set or not) — everything else in api_keys is still readable/writable
 * by name, this is just what renders without the user typing a raw env
 * var name. Grouped for the UI; "provider" keys are also the ones
 * providers/factory.ts resolves live for model routing.
 */
export interface KnownKey {
  name: string;
  label: string;
  group: "provider" | "integration" | "gateway";
}

export const KNOWN_API_KEYS: KnownKey[] = [
  { name: "ANTHROPIC_API_KEY", label: "Anthropic (Claude)", group: "provider" },
  { name: "OPENAI_API_KEY", label: "OpenAI", group: "provider" },
  { name: "MOONSHOT_API_KEY", label: "Moonshot (Kimi)", group: "provider" },
  { name: "GROQ_API_KEY", label: "Groq", group: "provider" },
  { name: "OPENROUTER_API_KEY", label: "OpenRouter (escape hatch)", group: "provider" },
  { name: "GITHUB_TOKEN", label: "GitHub (auto-create memory repos)", group: "integration" },
  { name: "HIGGSFIELD_API_KEY", label: "Higgsfield (asset generation)", group: "integration" },
  // gateway — these are read at boot, so a change here needs a restart to
  // reconnect the bot; the UI says so rather than pretending it's live.
  { name: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", group: "gateway" },
  { name: "TELEGRAM_ALLOWED_USER_IDS", label: "Telegram allowed user IDs", group: "gateway" },
  { name: "DISCORD_BOT_TOKEN", label: "Discord bot token", group: "gateway" },
  { name: "DISCORD_GUILD_ID", label: "Discord server (guild) ID", group: "gateway" },
  { name: "DISCORD_ALLOWED_USER_IDS", label: "Discord allowed user IDs", group: "gateway" },
];

/** Restarting the server is the only way these take effect (read once at boot). */
export const RESTART_REQUIRED = new Set(
  KNOWN_API_KEYS.filter((k) => k.group === "gateway").map((k) => k.name),
);
