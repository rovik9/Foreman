const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };

const ROLE_LABEL = {
  user: "You", pm: "Interface", interface: "Interface", architect: "Architect",
  builder: "Builder", judge: "Judge", context: "Context", realtime: "Trend",
  memory: "Memory", system: "System",
};

/** "Interface & crew" — every prompt/response the Interface AI compiled, full transcript. */
export function renderPromptings(messages) {
  const el = document.getElementById("promptings-list");
  if (!messages.length) { el.innerHTML = '<div class="empty-hint">Nothing said yet — dispatch a goal to start the conversation.</div>'; return; }
  el.innerHTML = messages.map((m) => `
    <div class="prompt-msg" data-role="${esc(m.role)}">
      <div class="prompt-head">
        <b>${esc(ROLE_LABEL[m.role] ?? m.role)}</b>
        ${m.slot ? `<span class="prompt-slot">${esc(m.slot)}</span>` : ""}
      </div>
      <div class="prompt-body">${esc(m.content)}</div>
    </div>`).join("");
  el.scrollTop = el.scrollHeight;
}
