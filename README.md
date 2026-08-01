# Foreman

A personal AI orchestration engine — a software company in a box.

You talk to one model (the **PM**, Sonnet). It refines your prompt, hands it to the **Architect** (GPT-5.6 Sol / Opus 5) for planning, routes work to **Builders** (Kimi K3 / Sonnet) by strength and cost, verifies output against acceptance criteria, and **auto-iterates** until the job passes — with hard budget caps, a live mission-control UI, mid-build chat, and asset generation (video/audio via MCP).

## Status

Phase 0 — scaffold. See [PLAN.md](./PLAN.md) for the full roadmap.

## Stack

TypeScript / Node 22 · pnpm workspaces · Hono (SSE) · SQLite (better-sqlite3) · Vite + React · OpenRouter + Groq · MCP

## Quickstart (once Phase 1 lands)

```bash
pnpm install
cp .env.example .env   # add OPENROUTER_API_KEY, GROQ_API_KEY
pnpm test
pnpm dev               # core server + mission control
```

## Layout

```
config/            models.yaml (model slots), limits.yaml (budget/iteration caps)
packages/core/     pipeline engine, router, agents, store, MCP clients, server
packages/ui/       mission-control web app (Phase 1)
extension/         VS Code integration (Phase 3)
```

## License

MIT
