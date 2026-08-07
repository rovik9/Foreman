import { api } from "../api.js";
import { state } from "../state.js";

const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };

const QUICK_PROMPTS = [
  "Build a CLI todo app with SQLite persistence and tests",
  "Add structured logging across the server and document it",
  "Write an onboarding README with a quickstart section",
  "Refactor the config loader and cover it with unit tests",
];

/** Whole-workspace stats — derived from data we already fetch, no new endpoint. */
function statTiles(runs) {
  const spend = runs.reduce((sum, r) => sum + (r.cost_usd || 0), 0);
  const done = runs.filter((r) => r.status === "completed").length;
  const blocked = runs.filter((r) => ["awaiting_user", "paused_budget"].includes(r.status)).length;
  const live = runs.filter((r) => r.status === "running").length;
  return [
    { label: "Runs", value: String(runs.length), tone: "" },
    { label: "Completed", value: String(done), tone: done ? "ok" : "" },
    { label: "Live now", value: String(live), tone: live ? "info" : "" },
    { label: "Needs you", value: String(blocked), tone: blocked ? "warn" : "" },
    { label: "Total spend", value: `$${spend.toFixed(2)}`, tone: "" },
  ];
}

export async function renderIdle() {
  const [runs, keys] = await Promise.all([
    api.listRuns().catch(() => []),
    api.listApiKeys().catch(() => []),
  ]);

  document.getElementById("idle-stats").innerHTML = statTiles(runs).map((s) => `
    <div class="stat-tile"${s.tone ? ` data-tone="${s.tone}"` : ""}>
      <span class="stat-value">${esc(s.value)}</span>
      <span class="stat-label">${esc(s.label)}</span>
    </div>`).join("");

  const providers = keys.filter((k) => k.group === "provider");
  const ready = providers.filter((p) => p.set).length;
  document.getElementById("provider-chips").innerHTML =
    providers.map((p) => `
      <span class="chip" data-state="${p.set ? "on" : "off"}" title="${esc(p.set ? `key ${p.source}` : "no key configured")}">
        <span class="chip-dot"></span>${esc(p.label.replace(/\s*\(.*\)$/, ""))}
      </span>`).join("") +
    (ready === 0
      ? '<button type="button" class="chip chip-action" id="idle-open-settings">Add a key to get started &rarr;</button>'
      : "");

  const openSettings = document.getElementById("idle-open-settings");
  if (openSettings) {
    openSettings.addEventListener("click", () => document.getElementById("settings-btn").click());
  }

  document.getElementById("quick-prompts").innerHTML = QUICK_PROMPTS
    .map((p) => `<button type="button" class="chip chip-prompt">${esc(p)}</button>`).join("");
  for (const btn of document.querySelectorAll(".chip-prompt")) {
    btn.addEventListener("click", () => {
      const input = document.getElementById("main-input");
      input.value = btn.textContent;
      input.focus();
    });
  }
}

/**
 * Swaps the stage between the idle dashboard and the live run tabs. The tab
 * bar stays visible either way — Spend and Permissions are workspace-scoped,
 * so they stay reachable with no run attached; only Feed/Assets need one.
 */
export function setStageIdle(idle) {
  const active = document.querySelector(".stage-tab.active")?.dataset.tab ?? "feed";
  const runScoped = ["feed", "assets"].includes(active);
  const showDashboard = idle && runScoped;

  document.getElementById("stage-idle").classList.toggle("hidden", !showDashboard);
  for (const t of document.querySelectorAll(".stage-tab")) {
    t.classList.toggle("tab-disabled", idle && ["assets"].includes(t.dataset.tab));
  }
  for (const p of document.querySelectorAll(".stage-page")) p.classList.add("hidden");
  if (!showDashboard) document.getElementById(`stage-${active}`)?.classList.remove("hidden");
  if (showDashboard) renderIdle();

  document.getElementById("stage-progress").classList.toggle("hidden", idle);
}

/** Live task-pipeline rail for an attached run — every task visible as a pip. */
export function renderProgress(run, tasks) {
  const el = document.getElementById("stage-progress");
  if (!run || !tasks.length) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");

  const done = tasks.filter((t) => ["passed", "skipped"].includes(t.status)).length;
  const pct = Math.round((done / tasks.length) * 100);
  const counts = tasks.reduce((acc, t) => ({ ...acc, [t.status]: (acc[t.status] || 0) + 1 }), {});
  const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(" · ");

  el.innerHTML = `
    <div class="prog-head">
      <span class="prog-count">${done}/${tasks.length} tasks</span>
      <span class="prog-summary">${esc(summary)}</span>
      <span class="prog-pct">${pct}%</span>
    </div>
    <div class="prog-pips">
      ${tasks.map((t) => `<span class="prog-pip" data-status="${esc(t.status)}" title="${esc(`${t.status} · ${t.slot ?? "unassigned"} · ${t.description}`)}"></span>`).join("")}
    </div>`;
}
