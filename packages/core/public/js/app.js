import { api } from "./api.js";
import { sse } from "./sse.js";
import { state, setActiveRun } from "./state.js";
import { renderTopbar, bindTopbar } from "./components/topbar.js";
import { renderSessions } from "./components/sessions.js";
import {
  bindStageTabs, bindStageEvents, clearFeed, renderAssets, renderPermissions, setTabChangeHandler,
} from "./components/stage.js";
import { renderSpend } from "./components/spend.js";
import { renderTasks } from "./components/tasks.js";
import { renderRoster } from "./components/roster.js";
import { renderChanges } from "./components/changes.js";
import { renderPromptings } from "./components/promptings.js";
import { bindSettings } from "./components/settings.js";
import { bindViewPrefs } from "./components/viewprefs.js";
import { renderIdle, renderProgress, setStageIdle } from "./components/idle.js";

function updateFooter(run) {
  const terminal = !run || ["completed", "failed", "stopped"].includes(run.status);
  // still discussing: the crew hasn't been dispatched, so offer the greenlight
  const discussing = !!run && run.mode === "discuss" && !run.approved
    && !["completed", "failed", "stopped"].includes(run.status);

  document.getElementById("stop-btn").classList.toggle("hidden", terminal || discussing);
  document.getElementById("accept-btn").classList.toggle("hidden", !run || run.status !== "completed");
  document.getElementById("approve-btn").classList.toggle("hidden", !discussing);
  document.getElementById("steer-btn").classList.toggle("hidden", !run);
  document.getElementById("main-input").placeholder = discussing
    ? "Reply to the Interface AI…"
    : run
      ? "Steer the active run…"
      : "Describe what you want built — the Interface AI will talk it through with you first…";
}

async function refresh() {
  const statusEl = document.getElementById("stage-run-status");

  if (!state.activeRun) {
    document.getElementById("stage-run-label").textContent = "No active session";
    statusEl.textContent = "";
    delete statusEl.dataset.status;
    document.getElementById("cost-session").textContent = "$0.0000";
    renderTasks([]);
    renderRoster(null, []);
    await renderChanges(null, []);
    renderAssets(null, []);
    renderPromptings([]);
    renderProgress(null, []);
    updateFooter(null);
    setStageIdle(true);
    await renderPermissions();
    return;
  }

  setStageIdle(false);
  const d = await api.getRun(state.activeRun);
  document.getElementById("stage-run-label").textContent = d.run.prompt;
  statusEl.textContent = d.run.status;
  statusEl.dataset.status = d.run.status;
  document.getElementById("cost-session").textContent = `$${d.run.cost_usd.toFixed(4)}`;

  renderProgress(d.run, d.tasks);
  renderTasks(d.tasks);
  renderRoster(d.run, d.tasks);
  await renderChanges(state.activeRun, d.artifacts);
  renderAssets(state.activeRun, d.artifacts);
  renderPromptings(d.messages);
  updateFooter(d.run);
  await renderPermissions();
}

async function attach(runId) {
  clearFeed();
  if (runId) sse.attach(runId); else sse.close();
  await renderSessions();
  await refresh();
}

function bindFooter() {
  const input = document.getElementById("main-input");

  const dispatch = async () => {
    const prompt = input.value.trim();
    if (!prompt) return;
    const { id } = await api.createRun(prompt, state.activeProject ?? undefined, state.mode, state.yolo);
    input.value = "";
    setActiveRun(id);
  };

  const steer = async () => {
    const text = input.value.trim();
    if (!text || !state.activeRun) return;
    await api.chat(state.activeRun, text);
    input.value = "";
    await refresh();
  };

  document.getElementById("dispatch-btn").addEventListener("click", dispatch);
  document.getElementById("steer-btn").addEventListener("click", steer);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (state.activeRun && !document.getElementById("steer-btn").classList.contains("hidden")) steer();
    else dispatch();
  });

  document.getElementById("stop-btn").addEventListener("click", async () => {
    if (!state.activeRun) return;
    await api.stopRun(state.activeRun);
    await refresh();
  });

  document.getElementById("approve-btn").addEventListener("click", async () => {
    if (!state.activeRun) return;
    await api.approveRun(state.activeRun);
    await refresh();
  });

  document.getElementById("accept-btn").addEventListener("click", async () => {
    if (!state.activeRun) return;
    const r = await api.acceptRun(state.activeRun);

    // report the code delivery and the memory sync separately — they succeed
    // and fail independently, and the code is the part the user cares about
    const code = r.code?.delivered
      ? `Code: ${r.code.files} file(s) → ${r.code.target}\n` +
        (r.code.pushed ? "Pushed to the project repo."
          : r.code.committed ? "Committed locally (no remote configured)."
            : `Copied but not committed.${r.code.error ? ` (${r.code.error})` : ""}`)
      : `Code not delivered: ${r.code?.error ?? "unknown reason"}`;

    const mem = r.memory?.pushed ? "Memory: pushed."
      : r.memory?.committed ? "Memory: committed locally."
        : `Memory: nothing new.${r.memory?.error ? ` (${r.memory.error})` : ""}`;

    window.alert(`${code}\n\n${mem}`);
    await refresh();
  });
}

async function refreshAll() {
  await renderTopbar();
  await renderSessions();
  await renderPermissions();
}

async function boot() {
  bindStageTabs();
  setTabChangeHandler(async (tab) => {
    if (tab === "spend") await renderSpend();
    // Feed with no run attached falls back to the idle dashboard
    else if (!state.activeRun) setStageIdle(true);
  });
  bindStageEvents(refresh);
  bindTopbar(refreshAll);
  bindFooter();
  bindSettings();
  bindViewPrefs();

  document.addEventListener("run:changed", (e) => attach(e.detail));
  document.addEventListener("project:changed", async () => {
    await renderTopbar();
    await renderSessions();
    // spend is project-scoped — keep it in sync when the scope changes
    if (document.querySelector(".stage-tab.active")?.dataset.tab === "spend") await renderSpend();
  });

  await refreshAll();
  await refresh();
  setInterval(() => {
    renderSessions();
    renderPermissions();
    if (!state.activeRun) renderIdle();
  }, 6000);
}

boot();
