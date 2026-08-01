import { api } from "../api.js";
import { state, setActiveRun } from "../state.js";

const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };

export async function renderRuns() {
  const runs = await api.listRuns();
  const visible = state.activeProject
    ? runs.filter((r) => r.product === state.activeProject)
    : runs;
  document.getElementById("runs-list").innerHTML = visible.map((r) => `
    <div class="run-card ${r.id === state.activeRun ? "active" : ""}" data-run-id="${r.id}">
      <span class="pill">${esc(r.status)}</span>
      <div class="run-prompt">${esc(r.prompt.slice(0, 60))}</div>
      <div class="run-meta">${esc(r.product ?? "misc")} · $${r.cost_usd.toFixed(4)}</div>
    </div>`).join("");
  for (const el of document.querySelectorAll(".run-card")) {
    el.addEventListener("click", () => setActiveRun(el.dataset.runId));
  }
}
