import { api } from "./api.js";
import { sse } from "./sse.js";
import { state, setActiveRun } from "./state.js";
import { renderTopbar, bindTopbar } from "./components/topbar.js";
import { renderSessions } from "./components/sessions.js";
import {
  bindStageTabs, bindStageEvents, clearFeed, renderAssets, renderPermissions,
} from "./components/stage.js";
import { renderTasks } from "./components/tasks.js";
import { renderRoster } from "./components/roster.js";
import { renderChanges } from "./components/changes.js";
import { renderPromptings } from "./components/promptings.js";

function updateFooter(run) {
  const terminal = !run || ["completed", "failed", "stopped"].includes(run.status);
  document.getElementById("stop-btn").classList.toggle("hidden", terminal);
  document.getElementById("accept-btn").classList.toggle("hidden", !run || run.status !== "completed");
  document.getElementById("steer-btn").classList.toggle("hidden", !run);
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
    renderChanges(null, []);
    renderAssets(null, []);
    renderPromptings([]);
    updateFooter(null);
    await renderPermissions();
    return;
  }

  const d = await api.getRun(state.activeRun);
  document.getElementById("stage-run-label").textContent = d.run.prompt;
  statusEl.textContent = d.run.status;
  statusEl.dataset.status = d.run.status;
  document.getElementById("cost-session").textContent = `$${d.run.cost_usd.toFixed(4)}`;

  renderTasks(d.tasks);
  renderRoster(d.run, d.tasks);
  renderChanges(state.activeRun, d.artifacts);
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

  document.getElementById("accept-btn").addEventListener("click", async () => {
    if (!state.activeRun) return;
    const result = await api.acceptRun(state.activeRun);
    window.alert(
      result.pushed ? "Accepted — pushed to the project repo." :
        result.committed ? "Accepted — committed locally (no remote configured)." :
          `Nothing new to commit.${result.error ? ` (${result.error})` : ""}`,
    );
  });
}

async function refreshAll() {
  await renderTopbar();
  await renderSessions();
  await renderPermissions();
}

async function boot() {
  bindStageTabs();
  bindStageEvents(refresh);
  bindTopbar(refreshAll);
  bindFooter();

  document.addEventListener("run:changed", (e) => attach(e.detail));
  document.addEventListener("project:changed", async () => {
    await renderTopbar();
    await renderSessions();
  });

  await refreshAll();
  await refresh();
  setInterval(() => { renderSessions(); renderPermissions(); }, 6000);
}

boot();
