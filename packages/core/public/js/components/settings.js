import { api } from "../api.js";

const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };
// "env" can come from .env *or* the shell that launched the server — don't
// claim .env specifically, that's how a stray inherited var looks configured
const SOURCE_LABEL = { settings: "configured", env: "from environment", unset: "not set" };
/** Keys with no vendor endpoint we can safely probe — hide the Test button. */
const UNTESTABLE = new Set(["HIGGSFIELD_API_KEY"]);

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
            <input type="password" class="key-input" placeholder="${k.set ? '••••••••••••  (saved)' : 'paste key'}" autocomplete="off">
            <button type="button" class="key-save">Save</button>
            ${UNTESTABLE.has(k.name) ? "" : `<button type="button" class="key-test" ${!k.set ? "disabled" : ""}>Test</button>`}
            <button type="button" class="key-clear" ${k.source !== "settings" ? "disabled" : ""}>Clear</button>
          </div>
          <div class="key-result"></div>
          <div class="key-env">env var <code>${esc(k.name)}</code></div>
        </div>`).join("")}
    </div>`;

  document.getElementById("keys-list").innerHTML =
    section("AI providers", groups.provider) + section("Integrations", groups.integration);

  for (const row of document.querySelectorAll(".key-row")) {
    const name = row.dataset.name;
    const input = row.querySelector(".key-input");
    const result = row.querySelector(".key-result");

    row.querySelector(".key-save").addEventListener("click", async () => {
      if (!input.value.trim()) return;
      await api.saveApiKey(name, input.value.trim());
      await renderKeys();
    });

    row.querySelector(".key-test")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      result.className = "key-result testing";
      result.textContent = "testing connection…";
      try {
        // tests the pasted value if one is typed, else the key already in effect
        const r = await api.testApiKey(name, input.value.trim() || undefined);
        result.className = `key-result ${r.ok ? "ok" : "err"}`;
        result.textContent = r.ok ? `connected — ${r.detail}` : r.error;
      } catch (err) {
        result.className = "key-result err";
        result.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });

    row.querySelector(".key-clear").addEventListener("click", async () => {
      await api.deleteApiKey(name);
      await renderKeys();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") row.querySelector(".key-save").click();
    });
  }
}

async function renderMcp() {
  const servers = await api.listMcpServers();
  const el = document.getElementById("mcp-list");
  el.innerHTML = servers.length ? servers.map((s) => `
    <div class="mcp-row" data-id="${s.id}">
      <div class="mcp-main">
        <span class="mcp-kind" data-kind="${esc(s.kind)}">${esc(s.kind)}</span>
        <span class="mcp-name">${esc(s.name)}</span>
        <span class="mcp-state" data-state="${esc(s.last_status ?? "untested")}">
          ${s.last_status === "ok" ? "reachable" : s.last_status === "error" ? "unreachable" : "untested"}
        </span>
        <span class="mcp-spacer"></span>
        <label class="mcp-toggle"><input type="checkbox" class="mcp-enabled" ${s.enabled ? "checked" : ""}> enabled</label>
        <button type="button" class="mcp-test">Test</button>
        <span class="mcp-delete" title="Remove">&times;</span>
      </div>
      <div class="mcp-cmd">${esc([s.command, ...s.args].join(" "))}</div>
      ${s.tools?.length ? `<div class="mcp-tools">${s.tools.map((t) => `<span class="mcp-tool">${esc(t)}</span>`).join("")}</div>` : ""}
      ${s.last_error ? `<div class="mcp-err">${esc(s.last_error)}</div>` : ""}
      <div class="mcp-result"></div>
    </div>`).join("") : `
    <div class="empty-hint">
      No MCP servers connected yet. Add one below — Foreman spawns it over stdio
      and any tools it exposes become available to the crew.
    </div>`;

  for (const row of el.querySelectorAll(".mcp-row")) {
    const id = row.dataset.id;
    const result = row.querySelector(".mcp-result");

    row.querySelector(".mcp-enabled").addEventListener("change", (e) => {
      api.setMcpServerEnabled(id, e.target.checked);
    });

    row.querySelector(".mcp-test").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      result.className = "mcp-result testing";
      result.textContent = "spawning server…";
      try {
        const r = await api.testMcpServer(id);
        result.className = `mcp-result ${r.ok ? "ok" : "err"}`;
        result.textContent = r.ok ? `connected — ${r.detail}` : r.error;
        await renderMcp();
      } catch (err) {
        result.className = "mcp-result err";
        result.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });

    row.querySelector(".mcp-delete").addEventListener("click", async () => {
      if (!window.confirm("Remove this MCP server?")) return;
      await api.deleteMcpServer(id);
      await renderMcp();
    });
  }
}

async function renderProviders() {
  const list = await api.listProviders();
  const el = document.getElementById("providers-list");
  el.innerHTML = list.length ? list.map((p) => `
    <div class="mcp-row" data-id="${p.id}">
      <div class="mcp-main">
        <span class="mcp-kind" data-kind="${esc(p.wire)}">${esc(p.wire)}</span>
        <span class="mcp-name">${esc(p.label)}</span>
        <code class="cp-via">via: ${esc(p.name)}</code>
        <span class="mcp-spacer"></span>
        <button type="button" class="mcp-test cp-test">Test</button>
        <span class="mcp-delete cp-delete" title="Remove">&times;</span>
      </div>
      <div class="mcp-cmd">${esc(p.base_url)}${p.has_key ? "  ·  key set" : "  ·  no key"}</div>
      <div class="mcp-result"></div>
    </div>`).join("") : '<div class="empty-hint">No custom providers. The built-in vendors on the API Keys tab need only a key.</div>';

  for (const row of el.querySelectorAll(".mcp-row")) {
    const id = row.dataset.id;
    const result = row.querySelector(".mcp-result");
    row.querySelector(".cp-test").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      result.className = "mcp-result testing";
      result.textContent = "reaching endpoint…";
      try {
        const r = await api.testProvider(id);
        result.className = `mcp-result ${r.ok ? "ok" : "err"}`;
        result.textContent = r.ok ? `connected — ${r.detail}` : r.error;
      } catch (err) {
        result.className = "mcp-result err";
        result.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });
    row.querySelector(".cp-delete").addEventListener("click", async () => {
      if (!window.confirm("Remove this provider?")) return;
      await api.deleteProvider(id);
      await renderProviders();
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
    await Promise.all([renderKeys(), renderMcp(), renderProviders()]);
  });
  document.getElementById("settings-close").addEventListener("click", () => {
    modal.classList.add("hidden");
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("hidden");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) modal.classList.add("hidden");
  });

  document.getElementById("provider-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = (id) => document.getElementById(id).value.trim();
    try {
      await api.createProvider({
        name: val("cp-name"),
        label: val("cp-label") || undefined,
        base_url: val("cp-base"),
        api_key: val("cp-key") || undefined,
        wire: document.getElementById("cp-wire").value,
      });
      e.target.reset();
      await renderProviders();
    } catch (err) {
      window.alert(`Could not add provider: ${err.message}`);
    }
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
