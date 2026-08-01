import { sse } from "../sse.js";

const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };
const feed = () => document.getElementById("activity-feed");

function line(e) {
  const div = document.createElement("div");
  div.className = `ev ev-${e.type}`;
  div.innerHTML = `<span class="ev-meta">${e.at.slice(11, 19)} · ${e.type}</span>
    <div class="ev-body">${esc(JSON.stringify(e.data, null, 1).slice(0, 600))}</div>`;
  feed().appendChild(div);
  feed().scrollTop = feed().scrollHeight;
}

export function bindFeed(refresh) {
  for (const type of ["run_status", "task_status", "agent_call", "gate", "judge", "message", "artifact"]) {
    sse.on(type, (e) => {
      line(e);
      if (["task_status", "run_status", "artifact"].includes(type)) refresh();
    });
  }
  sse.on("cost", (e) => {
    document.getElementById("cost-meter").textContent = `$${e.data.runTotalUsd.toFixed(4)}`;
  });
}

export function clearFeed() {
  feed().innerHTML = "";
}
