import { api } from "../api.js";
import { state, setActiveRun } from "../state.js";

const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };

export async function renderSessions() {
  state.runs = await api.listRuns();
  const visible = state.activeProject
    ? state.runs.filter((r) => r.product === state.activeProject)
    : state.runs;
  const count = document.getElementById("sessions-count");
  if (count) count.textContent = visible.length ? String(visible.length) : "";

  document.getElementById("sessions-list").innerHTML = visible.length ? visible.map((r) => `
    <div class="run-card ${r.id === state.activeRun ? "active" : ""}" data-run-id="${r.id}">
      <div class="run-top">
        <span class="pill" data-status="${esc(r.status)}">${esc(r.status)}</span>
        <span class="run-x" data-del="${r.id}" title="Delete run">&times;</span>
      </div>
      <div class="run-prompt">${esc(r.prompt)}</div>
      <div class="run-meta">${esc(r.mode ?? "full")}${r.yolo ? " · yolo" : ""} · $${r.cost_usd.toFixed(4)}</div>
    </div>`).join("") : '<div class="empty-hint">No runs yet — dispatch one below.</div>';

  for (const el of document.querySelectorAll(".run-card")) {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-del]")) return;
      setActiveRun(el.dataset.runId);
    });
  }
  for (const x of document.querySelectorAll("[data-del]")) {
    x.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!window.confirm("Delete this run and everything in it? This can't be undone.")) return;
      await api.deleteRun(x.dataset.del);
      if (state.activeRun === x.dataset.del) setActiveRun(null);
      await renderSessions();
    });
  }
}
