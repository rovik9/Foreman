import { state } from "../state.js";

const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };

export function renderTasks(tasks) {
  const el = document.getElementById("tasks-list");
  if (!state.activeRun) { el.innerHTML = '<div class="empty-hint">Select or dispatch a run to see its tasks.</div>'; return; }
  if (!tasks.length) { el.innerHTML = '<div class="empty-hint">Architect hasn’t planned tasks yet.</div>'; return; }
  el.innerHTML = tasks.map((t) => `
    <div class="task-card" data-status="${esc(t.status)}">
      <div class="task-top">
        <span class="pill" data-status="${esc(t.status)}">${esc(t.status)}</span>
        <span class="task-meta">${esc(t.class)} · ${esc(t.slot ?? "unassigned")} · ${t.iterations}x</span>
      </div>
      <div class="task-desc">${esc(t.description)}</div>
      <div class="task-cost">$${t.cost_usd.toFixed(4)}</div>
    </div>`).join("");
}
