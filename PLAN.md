# Personal AI Orchestration Engine — Implementation Plan

**Goal:** A self-hosted "software company in a box": you talk to one model (Sonnet), it refines your prompt, architects plan, builders implement, a verifier auto-iterates until acceptance criteria pass — with live UI, mid-build chat, asset generation, and cost-optimized routing.

**Name:** Foreman — you talk to one guy, he runs the whole crew.

**Architecture:** Four layers, fully open-source:
1. **Core orchestrator** (headless service) — pipeline, task DAG, verifier loop, model router, state store.
2. **Mission-control UI** (local web app) — live agent activity feed, chat with the "PM", artifact/code diff viewer, video/audio asset preview.
3. **DM gateway** (Telegram-first) — run Foreman on your home PC, drive it from your phone anywhere: PM chats, escalations, approve/iterate/stop buttons, asset delivery. (Reference: Hermes gateway, `~/.hermes/hermes-agent/gateway/`.)
4. **Editor integration** (later) — VS Code extension → Code-OSS fork only after core is proven.

**Tech stack (fast + cheap + OSS):**
- TypeScript / Node 22, pnpm workspaces (monorepo)
- Hono (HTTP + SSE server) — tiny, fast
- SQLite via better-sqlite3 — state, task graph, cost ledger
- Vite + React — mission-control UI
- OpenRouter as universal model gateway (one key → GPT/Claude/Kimi/Groq-hosted models, per-token billing); direct Groq SDK for latency-critical news feed
- MCP client (@modelcontextprotocol/sdk) for video/audio asset tools (Higgsfield MCP etc.)
- Vitest for tests; ESLint + tsc as verifier gates

---

## The Pipeline (the "company")

```
YOU ──> PM (Sonnet slot)            refines prompt, asks clarifiers, owns user comms
         │
         ▼
      ARCHITECT (GPT-5.6 Sol / Opus 5 slot)
         spec → task DAG (each task: desc, files, acceptance_criteria, model_tier)
         │
         ▼
      ROUTER                  assigns each task the cheapest model that meets its tier
         │
         ▼
      BUILDERS (Kimi K3 / Sonnet slots, parallel where DAG allows)
         │  produces code + artifacts
         ▼
      VERIFIER                deterministic gates first (tsc, eslint, tests), then
                              LLM-judge vs acceptance_criteria (rubric score)
         │  fail ──> feedback appended ──> same builder retries (max N, budget-capped)
         ▼  pass
      ASSET STUDIO (Higgsfield / video / audio MCPs)   renders project assets
         │
         ▼
      REPORT ──> PM summarizes to you in chat; UI updates live via SSE
```

**Auto-iteration rules (the referee):**
- Every task must carry machine-checkable acceptance criteria (tests/commands) + a judge rubric.
- Hard caps: `max_iterations_per_task` (default 5), `max_cost_per_run_usd` (default 5.00). Exceeded → task escalates to you with full context, never silent-looping.
- You can inject chat messages mid-run; PM routes them to the active agent.

## Model registry (all swappable placeholders)

`config/models.yaml`:
```yaml
slots:
  pm:        { provider: anthropic,  model: claude-sonnet-5 }        # you talk only to this
  architect: { provider: openai,     model: gpt-5.6-sol, fallback: claude-opus-5 }
  builder_a: { provider: moonshot,   model: kimi-k3 }
  builder_b: { provider: anthropic,  model: claude-sonnet-5 }
  realtime:  { provider: groq,       model: groq-fast-latest }       # news/data feed
  judge:     { provider: anthropic,  model: claude-sonnet-5 }
tiers:                      # router: cheapest model per task class
  plan:      [architect]
  build:     [builder_a, builder_b]
  critique:  [judge]
  fetch:     [realtime]
asset_studios:
  video: { type: mcp, command: "higgsfield-mcp", placeholder: true }
  audio: { type: mcp, command: "audio-mcp", placeholder: true }
```

## Monorepo layout

```
foreman/
  package.json  pnpm-workspace.yaml  tsconfig.base.json
  config/models.yaml  config/limits.yaml
  packages/
    core/            # pipeline engine
      src/pipeline/  # intake, plan, decompose, verify, report
      src/router/    # model registry, cost table, pick()
      src/agents/    # pm, architect, builder, judge, realtime
      src/store/     # sqlite: runs, tasks, messages, cost_ledger
      src/mcp/       # asset studio clients
      src/server/    # hono: REST + SSE stream + chat injection
      test/
    ui/              # vite + react mission control
      src/panels/    # ActivityFeed, ChatPanel, TaskGraph, AssetPreview, CostMeter
  extension/         # (Phase 3) vscode extension shell
```

---

## Phase 0 — Scaffold (target: day 1)

1. `pnpm init` monorepo: workspaces, tsconfig.base, vitest, eslint. Verify: `pnpm -r build` green.
2. `config/models.yaml` + `config/limits.yaml` + zod-validated loader. Test: loads, rejects bad slot.
3. SQLite store: tables `runs, tasks, messages, artifacts, cost_ledger`; migration runner. Test: round-trip CRUD.
4. Provider client: OpenRouter chat-completion wrapper w/ usage capture → cost_ledger. Test: mocked fetch records cost.
5. Commit each step. Repo: `git init`, MIT license, .gitignore (node_modules, .env, *.db).

## Phase 1 — Vertical slice (the money milestone)

**One prompt in → plan → build → verify loop → live UI. No router cleverness yet (fixed slots).**

1. Agent harness: `runAgent(slot, systemPrompt, input) → {output, cost}` with streaming tokens to event bus. Test: mock provider, asserts cost recorded + events emitted.
2. PM intake: prompt-refinement chain (rough prompt → clarified spec, asks user via chat if confidence < threshold). Test: fixture prompt produces spec JSON.
3. Architect: spec → task DAG (JSON schema-validated: id, desc, files, acceptance_criteria, tier, deps). Test: validates DAG, rejects cycles.
4. Executor: topological walk, parallelize independent tasks, builder agents write to a sandboxed workdir (`runs/<run_id>/workspace`). Test: 3-task fixture executes in dep order.
5. Verifier: run deterministic gates (tsc/eslint/vitest if present) then judge rubric; fail → feedback → retry loop with caps from limits.yaml. Test: failing artifact retries, caps at max_iterations, escalates.
6. Server (Hono): `POST /runs`, `GET /runs/:id/stream` (SSE), `POST /runs/:id/chat` (mid-run injection), `GET /runs/:id/artifacts`. Test: supertest end-to-end with mocked providers.
7. UI: Vite+React. Panels: ChatPanel (talk to PM), ActivityFeed (live agent events), TaskGraph (DAG status), AssetPreview (HTML5 video/audio/img), CostMeter (live USD). SSE-driven. Verify: manual smoke — run fixture prompt, watch feed live.
8. E2E: `pnpm demo` runs "build a landing page" through the full loop with real keys. **Acceptance: spec → code → tests pass → UI shows everything live, total cost printed.**

## Phase 2 — Brains & senses
1. Cost-optimizing router: per-class fallback chains, quality-floor heuristics, cache repeated prompts.
2. Realtime feed agent (Groq): news/trend summaries injectable into architect context.
3. Asset studio: MCP clients for Higgsfield (video) + audio MCP; artifacts stream to AssetPreview mid-run.
4. Run history browser + resume/retry in UI.

## Phase 2.5 — DM gateway: Telegram + Discord (the travel unlock)
Run Foreman as a launchd service on the home PC; full control from your phone.
Shared adapter base (pattern: Hermes `gateway/platforms/base.py`) — one message
router, N platform adapters. Both behind pairing/authz.

1. **Adapter base + message router:** platform-agnostic inbound/outbound queue;
   a run is addressable on any connected platform. Delivery ledger persisted +
   retried (pattern: `gateway/delivery_ledger.py`).
2. **Pairing/authz first, non-negotiable:** respond only to allowlisted user IDs
   per platform; everyone else gets nothing. (Pattern: `gateway/pairing.py`.)
3. **Telegram adapter** (Bot API, long-polling — no public endpoint): PM DMs,
   escalation questions, inline buttons — Approve / Iterate / Stop / Budget+ —
   asset delivery as native media.
4. **Discord adapter** (bot token, websocket gateway — no public endpoint):
   each run gets its own **thread** in a private channel = live build log per
   project; slash commands (/run, /status, /stop, /approve); button components;
   file uploads (25MB) for video/audio assets.
5. PM bridging: messages from either platform route to the PM agent; replies,
   status, and escalations fan out to whichever platform the run started on
   (or both, if linked).

## Phase 3 — Editor
1. VS Code extension: embeds mission-control webview, opens run workspace, inline diffs.
2. Only if extension proves insufficient: fork Code-OSS, apply product.json branding + bundled extension. (Deferred deliberately — fork = maintenance tax.)

## Phase 4 — DeFi fund hardening (your real use case)
1. Solidity/Foundry verifier gates (forge build, forge test, slither) as first-class verifier plugins.
2. "Industrial-grade contract" rubric pack for the judge (reentrancy, access control, invariant tests).

---

## Memory & documentation (the chain of custody)
Every run is documented — who did what, why, how, and what it cost.
- **Store of record:** SQLite `memories` table + FTS5 full-text index (zero deps).
- **Distiller:** after every run (success or failure), the cheapest slot
  (memorizer = Kimi K3) reads the transcript and extracts durable knowledge —
  preference / fact / decision / lesson / convention.
- **Recall:** every new prompt is FTS-matched against memory and the top hits
  are injected into the PM's context before refinement.
- **Journal:** per-run markdown with the plan table (task × slot × model ×
  iterations × cost), decisions/steering log, artifacts, and full cost ledger.
- **Layout:** `memory/products/<product>/` — each product is its own git repo
  (`journal/`, `memory/<kind>/`). PM names the product; new product = new repo.
- **Sync:** local-first commit always; push when `config/memory.yaml` has
  `auto_push: true` + a remote for that product. Push failure never loses the
  local commit.
- **Human window:** point Obsidian at `memory/` — browse/edit everything;
  SQLite stays the machine store.

## Risks / open questions
- **Placeholder models** (GPT-5.6 Sol, Sonnet 5, Opus 5, Kimi K3) — slots exist day one; wire real IDs + real prices in `config/prices.yaml` when keys arrive.
- **Judge loops can still thrash** — caps + escalation mitigate; watch cost_ledger early.
- **MCP asset studios** vary wildly in maturity; placeholder config until Higgsfield MCP is confirmed working.
- **Sandboxing**: builders write only under `runs/<id>/workspace`; shell commands run with allowlist. Non-negotiable for auto-iteration safety.

## Validation
- Per-task vitest (TDD), Phase 1 E2E demo as the first real acceptance gate.
- Manual: chat mid-build changes builder behavior; video asset appears in UI while run continues.

---
**Next step on approval:** scaffold Phase 0 + Phase 1 in `~/Documents/Foreman/`.
