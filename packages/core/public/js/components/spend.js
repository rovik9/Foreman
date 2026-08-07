import { api } from "../api.js";
import { state, setActiveRun } from "../state.js";

const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };
const usd = (n) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
const compact = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

/** Deterministic hue per model so the same model keeps its colour across views. */
function hue(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}
const swatch = (key) => `hsl(${hue(key)} 70% 62%)`;

function barRows(items, valueOf, labelOf, subOf) {
  const max = Math.max(...items.map(valueOf), 0.0000001);
  return items.map((it) => `
    <div class="bar-row">
      <div class="bar-head">
        <span class="bar-dot" style="background:${swatch(labelOf(it))}"></span>
        <span class="bar-label">${esc(labelOf(it))}</span>
        <span class="bar-sub">${esc(subOf(it))}</span>
        <span class="bar-value">${usd(valueOf(it))}</span>
      </div>
      <div class="bar-track">
        <span class="bar-fill" style="width:${(valueOf(it) / max) * 100}%;background:${swatch(labelOf(it))}"></span>
      </div>
    </div>`).join("");
}

/** Sparkline-ish daily column chart — pure CSS/DOM, no chart library. */
function dayChart(byDay) {
  if (byDay.length < 2) return "";
  const max = Math.max(...byDay.map((d) => d.cost), 0.0000001);
  return `
    <div class="spend-block">
      <h4>Daily spend</h4>
      <div class="day-chart">
        ${byDay.map((d) => `
          <div class="day-col" title="${esc(d.day)} — ${usd(d.cost)}">
            <span class="day-bar" style="height:${Math.max(3, (d.cost / max) * 100)}%"></span>
            <span class="day-label">${esc(d.day.slice(5))}</span>
          </div>`).join("")}
      </div>
    </div>`;
}

export async function renderSpend() {
  const el = document.getElementById("stage-spend");
  const scope = state.activeProject;
  let report;
  try {
    report = await api.spend(scope ?? undefined);
  } catch (err) {
    el.innerHTML = `<div class="empty-hint">Could not load spend: ${esc(err.message)}</div>`;
    return;
  }

  const { totals, byModel, byDay, byRun } = report;
  if (!totals.calls) {
    el.innerHTML = `
      <div class="spend-scope">${scope ? `Project: <b>${esc(scope)}</b>` : "All projects"}</div>
      <div class="empty-hint">No spend recorded yet. Costs appear here as soon as the crew makes its first model call.</div>`;
    return;
  }

  const totalTokens = totals.promptTokens + totals.completionTokens;
  el.innerHTML = `
    <div class="spend-scope">${scope ? `Project: <b>${esc(scope)}</b>` : "All projects"}</div>

    <div class="spend-totals">
      <div class="stat-tile"><span class="stat-value">${usd(totals.cost)}</span><span class="stat-label">Total spend</span></div>
      <div class="stat-tile"><span class="stat-value">${compact(totals.calls)}</span><span class="stat-label">Model calls</span></div>
      <div class="stat-tile"><span class="stat-value">${compact(totalTokens)}</span><span class="stat-label">Tokens</span></div>
      <div class="stat-tile"><span class="stat-value">${usd(totals.cost / Math.max(1, totals.calls))}</span><span class="stat-label">Avg / call</span></div>
    </div>

    ${dayChart(byDay)}

    <div class="spend-block">
      <h4>By model</h4>
      ${barRows(byModel, (m) => m.cost, (m) => m.model,
        (m) => `${m.slot} · ${m.calls} call${m.calls === 1 ? "" : "s"} · ${compact(m.promptTokens + m.completionTokens)} tok`)}
    </div>

    <div class="spend-block">
      <h4>By run</h4>
      ${byRun.map((r) => `
        <div class="spend-run" data-run-id="${esc(r.run_id)}">
          <span class="pill" data-status="${esc(r.status)}">${esc(r.status)}</span>
          <span class="spend-run-prompt">${esc(r.prompt)}</span>
          <span class="spend-run-calls">${r.calls} call${r.calls === 1 ? "" : "s"}</span>
          <span class="spend-run-cost">${usd(r.cost)}</span>
        </div>`).join("")}
    </div>`;

  for (const row of el.querySelectorAll(".spend-run")) {
    row.addEventListener("click", () => setActiveRun(row.dataset.runId));
  }
}
