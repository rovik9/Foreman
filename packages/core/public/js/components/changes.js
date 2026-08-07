import { api } from "../api.js";

const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };

/** Compact changed-files list, distinct from the rich media previews in Assets. */
export function renderChanges(runId, artifacts) {
  const el = document.getElementById("changes-list");
  const count = document.getElementById("changes-count");
  if (count) count.textContent = artifacts.length ? String(artifacts.length) : "";
  if (!artifacts.length) { el.innerHTML = '<div class="empty-hint">No files produced yet.</div>'; return; }
  el.innerHTML = artifacts.map((a) => `
    <a class="change-row" href="${api.fileUrl(runId, a.path)}" target="_blank" rel="noopener">
      <span class="change-kind" data-kind="${esc(a.kind)}">${esc(a.kind)}</span>
      <span class="change-path">${esc(a.path)}</span>
    </a>`).join("");
}
