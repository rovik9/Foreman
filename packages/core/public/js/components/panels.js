import { api } from "../api.js";

const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };
const MEDIA = {
  video: [".mp4", ".webm", ".mov"],
  audio: [".mp3", ".wav", ".m4a"],
  image: [".png", ".jpg", ".jpeg", ".webp", ".svg"],
};

export function renderTasks(tasks) {
  document.getElementById("tasks-list").innerHTML = tasks.map((t) => `
    <div class="task-card">
      <span class="pill">${esc(t.status)}</span>
      <div class="task-desc">${esc(t.description)}</div>
      <div class="task-meta">${esc(t.class)} · ${esc(t.slot ?? "-")} · ${t.iterations}x · $${t.cost_usd.toFixed(4)}</div>
    </div>`).join("");
}

export function renderAssets(runId, artifacts) {
  const el = document.getElementById("assets-list");
  if (!artifacts.length) { el.innerHTML = '<div class="mem">none yet</div>'; return; }
  el.innerHTML = artifacts.map((a) => {
    const ext = a.path.slice(a.path.lastIndexOf(".")).toLowerCase();
    const url = api.fileUrl(runId, a.path);
    if (MEDIA.video.includes(ext)) return `<video controls src="${url}"></video>`;
    if (MEDIA.audio.includes(ext)) return `<audio controls src="${url}"></audio>`;
    if (MEDIA.image.includes(ext)) return `<a href="${url}" target="_blank"><img src="${url}" alt=""></a>`;
    return `<div class="asset"><a href="${url}" target="_blank">[${esc(a.kind)}] ${esc(a.path)}</a></div>`;
  }).join("");
}
