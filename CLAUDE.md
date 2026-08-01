# CLAUDE.md — Foreman

Foreman is a personal AI orchestration engine — a software company in a box. The user talks
to one Interface AI (Sonnet 5); it compiles context and prompts every other AI, routes each
task across user-preselected model options per role (with logged reasoning), auto-iterates
against acceptance criteria under hard budget caps, governs project memory (all roles read
freely, writes need Interface approval, critical writes need the user), documents every run
to a per-product git repo, and can be driven remotely from Telegram/Discord.

Engine (`packages/core/src`) and UI (`packages/core/public`) are both live and maintained
here — there is no other agent to hand off to. Engine status: 99/99 tests passing, `tsc
--noEmit` clean, `eslint` clean as of this writing.

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
- **New-project modal**: name, memory local folder, memory git repo URL, monorepo checkbox,
  dynamic local-folder list, comma-separated code repos.

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
POST /projects        {name, memory_dir?, memory_repo?, workspace_dirs?[], code_repos?[]}
                                   -> 201 ProjectRow | 400 | 409 duplicate | 502 github
DELETE /projects/:slug                            -> 204 | 404
GET  /memories                     MemoryRow[] (status: approved|pending|awaiting_user|rejected)
POST /memories/:id/decision {decision: approve|reject}
```

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

## Notes for future work

- No git-diff view yet for "Code changes" — it currently lists artifact files (path + kind),
  not a real diff. A `GET /runs/:id/diff` endpoint would enable a proper per-file diff view.
- Provider keys: only Moonshot is configured in this environment as of writing, and that
  account is suspended (429, insufficient balance) — expect runs to fail at the first
  Interface AI call until keys are refreshed. The UI handles this gracefully (see Permissions
  / Interface & Crew panels), it's an account/billing issue, not a bug.
- Do not build DeFi/trading-product features — any "Rovik Capital" / fund-style prompts in
  the run history are stray test data from earlier sessions, not a real requirement.
