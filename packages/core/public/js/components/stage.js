import { api } from "../api.js";
import { setActiveRun } from "../state.js";
import { sse } from "../sse.js";

const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };
const MEDIA = {
  video: [".mp4", ".webm", ".mov"],
  audio: [".mp3", ".wav", ".m4a"],
  image: [".png", ".jpg", ".jpeg", ".webp", ".svg"],
};

// ---- tabs ----

export function bindStageTabs() {
  for (const tab of document.querySelectorAll(".stage-tab")) {
    tab.addEventListener("click", () => {
      for (const t of document.querySelectorAll(".stage-tab")) t.classList.toggle("active", t === tab);
      for (const p of document.querySelectorAll(".stage-page")) p.classList.add("hidden");
      document.getElementById(`stage-${tab.dataset.tab}`).classList.remove("hidden");
    });
  }
}

// ---- feed ----

function fmtJSON(data) {
  const s = esc(JSON.stringify(data, null, 2));
  return s.replace(
    /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "jnum";
      if (/^"/.test(match)) cls = /:$/.test(match) ? "jk" : "js";
      else if (/true|false/.test(match)) cls = "jb";
      else if (/null/.test(match)) cls = "jn";
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

export function feedLine(e) {
  const feed = document.getElementById("stage-feed");
  const div = document.createElement("div");
  div.className = `ev ev-${e.type}`;
  div.innerHTML = `<div class="ev-head"><span class="ev-type">${esc(e.type)}</span><span class="ev-meta">${esc(e.at.slice(11, 19))}</span></div>
    <pre class="ev-body">${fmtJSON(e.data)}</pre>`;
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

export function clearFeed() {
  document.getElementById("stage-feed").innerHTML = "";
}

// ---- assets ----

export function renderAssets(runId, artifacts) {
  const el = document.getElementById("stage-assets");
  if (!artifacts.length) { el.innerHTML = '<div class="mem">Nothing generated yet.</div>'; return; }
  el.innerHTML = artifacts.map((a) => {
    const ext = a.path.slice(a.path.lastIndexOf(".")).toLowerCase();
    const url = api.fileUrl(runId, a.path);
    if (MEDIA.video.includes(ext)) return `<video controls src="${url}"></video>`;
    if (MEDIA.audio.includes(ext)) return `<audio controls src="${url}"></audio>`;
    if (MEDIA.image.includes(ext)) return `<a href="${url}" target="_blank"><img src="${url}" alt=""></a>`;
    return `<div class="asset"><a href="${url}" target="_blank">[${esc(a.kind)}] ${esc(a.path)}</a></div>`;
  }).join("");
}

// ---- permissions (unified inbox: blocked runs + critical memories) ----

export async function renderPermissions() {
  const [runs, mems] = await Promise.all([api.listRuns(), api.listMemories()]);
  const blocked = runs.filter((r) => ["awaiting_user", "paused_budget"].includes(r.status));
  const criticals = mems.filter((m) => m.status === "awaiting_user");

  const count = blocked.length + criticals.length;
  const badge = document.getElementById("perm-count");
  badge.textContent = count ? String(count) : "";
  badge.classList.toggle("hidden", count === 0);

  document.getElementById("stage-permissions").innerHTML =
    (blocked.length
      ? `<h4>Runs waiting on you</h4>` + blocked.map((r) => `
        <div class="perm-card" data-run-id="${r.id}">
          <span class="pill" data-status="${esc(r.status)}">${esc(r.status)}</span>
          <div>${esc(r.prompt.slice(0, 80))}</div>
          ${r.status === "paused_budget" ? `<button class="perm-topup" data-id="${r.id}">+ $5 top-up &amp; resume</button>` : ""}
          <button class="perm-open" data-id="${r.id}">open</button>
        </div>`).join("")
      : "") +
    (criticals.length
      ? `<h4>Memory writes needing your call</h4>` + criticals.map((m) => `
        <div class="perm-card">
          <span class="pill">${esc(m.kind)}</span> ${esc(m.text)}
          <button class="perm-approve" data-id="${m.id}">approve</button>
          <button class="perm-reject" data-id="${m.id}">reject</button>
        </div>`).join("")
      : "") +
    (count === 0 ? '<div class="mem">Inbox zero. Nothing needs you.</div>' : "");

  for (const btn of document.querySelectorAll(".perm-open")) {
    btn.addEventListener("click", () => setActiveRun(btn.dataset.id));
  }
  for (const btn of document.querySelectorAll(".perm-topup")) {
    btn.addEventListener("click", async () => {
      await api.topUpBudget(btn.dataset.id, 5);
      renderPermissions();
    });
  }
  for (const btn of document.querySelectorAll(".perm-approve, .perm-reject")) {
    btn.addEventListener("click", async () => {
      await api.decideMemory(btn.dataset.id, btn.classList.contains("perm-approve") ? "approve" : "reject");
      renderPermissions();
    });
  }
}

export function bindStageEvents(refresh) {
  for (const type of ["run_status", "task_status", "agent_call", "gate", "judge", "message", "artifact"]) {
    sse.on(type, (e) => {
      feedLine(e);
      if (["task_status", "run_status", "artifact"].includes(e.type)) refresh();
    });
  }
  sse.on("cost", (e) => {
    document.getElementById("cost-session").textContent = `$${e.data.runTotalUsd.toFixed(4)}`;
  });
}
