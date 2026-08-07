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
  group: "provider" | "integration";
}

export const KNOWN_API_KEYS: KnownKey[] = [
  { name: "ANTHROPIC_API_KEY", label: "Anthropic (Claude)", group: "provider" },
  { name: "OPENAI_API_KEY", label: "OpenAI", group: "provider" },
  { name: "MOONSHOT_API_KEY", label: "Moonshot (Kimi)", group: "provider" },
  { name: "GROQ_API_KEY", label: "Groq", group: "provider" },
  { name: "OPENROUTER_API_KEY", label: "OpenRouter (escape hatch)", group: "provider" },
  { name: "GITHUB_TOKEN", label: "GitHub (auto-create memory repos)", group: "integration" },
  { name: "HIGGSFIELD_API_KEY", label: "Higgsfield (asset generation)", group: "integration" },
];
