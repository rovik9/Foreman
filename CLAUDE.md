# CLAUDE.md — Foreman Mission Control UI

You own the **mission-control web app** at `packages/core/public/`. Make it beautiful.
The engine (everything else in this repo) is maintained by another agent — **do not modify
anything outside `packages/core/public/` and this file.**

## What Foreman is

Foreman is a personal AI orchestration engine — a software company in a box. The user talks
to one Interface AI; it prompts and routes work across model slots (architect, builders,
judge, trend, context, memorizer), auto-iterates against acceptance criteria under hard
budget caps, documents every run to a per-product git repo, and can be driven remotely from
Telegram/Discord. Mission control is the user's window into all of it.

## Your canvas

```
packages/core/public/
  index.html          shell — panel regions with STABLE ids (do not rename ids; js binds to them)
  css/app.css         design tokens + components (your main playground)
  js/
    api.js            REST client — all endpoints, already complete
    sse.js            EventSource wrapper — run event stream
    state.js          activeProject / activeRun + change events
    app.js            boot + composition
    components/       runs, feed, panels (tasks/assets), chat, memory, projects
```

The skeleton is **functionally complete** — every panel already fetches and renders real
data. Your job is visual and experiential craft, not wiring.

## Hard constraints

- **No build step.** Vanilla HTML/CSS/ES modules. No bundlers, no npm packages, no
  frameworks (no React/Vue/Tailwind) unless the user explicitly approves.
- **Keep the contract:** element ids, the `/css/*` and `/js/*` paths, REST endpoints, and
  SSE event names are load-bearing. Extend; don't rename.
- **No engine edits.** If you need a new endpoint or event, write it up in this file under
  "Requests for the engine" below and stop — the other agent picks it up.
- Google Fonts via `<link>` is fine. Any other external CDN: ask first.
- Verify visually before declaring done (serve via `pnpm --filter @foreman/core dev`, port 7700).

## Design direction

**Linear-grade dark precision with a Foreman identity.** The engine room of a trading firm,
not a toy dashboard. Dense but calm. Everything earns its pixels.

Tokens already live in `css/app.css` (`:root`) — evolve them, keep names stable:

- Canvas `#08090a`, panels `#0f1011`, surfaces `#191a1b`, hover `#28282c`
- Text ladder `#f7f8f8 → #d0d6e0 → #8a8f98 → #62666d`
- Brand gold `#f0b429` (Foreman identity — brand moments, primary CTA, active accents)
- Interactive violet `#7170ff` / hover `#828fff` (links, selected states)
- Status: ok `#27a644`, err `#f85149`
- Borders: semi-transparent white 0.05–0.08, never solid
- Type: Inter (400/510/590, `font-feature-settings: "cv01","ss03"`), JetBrains Mono for
  numbers, costs, ids, code
- Radius: 4/6/8/12px scale. Elevation via background luminance steps, not drop shadows.

### Signature moments to design for

1. **Live run in flight** — activity feed streaming agent calls, task pills flipping
   states, cost meter ticking up in mono. This is the magic; make it feel alive.
2. **awaiting_user** — the run is blocked on a decision. This state should be
   unmissable and actionable from anywhere (approve/iterate/stop).
3. **completed + Accept** — "Accept & Push" is the user's seal of approval that syncs the
   project memory repo. It should feel like signing off work.
4. **Critical memory approval** — a memory write the Interface AI escalated to the human.
   Treat as a small review inbox, not a list item.
5. **Asset previews** — generated video/audio/images inline as they land mid-run.

### States every panel needs

empty (first-run, zero projects/runs) · loading · live-streaming · blocked · error.
Design empty states that teach the user what to do next.

## API contract (implemented — do not change)

```
GET  /runs                         RunRow[]
POST /runs            {prompt, project?}          -> {id}
GET  /runs/:id                     {run, tasks, messages, artifacts}
GET  /runs/:id/events              SSE — event types below
POST /runs/:id/chat   {message}                   -> resume/steer
POST /runs/:id/accept                             -> {committed, pushed, error?}
GET  /runs/:id/files/*             workspace files (media inline-previewable)
GET  /projects                     ProjectRow[]
POST /projects        {name, repo_url?}           -> 201 ProjectRow | 409
GET  /memories                     MemoryRow[] (status: approved|pending|awaiting_user|rejected)
POST /memories/:id/decision {decision: approve|reject}
```

SSE events (`{type, runId, taskId?, data, at}`):
`run_status` (running/planned/awaiting_user/paused_budget/completed/failed/stopped) ·
`task_status` (running/verifying/passed/escalated/retry) · `agent_call` (slot, model,
phase, costUsd) · `gate` (deterministic verifier results) · `judge` (score, pass,
feedback) · `cost` (runTotalUsd) · `message` · `artifact` (path, kind).

## Run states the UI must render distinctly

`queued running planned awaiting_user paused_budget completed failed stopped`
— pill colors and iconography per state, consistent everywhere (runs list, header, tasks).

## Definition of done

- [ ] Looks intentionally designed, not defaulted (show the user, iterate)
- [ ] All signature moments above feel distinct
- [ ] Every state of every panel designed
- [ ] Works at 1280px and 1440px; degrades sanely narrower
- [ ] No console errors on boot, dispatch, and a full mocked run
- [ ] ids / endpoints / event names unchanged

## Requests for the engine

(append here if you need backend changes — none yet)
