const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };

/** "Who's working" — derived from live task state, no extra endpoint needed. */
export function renderRoster(run, tasks) {
  const el = document.getElementById("roster-list");
  if (!run) { el.innerHTML = '<div class="empty-hint">No active session.</div>'; return; }

  const active = tasks.filter((t) => t.status === "running" || t.status === "verifying");

  if (run.status === "running" && tasks.length === 0) {
    el.innerHTML = `
      <div class="roster-row">
        <span class="roster-dot working"></span>
        <div class="roster-body">
          <div class="roster-slot">interface<span class="roster-phase">planning</span></div>
          <div class="roster-task">Breaking the goal into a task DAG…</div>
        </div>
      </div>`;
    return;
  }

  if (!active.length) {
    el.innerHTML = run.status === "awaiting_user" || run.status === "paused_budget"
      ? '<div class="empty-hint">Paused — waiting on you in Permissions.</div>'
      : '<div class="empty-hint">No one is actively working right now.</div>';
    return;
  }

  el.innerHTML = active.map((t) => `
    <div class="roster-row">
      <span class="roster-dot working"></span>
      <div class="roster-body">
        <div class="roster-slot">${esc(t.slot ?? "unassigned")}<span class="roster-phase">${esc(t.status)}</span></div>
        <div class="roster-task">${esc(t.description)}</div>
      </div>
    </div>`).join("");
}
