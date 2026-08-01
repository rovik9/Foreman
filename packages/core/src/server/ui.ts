/** Mission-control stopgap UI — single file, no build step. Replaced by the
 *  Vite+React app in a later phase; the SSE/REST contract stays identical. */
export const MISSION_CONTROL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Foreman — Mission Control</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0d1117; color: #e6edf3; height: 100vh; display: flex; flex-direction: column; }
  header { padding: 10px 16px; background: #161b22; border-bottom: 1px solid #30363d;
           display: flex; gap: 12px; align-items: center; }
  header b { color: #f0b429; }
  #cost { margin-left: auto; color: #3fb950; }
  #promptbar { display: flex; gap: 8px; padding: 10px 16px; background: #161b22; }
  #promptbar input { flex: 1; background: #0d1117; color: #e6edf3; border: 1px solid #30363d;
                     border-radius: 6px; padding: 8px 10px; font: inherit; }
  button { background: #f0b429; color: #0d1117; border: 0; border-radius: 6px;
           padding: 8px 14px; font: inherit; font-weight: 700; cursor: pointer; }
  main { flex: 1; display: grid; grid-template-columns: 220px 1fr 340px; min-height: 0; }
  #runs { border-right: 1px solid #30363d; overflow-y: auto; padding: 10px; }
  .run { padding: 6px 8px; margin: 4px 0; background: #161b22; border-radius: 6px;
         cursor: pointer; border-left: 3px solid #30363d; }
  .run:hover { border-color: #58a6ff; }
  .run.active { border-color: #f0b429; }
  .run .st { float: right; color: #8b949e; font-size: 11px; }
  #feed { overflow-y: auto; padding: 12px 16px; }
  #side { border-left: 1px solid #30363d; display: flex; flex-direction: column; min-height: 0; }
  #tasks { flex: 1; overflow-y: auto; padding: 12px; border-bottom: 1px solid #30363d; }
  #assets { max-height: 220px; overflow-y: auto; padding: 12px; border-bottom: 1px solid #30363d; }
  #assets video, #assets img { width: 100%; border-radius: 6px; margin: 4px 0; }
  #assets audio { width: 100%; margin: 4px 0; }
  #chatlog { flex: 1; overflow-y: auto; padding: 12px; }
  #memories { max-height: 140px; overflow-y: auto; padding: 10px; border-top: 1px solid #30363d; }
  #chatbar { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #30363d; }
  #chatbar input { flex: 1; background: #0d1117; color: #e6edf3; border: 1px solid #30363d;
                   border-radius: 6px; padding: 8px; font: inherit; }
  .ev { padding: 6px 10px; margin: 4px 0; border-radius: 6px; background: #161b22;
        border-left: 3px solid #30363d; white-space: pre-wrap; word-break: break-word; }
  .ev.agent_call { border-color: #58a6ff; }
  .ev.task_status { border-color: #d2a8ff; }
  .ev.judge { border-color: #f0b429; }
  .ev.gate { border-color: #3fb950; }
  .ev.run_status { border-color: #f85149; }
  .ev.artifact { border-color: #39c5cf; }
  .ev .t { color: #8b949e; font-size: 11px; }
  .task { padding: 6px 8px; margin: 4px 0; background: #161b22; border-radius: 6px; }
  .task .s { float: right; }
  .msg { padding: 4px 8px; margin: 3px 0; border-radius: 6px; }
  .msg.user { background: #1f6feb33; }
  .msg.pm { background: #f0b42922; }
  .msg.system { background: #f8514922; }
  .mem { padding: 3px 6px; margin: 2px 0; color: #8b949e; font-size: 12px; }
  a { color: #58a6ff; }
  h3 { margin: 4px 0 8px; font-size: 12px; color: #8b949e; text-transform: uppercase; }
</style>
</head>
<body>
<header><b>● FOREMAN</b><span id="runlabel">select or start a run</span><span id="cost">$0.0000</span></header>
<div id="promptbar">
  <input id="prompt" placeholder="Tell the foreman what to build…" autofocus>
  <button onclick="startRun()">Dispatch</button>
</div>
<main>
  <div id="runs"><h3>Runs</h3></div>
  <div id="feed"><h3>Activity</h3></div>
  <div id="side">
    <div id="tasks"><h3>Tasks</h3></div>
    <div id="assets"><h3>Assets</h3></div>
    <div id="chatlog"><h3>Chat</h3></div>
    <div id="memories"><h3>Memory</h3></div>
    <div id="chatbar">
      <input id="chat" placeholder="Steer mid-run / answer PM…">
      <button onclick="sendChat()">Send</button>
    </div>
  </div>
</main>
<script>
let runId = null, es = null;
const $ = (id) => document.getElementById(id);
const MEDIA = { video: [".mp4",".webm",".mov"], audio: [".mp3",".wav",".m4a"],
                image: [".png",".jpg",".jpeg",".webp",".svg"] };

async function startRun() {
  const prompt = $("prompt").value.trim();
  if (!prompt) return;
  const r = await fetch("/runs", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }) });
  const { id } = await r.json();
  $("prompt").value = "";
  attach(id);
  loadRuns();
}

function attach(id) {
  runId = id;
  $("runlabel").textContent = "run " + id.slice(0, 8);
  $("feed").innerHTML = "<h3>Activity</h3>";
  if (es) es.close();
  es = new EventSource("/runs/" + id + "/events");
  ["run_status","task_status","agent_call","gate","judge","cost","message","artifact"].forEach((t) =>
    es.addEventListener(t, (m) => onEvent(JSON.parse(m.data))));
  refresh();
}

function onEvent(e) {
  if (e.type === "cost") {
    $("cost").textContent = "$" + e.data.runTotalUsd.toFixed(4);
    return;
  }
  const div = document.createElement("div");
  div.className = "ev " + e.type;
  div.innerHTML = "<span class=t>" + e.at.slice(11, 19) + " " + e.type + "</span><br>" +
    esc(JSON.stringify(e.data, null, 1).slice(0, 600));
  $("feed").appendChild(div);
  $("feed").scrollTop = $("feed").scrollHeight;
  if (["task_status","run_status","artifact"].includes(e.type)) refresh();
}

function mediaTag(path) {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  const url = "/runs/" + runId + "/files/" + path;
  if (MEDIA.video.includes(ext)) return '<video controls src="' + url + '"></video>';
  if (MEDIA.audio.includes(ext)) return '<audio controls src="' + url + '"></audio>';
  if (MEDIA.image.includes(ext)) return '<a href="' + url + '" target=_blank><img src="' + url + '"></a>';
  return '<div><a href="' + url + '" target=_blank>' + esc(path) + "</a></div>";
}

async function refresh() {
  if (!runId) return;
  const d = await (await fetch("/runs/" + runId)).json();
  $("cost").textContent = "$" + d.run.cost_usd.toFixed(4);
  $("tasks").innerHTML = "<h3>Tasks</h3>" + d.tasks.map((t) =>
    '<div class="task"><span class="s">' + t.status + " · " + t.iterations + "x · " + (t.slot || "") +
    "</span>" + esc(t.description) + "</div>").join("");
  $("assets").innerHTML = "<h3>Assets</h3>" + (d.artifacts.length
    ? d.artifacts.map((a) => mediaTag(a.path)).join("")
    : '<div class=mem>none yet</div>');
  $("chatlog").innerHTML = "<h3>Chat</h3>" + d.messages
    .filter((m) => ["user","pm","system"].includes(m.role))
    .map((m) => '<div class="msg ' + m.role + '"><b>' + m.role + ":</b> " +
      esc(m.content.slice(0, 800)) + "</div>").join("");
  $("chatlog").scrollTop = $("chatlog").scrollHeight;
}

async function loadRuns() {
  const runs = await (await fetch("/runs")).json();
  $("runs").innerHTML = "<h3>Runs</h3>" + runs.map((r) =>
    '<div class="run' + (r.id === runId ? " active" : "") + '" onclick="attach(&quot;' + r.id + '&quot;)">' +
    '<span class=st>' + r.status + "</span>" + esc(r.prompt.slice(0, 40)) + "</div>").join("");
}

async function loadMemories() {
  const mems = await (await fetch("/memories")).json();
  $("memories").innerHTML = "<h3>Memory (" + mems.length + ")</h3>" +
    mems.slice(0, 12).map((m) => '<div class=mem>[' + m.kind + "] " + esc(m.text) + "</div>").join("");
}

async function sendChat() {
  const msg = $("chat").value.trim();
  if (!msg || !runId) return;
  await fetch("/runs/" + runId + "/chat", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: msg }) });
  $("chat").value = "";
  refresh();
}

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
$("prompt").addEventListener("keydown", (e) => e.key === "Enter" && startRun());
$("chat").addEventListener("keydown", (e) => e.key === "Enter" && sendChat());
loadRuns(); loadMemories();
setInterval(() => { loadRuns(); loadMemories(); }, 8000);
</script>
</body>
</html>`;
