import { api } from "../api.js";

const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };

/** Colourises a unified-ish hunk so +/- lines read at a glance. */
function renderHunk(hunk) {
  return hunk.split("\n").map((line) => {
    const cls = line.startsWith("+") ? "d-add" : line.startsWith("-") ? "d-del" : "d-ctx";
    return `<span class="${cls}">${esc(line)}</span>`;
  }).join("\n");
}

/**
 * Real diffs against the project checkout, not just a list of filenames.
 * Falls back to the artifact list when there's no diff to compute (no run
 * workspace, or the project has no local folder yet).
 */
export async function renderChanges(runId, artifacts) {
  const el = document.getElementById("changes-list");
  const count = document.getElementById("changes-count");

  let diffs = [];
  if (runId) {
    try {
      diffs = (await api.runDiff(runId)).filter((d) => d.status !== "unchanged");
    } catch {
      diffs = [];
    }
  }

  if (diffs.length) {
    count.textContent = String(diffs.length);
    el.innerHTML = diffs.map((d) => `
      <details class="diff" data-status="${esc(d.status)}">
        <summary>
          <span class="change-kind" data-kind="${d.status === "added" ? "code" : "doc"}">${esc(d.status)}</span>
          <span class="change-path">${esc(d.path)}</span>
          <span class="diff-stat"><b class="d-add">+${d.added}</b> <b class="d-del">−${d.removed}</b></span>
        </summary>
        <pre class="diff-body">${renderHunk(d.hunk)}</pre>
      </details>`).join("");
    return;
  }

  count.textContent = artifacts.length ? String(artifacts.length) : "";
  if (!artifacts.length) { el.innerHTML = '<div class="empty-hint">No files produced yet.</div>'; return; }
  el.innerHTML = artifacts.map((a) => `
    <a class="change-row" href="${api.fileUrl(runId, a.path)}" target="_blank" rel="noopener">
      <span class="change-kind" data-kind="${esc(a.kind)}">${esc(a.kind)}</span>
      <span class="change-path">${esc(a.path)}</span>
    </a>`).join("");
}
