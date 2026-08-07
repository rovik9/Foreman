# CLAUDE.md — Foreman

Foreman is a personal AI orchestration engine — a software company in a box. The user talks
to one Interface AI (Sonnet 5); it compiles context and prompts every other AI, routes each
task across user-preselected model options per role (with logged reasoning), auto-iterates
against acceptance criteria under hard budget caps, governs project memory (all roles read
freely, writes need Interface approval, critical writes need the user), documents every run
to a per-product git repo, and can be driven remotely from Telegram/Discord.

**Product framing**: Foreman is bring-your-own-key — it never bills for model usage. Its
sellable value is the orchestration/UI/memory layer on top of whatever APIs and MCP tools the
user connects. That means Settings (below) is not a config afterthought, it's the onboarding
experience — nobody paying for this should ever need to hand-edit `.env` or `config/*.yaml`.

Engine (`packages/core/src`) and UI (`packages/core/public`) are both live and maintained
here — there is no other agent to hand off to. Engine status: 138/138 tests passing, `tsc
--noEmit` clean, `eslint` clean as of this writing.

## How a run actually starts (discuss → approve → build)

**`discuss` is the default mode.** A dispatched prompt is never blind-dumped into the whole
crew. The Interface AI replies conversationally (prose, questions, trade-offs, a proposed
plan — see `DISCUSS_SYSTEM` in `agents/interface.ts`), the run parks in `awaiting_user`, and
the user keeps talking via `POST /runs/:id/chat`. Only `POST /runs/:id/approve` (the "Build
it" button) sets `runs.approved = 1` and lets the pipeline past the discuss gate into
architect → builders → verifier. `yolo` skips the gate; so do modes `full`/`plan`/`design`.

The discuss call logs its raw prompt/completion under role `interface_io`, deliberately
distinct from the curated `interface` reply — otherwise the harness's own I/O echo would be
fed back into the next turn's transcript as if the user had said it.

## Mission control UI

```
packages/core/public/
  index.html          shell — panel regions with STABLE ids (extend, don't rename; js binds to them)
  css/app.css          design tokens + components — apple-glass chrome, dense terminal layout
  js/
    api.js            REST client — all endpoints
    sse.js            EventSource wrapper — run event stream
    state.js          activeProject / activeRun / mode / yolo + change events
    app.js            boot + composition
    components/       topbar, sessions, stage (feed/assets/permissions), tasks, roster, changes, promptings
```

No build step — vanilla HTML/CSS/ES modules, no bundler, no frameworks. Serve via
`pnpm --filter @foreman/core dev` (port 7700).

### Layout (current, as shipped)

- **Topbar**: brand · project tabs (chrome-style, click to filter, × to remove) · + new
  project · mode select (full/plan/design) · yolo toggle (bypasses permission gates for the
  next dispatch) · session cost + active-project cost.
- **Left — Sessions**: runs for the active project (or all), status-pilled, click to attach.
- **Centre — Stage**: run title + status pill header, then tabs: **Feed** (live SSE activity,
  JSON syntax-highlighted, nothing truncated), **Assets** (inline media previews), **
  Permissions** (unified inbox — runs blocked on `awaiting_user`/`paused_budget` with
  top-up/open actions, plus critical memory writes with approve/reject; badge shows the
  live count).
- **Right — rail**: Tasks (live task cards) · Who's working (derived from running/verifying
  tasks — no extra endpoint) · Code changes (compact file list from artifacts) · Interface &
  crew (full message transcript, every role, color-coded).
- **Footer**: single input, dual purpose — Dispatch always starts a new run; Steer (appears
  once a run is active) sends a chat message to it; Stop and Accept & Push appear based on
  run status.
- **New-project modal**: name, memory local folder (+ Browse via the server-driven folder
  picker), memory git repo URL, monorepo checkbox (checked → one repo field; unchecked → "how
  many repos?" → that many named fields), dynamic local-folder list, and per-repo credential
  selector (System git / SSH key / Token) with live `git ls-remote` validation as you type.
  On submit, every code repo is actually cloned (shallow) into `projects/<slug>/<name>/` and
  the checkout path is appended to the project's workspace_dirs — proof of connectivity, not
  just a stored URL string.
- **Settings** (gear icon, top-right — green dot when ≥1 key is configured): the product's
  control plane. **API Keys** tab — one row per known provider/integration (Anthropic, OpenAI,
  Moonshot, Groq, OpenRouter, GitHub, Higgsfield), masked input, Save/Clear, a status pill
  (`configured` = DB-backed via settings, `from .env` = env fallback, `not set`). Saves apply
  immediately — model routing re-resolves the key live, no restart (see `providers/factory.ts`
  `resolveProviderLive`). **MCP Servers** tab — add any stdio MCP server (name, kind, command,
  args), enable/disable, delete. Fully generic, not hardcoded to asset studios.

### Design tokens (`css/app.css` `:root`)

Apple-glass frosted panels (`backdrop-filter: blur`) over an ambient gradient background,
with Foreman gold as the one brand/CTA accent:

- Canvas `#07070b`, glass `rgba(255,255,255,.055)` w/ blur, border `rgba(255,255,255,.10)`
- Text ladder `#f5f5f8 → #a6a6b3 → #74747f → #4d4d56`
- Brand gold `#f0b429` (wordmark, primary CTA, active project-tab underline)
- Interactive violet `#8b6bff` / cyan `#22d3ee` (selection, links, secondary actions)
- Status: ok `#34d399`, warn `#fbbf24`, err `#f87171`, info `#60a5fa`, violet `#c084fc`
- Type: system font stack for UI, `ui-monospace`/JetBrains-style mono for numbers/ids/JSON

## API contract (implemented)

```
GET  /runs                         RunRow[]
POST /runs            {prompt, project?, mode?, yolo?}     -> {id}
GET  /runs/:id                     {run, tasks, messages, artifacts}
GET  /runs/:id/events              SSE — event types below
POST /runs/:id/chat   {message}                            -> resume/steer
POST /runs/:id/stop                                         -> {ok}
POST /runs/:id/budget {add_usd}                             -> {ok, budget_raise, resumed}
POST /runs/:id/accept                                        -> {committed, pushed, error?}
GET  /runs/:id/files/*             workspace files (media inline-previewable)
GET  /projects                     ProjectRow[] (+cost_usd)
POST /projects        {name, memory_dir?, memory_repo?, monorepo?, workspace_dirs?[],
                        code_repos?[], credentials?: {[url]: GitCredential}}
                       -> 201 {...ProjectRow, clone_results: {url,ok,path?,error?}[]}
                          | 400 | 409 duplicate | 502 github
DELETE /projects/:slug                            -> 204 | 404
GET  /fs/list?path=                {path, parent, entries: {name,path}[]} -> real dir listing
POST /fs/check-repo   {url, credential?: GitCredential}   -> {ok:true} | {ok:false, error}
GET  /memories                     MemoryRow[] (status: approved|pending|awaiting_user|rejected)
POST /memories/:id/decision {decision: approve|reject}
GET  /settings/api-keys            {name,label,group,set,source:settings|env|unset,updated_at}[]
                                    — never returns raw values
POST /settings/api-keys        {name, value}                 -> {ok} (blank value clears)
DELETE /settings/api-keys/:name                                -> 204
GET  /settings/mcp-servers         {id,name,kind,command,args,enabled,created_at}[]
POST /settings/mcp-servers     {name, kind?, command, args?[]}  -> 201
PATCH /settings/mcp-servers/:id {enabled}                       -> {ok} | 404
DELETE /settings/mcp-servers/:id                                -> 204 | 404
```

`GitCredential` = `{method:"system"}` | `{method:"ssh_key", keyPath}` | `{method:"token", token}`
— see `server/git-auth.ts`, the single choke point every git shell-out goes through. Never
persisted: credentials live only for the request that supplied them (check-repo validation,
or the clone at project-creation time). System (ambient git identity — SSH agent / credential
helper, whatever `git` on this machine already uses) is the default and correct choice for
most repos; ssh_key/token exist for repos that need a different identity than your default.

RunRow: `{id, prompt, status, workspace_dir, product, mode, yolo, budget_raise, cost_usd, created_at, updated_at}`
Run statuses: `queued running awaiting_user paused_budget completed failed stopped`
TaskRow statuses: `pending running verifying passed failed escalated skipped`

SSE events (`{type, runId, taskId?, data, at}`): `run_status` · `task_status` · `agent_call`
(`{slot, model, phase: start|done, costUsd?}`) · `gate` · `judge` · `cost`
(`{runTotalUsd}`) · `message` · `artifact` (`{path, kind}`).

Message roles seen in `messages[].role`: `user pm interface architect builder judge context
realtime memory system` (`pm` and `interface` are both the Interface AI — legacy naming from
the spec-writing step vs. the routing step).

## Roles / model slots (`config/models.yaml`)

`interface` (Sonnet 5 — routes + prompts everyone, memory governance) · `architect`
(planning/decisions, 3 preselected options) · `builder` (code, multiple options) · `judge`
(verifier) · `trend` (Groq — news/trend verification) · `context` (long-context synthesis,
Gemini Pro intent) · `memorizer` (cheapest slot on purpose). Users preselect the option list
per role; the Interface AI picks fast from that shortlist per task, with a logged reason —
no open-ended model deliberation.

## API keys & MCP servers (`providers/factory.ts`, `store/db.ts` `api_keys`/`mcp_servers`)

Resolution order for every provider call: DB-backed key (Settings UI) → `.env` → unroutable
(harness throws a clear error naming the slot). `resolveProviderLive(via, store)` is called
fresh on every model call — cheap, since providers are just fetch wrappers — so a key saved
in Settings works immediately, mid-session, no restart. `AgentHarness`'s constructor takes
this resolver as an optional 5th arg used only as a fallback when the static `ProviderMap`
doesn't have the `via`; tests never pass it, so their behavior is unchanged.

MCP servers are a real registry now (`mcp_servers` table), not the old hardcoded
`config/models.yaml` `asset_studios: {video, audio}` two-slot placeholder — add any stdio
server with a name/kind/command/args from Settings. `mcp/studio.ts` (asset generation) still
reads its config the old way; wiring it to the new registry, and wiring MCP tool-calling into
the agent loop itself (so builders/interface can actually *use* connected tools mid-task, not
just asset-studio post-processing) are the natural next steps — see below.

Telegram/Discord tokens and `TELEGRAM_ALLOWED_USER_IDS`/`DISCORD_*` remain `.env`-only for
now — the gateway registers adapters once at boot; hot-reloading a live bot connection is a
materially different feature than live-swapping a stateless API key, deliberately out of
scope for this pass.

## Config precedence (`config/overrides.ts`)

`config/*.yaml` supplies defaults; anything edited in Settings → Engine overrides it. Overrides
live in the `config_overrides` table (dotted key → JSON value) and are applied **onto the live
config object** — which every agent, router and runner already holds by reference — so an edit
lands on the next model call with no restart, and the user's YAML is never rewritten. Every
override is validated with the same zod schemas the YAML is parsed with, so a bad value can't
leave the config in a shape the pipeline doesn't expect. `applyStoredOverrides` replays them at
boot; a since-invalidated one (e.g. a role pointing at a deleted slot) is logged and skipped.

Editable today: all six `limits` numbers, every role's option shortlist + active slot, and
`memory.auto_push`. `DELETE /settings/config/:key` drops the override and restores the YAML value.

**Migrations are append-only.** Editing an existing entry in `MIGRATIONS` is a no-op on any
database that already applied it — always append. (Learned the hard way: a table added inside an
already-applied migration simply never existed on an existing DB.)

## Connection testing (`server/probe.ts`)

Every credential has a **Test** button that makes a real call, because saved ≠ working:

- **API keys** — two steps, deliberately. Step 1 lists models (proves auth). Step 2 attempts
  a 1-token completion (proves the account can actually *generate*). This matters: a
  suspended Moonshot account returns **200 from `/models` while every real generation 429s**,
  so an auth-only check reports a confident, wrong "connected". The two-step probe reports
  `key is valid but generation failed: account out of credit / suspended` instead.
- **MCP servers** — actually spawns the process over stdio and lists its tools; the result
  (and discovered tool names) is persisted on the row.
- **Custom providers** — hits `{base_url}/models`, so an unreachable localhost server says
  so plainly rather than failing later mid-run.

Keys are never echoed back — not in responses, not inside error strings.

## Notes for future work

- MCP servers are registered, testable, and consumed by the asset-studio stage, but **not yet
  wired into the agent tool-use loop** — builders/interface can't call MCP tools mid-task.
  That's the deeper lift: each provider has a different tool-calling wire format (Anthropic
  `tool_use` blocks vs. OpenAI function calling), and it can't be verified end to end without
  a live generating key, which this environment doesn't currently have.
- Telegram/Discord tokens still can't be tested from the UI (they'd need a live bot session).
- `memory_repo` doesn't get the same credential-selector/validation treatment as code_repos
  yet — same git-auth.ts module would cover it, just not wired into that field's UI.
- No git-diff view yet for "Code changes" — it currently lists artifact files (path + kind),
  not a real diff. A `GET /runs/:id/diff` endpoint would enable a proper per-file diff view.
- Provider keys: only Moonshot is configured here (via `.env`, now also settable in
  Settings), and that account is **suspended for generation** — confirmed by the probe, not
  guessed. Every run fails at the first Interface AI call until it's topped up or another key
  is added. That's billing, not a bug.
- `OPENAI_API_KEY` sometimes reads as "set" depending on which shell launched the server — it
  is **not** in `.env`, it's inherited from the host environment. That's why the settings UI
  says "from environment" rather than "from .env"; don't assume it belongs to this project.
- Do not build DeFi/trading-product features — any "Rovik Capital" / fund-style prompts in
  the run history are stray test data from earlier sessions, not a real requirement.
