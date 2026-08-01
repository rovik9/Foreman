import { api } from "../api.js";
import { state } from "../state.js";

const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };

export function renderChat(messages) {
  const log = document.getElementById("chat-log");
  log.innerHTML = messages
    .filter((m) => ["user", "pm", "interface", "system"].includes(m.role))
    .map((m) => `<div class="msg msg-${m.role}"><b>${esc(m.role)}</b> ${esc(m.content.slice(0, 800))}</div>`)
    .join("");
  log.scrollTop = log.scrollHeight;
}

export function bindChat(refresh) {
  const send = async () => {
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text || !state.activeRun) return;
    await api.chat(state.activeRun, text);
    input.value = "";
    refresh();
  };
  document.getElementById("chat-send-btn").addEventListener("click", send);
  document.getElementById("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });
}
