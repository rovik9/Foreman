import { api } from "../api.js";

const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };
const SOURCE_LABEL = { settings: "configured", env: "from .env", unset: "not set" };

async function renderKeys() {
  const keys = await api.listApiKeys();
  document.getElementById("settings-dot").classList.toggle("hidden", !keys.some((k) => k.set));
  const groups = { provider: [], integration: [] };
  for (const k of keys) groups[k.group].push(k);

  const section = (title, rows) => !rows.length ? "" : `
    <div class="key-group">
      <h4>${esc(title)}</h4>
      ${rows.map((k) => `
        <div class="key-row" data-name="${esc(k.name)}">
          <div class="key-info">
            <span class="key-label">${esc(k.label)}</span>
            <span class="key-src key-src-${esc(k.source)}">${SOURCE_LABEL[k.source]}</span>
          </div>
          <div class="key-controls">
            <input type="password" class="key-input" placeholder="${k.set ? '••••••••••••' : 'paste key'}" autocomplete="off">
            <button type="button" class="key-save">Save</button>
            <button type="button" class="key-clear" ${k.source !== "settings" ? "disabled" : ""}>Clear</button>
          </div>
        </div>`).join("")}
    </div>`;

  document.getElementById("keys-list").innerHTML =
    section("AI providers", groups.provider) + section("Integrations", groups.integration);

  for (const row of document.querySelectorAll(".key-row")) {
    const name = row.dataset.name;
    row.querySelector(".key-save").addEventListener("click", async () => {
      const input = row.querySelector(".key-input");
      if (!input.value.trim()) return;
      await api.saveApiKey(name, input.value.trim());
      await renderKeys();
    });
    row.querySelector(".key-clear").addEventListener("click", async () => {
      await api.deleteApiKey(name);
      await renderKeys();
    });
    row.querySelector(".key-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") row.querySelector(".key-save").click();
    });
  }
}

async function renderMcp() {
  const servers = await api.listMcpServers();
  const el = document.getElementById("mcp-list");
  el.innerHTML = servers.length ? servers.map((s) => `
    <div class="mcp-row" data-id="${s.id}">
      <div class="mcp-info">
        <span class="mcp-kind" data-kind="${esc(s.kind)}">${esc(s.kind)}</span>
        <span class="mcp-name">${esc(s.name)}</span>
        <span class="mcp-cmd">${esc([s.command, ...s.args].join(" "))}</span>
      </div>
      <div class="mcp-controls">
        <label class="mcp-toggle"><input type="checkbox" class="mcp-enabled" ${s.enabled ? "checked" : ""}> enabled</label>
        <span class="mcp-delete" title="Remove">&times;</span>
      </div>
    </div>`).join("") : '<div class="empty-hint">No MCP servers connected yet.</div>';

  for (const row of el.querySelectorAll(".mcp-row")) {
    const id = row.dataset.id;
    row.querySelector(".mcp-enabled").addEventListener("change", (e) => {
      api.setMcpServerEnabled(id, e.target.checked);
    });
    row.querySelector(".mcp-delete").addEventListener("click", async () => {
      if (!window.confirm("Remove this MCP server?")) return;
      await api.deleteMcpServer(id);
      await renderMcp();
    });
  }
}

function bindTabs() {
  for (const tab of document.querySelectorAll(".settings-tab")) {
    tab.addEventListener("click", () => {
      for (const t of document.querySelectorAll(".settings-tab")) t.classList.toggle("active", t === tab);
      for (const p of document.querySelectorAll(".settings-page")) p.classList.add("hidden");
      document.getElementById(`settings-${tab.dataset.tab}`).classList.remove("hidden");
    });
  }
}

async function updateDot() {
  try {
    const keys = await api.listApiKeys();
    document.getElementById("settings-dot").classList.toggle("hidden", !keys.some((k) => k.set));
  } catch {
    // non-critical — just a status hint
  }
}

export function bindSettings() {
  bindTabs();
  const modal = document.getElementById("settings-modal");
  updateDot();

  document.getElementById("settings-btn").addEventListener("click", async () => {
    modal.classList.remove("hidden");
    await Promise.all([renderKeys(), renderMcp()]);
  });
  document.getElementById("settings-close").addEventListener("click", () => {
    modal.classList.add("hidden");
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("hidden");
  });

  document.getElementById("mcp-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("mcp-name").value.trim();
    const kind = document.getElementById("mcp-kind").value;
    const command = document.getElementById("mcp-command").value.trim();
    const args = document.getElementById("mcp-args").value.trim().split(/\s+/).filter(Boolean);
    if (!name || !command) return;
    try {
      await api.createMcpServer({ name, kind, command, args });
      e.target.reset();
      await renderMcp();
    } catch (err) {
      window.alert(`Could not add MCP server: ${err.message}`);
    }
  });
}
