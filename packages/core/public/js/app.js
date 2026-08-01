import { api } from "./api.js";
import { sse } from "./sse.js";
import { state, setActiveRun } from "./state.js";
import { renderRuns } from "./components/runs.js";
import { bindFeed, clearFeed } from "./components/feed.js";
import { renderTasks, renderAssets } from "./components/panels.js";
import { renderChat, bindChat } from "./components/chat.js";
import { renderMemories } from "./components/memory.js";
import { renderProjects, bindProjects } from "./components/projects.js";

async function refresh() {
  if (!state.activeRun) return;
  const d = await api.getRun(state.activeRun);
  document.getElementById("cost-meter").textContent = `$${d.run.cost_usd.toFixed(4)}`;
  const pill = document.getElementById("run-status-pill");
  pill.textContent = d.run.status;
  pill.dataset.status = d.run.status;
  document.getElementById("run-label").textContent = d.run.prompt.slice(0, 50);
  document.getElementById("accept-run-btn").classList.toggle("hidden", d.run.status !== "completed");
  renderTasks(d.tasks);
  renderAssets(state.activeRun, d.artifacts);
  renderChat(d.messages);
}

async function attach(runId) {
  clearFeed();
  sse.attach(runId);
  await refresh();
}

function bindDispatch() {
  const go = async () => {
    const input = document.getElementById("prompt-input");
    const prompt = input.value.trim();
    if (!prompt) return;
    const { id } = await api.createRun(prompt, state.activeProject ?? undefined);
    input.value = "";
    setActiveRun(id);
    await renderRuns();
  };
  document.getElementById("dispatch-btn").addEventListener("click", go);
  document.getElementById("prompt-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
}

function bindAccept() {
  document.getElementById("accept-run-btn").addEventListener("click", async () => {
    const result = await api.acceptRun(state.activeRun);
    window.alert(
      result.pushed ? "Accepted — pushed to the project repo." :
      result.committed ? "Accepted — committed locally (no remote configured)." :
      `Nothing new to commit.${result.error ? ` (${result.error})` : ""}`,
    );
  });
}

async function boot() {
  bindFeed(refresh);
  bindChat(refresh);
  bindProjects();
  bindDispatch();
  bindAccept();
  document.addEventListener("run:changed", (e) => attach(e.detail));
  await renderProjects();
  await renderRuns();
  await renderMemories();
  setInterval(() => { renderRuns(); renderMemories(); }, 8000);
}

boot();
