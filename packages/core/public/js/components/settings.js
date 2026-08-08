import { api } from "../api.js";

const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };
// "env" can come from .env *or* the shell that launched the server — don't
// claim .env specifically, that's how a stray inherited var looks configured
const SOURCE_LABEL = { settings: "configured", env: "from environment", unset: "not set" };
/** Keys with nothing to probe — plain IDs, or no public validation endpoint. */
const UNTESTABLE = new Set([
  "HIGGSFIELD_API_KEY",
  "TELEGRAM_ALLOWED_USER_IDS",
  "DISCORD_GUILD_ID",
  "DISCORD_ALLOWED_USER_IDS",
]);

async function renderKeys() {
  const keys = await api.listApiKeys();
  document.getElementById("settings-dot").classList.toggle("hidden", !keys.some((k) => k.set));
  const groups = { provider: [], integration: [], gateway: [], custom: [] };
  for (const k of keys) (groups[k.group] ??= []).push(k);

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
          <div class="key-env">
            env var <code>${esc(k.name)}</code>${k.restart_required ? " · read at boot, restart to apply" : ""}
          </div>
        </div>`).join("")}
    </div>`;

  document.getElementById("keys-list").innerHTML =
    section("AI providers", groups.provider)
    + section("Integrations", groups.integration)
    + section("DM gateway", groups.gateway)
    + section("Custom", groups.custom);

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

const LIMIT_FIELDS = [
  { key: "max_cost_per_run_usd", label: "Max cost per run", unit: "USD", step: "0.5", min: "0.01" },
  { key: "max_cost_per_task_usd", label: "Max cost per task", unit: "USD", step: "0.1", min: "0.01" },
  { key: "max_iterations_per_task", label: "Max retries per task", unit: "attempts", step: "1", min: "1" },
  { key: "max_parallel_builders", label: "Parallel builders", unit: "at once", step: "1", min: "1" },
  { key: "pm_clarify_confidence_threshold", label: "Clarify below confidence", unit: "0–1", step: "0.05", min: "0", max: "1" },
  { key: "judge_pass_score", label: "Judge pass score", unit: "0–1", step: "0.05", min: "0", max: "1" },
];

async function renderEngine() {
  const cfg = await api.getConfig();
  const overridden = new Set(cfg.overridden);

  document.getElementById("engine-limits").innerHTML = LIMIT_FIELDS.map((f) => {
    const isOver = overridden.has(`limits.${f.key}`);
    return `
      <div class="cfg-row" data-key="limits.${f.key}">
        <div class="cfg-info">
          <span class="cfg-label">${esc(f.label)}</span>
          ${isOver ? '<span class="cfg-badge">overridden</span>' : ""}
        </div>
        <div class="cfg-controls">
          <input class="cfg-input" type="number" value="${cfg.limits[f.key]}"
                 step="${f.step}" min="${f.min}" ${f.max ? `max="${f.max}"` : ""}>
          <span class="cfg-unit">${esc(f.unit)}</span>
          <button type="button" class="cfg-save">Save</button>
          <button type="button" class="cfg-reset" ${isOver ? "" : "disabled"}>Reset</button>
        </div>
        <div class="cfg-result"></div>
      </div>`;
  }).join("");

  const slots = Object.keys(cfg.slots);
  document.getElementById("engine-roles").innerHTML = Object.entries(cfg.roles).map(([role, r]) => `
    <div class="cfg-row role-row" data-role="${esc(role)}">
      <div class="cfg-info">
        <span class="cfg-label">${esc(role)}</span>
        ${overridden.has(`roles.${role}`) ? '<span class="cfg-badge">overridden</span>' : ""}
        <span class="cfg-unit">active:</span>
        <select class="role-active">
          ${r.options.map((o) => `<option value="${esc(o)}" ${o === r.active ? "selected" : ""}>${esc(o)}</option>`).join("")}
        </select>
      </div>
      <div class="role-options">
        ${slots.map((s) => `
          <label class="role-opt ${r.options.includes(s) ? "on" : ""}">
            <input type="checkbox" value="${esc(s)}" ${r.options.includes(s) ? "checked" : ""}>
            ${esc(s)}<span class="role-model">${esc(cfg.slots[s].model)}</span>
          </label>`).join("")}
      </div>
      <div class="cfg-result"></div>
    </div>`).join("");

  for (const row of document.querySelectorAll("#engine-limits .cfg-row")) {
    const key = row.dataset.key;
    const input = row.querySelector(".cfg-input");
    const result = row.querySelector(".cfg-result");
    const save = async () => {
      result.className = "cfg-result";
      try {
        await api.setConfig(key, Number(input.value));
        await renderEngine();
      } catch (err) {
        result.className = "cfg-result err";
        result.textContent = err.message;
      }
    };
    row.querySelector(".cfg-save").addEventListener("click", save);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
    row.querySelector(".cfg-reset").addEventListener("click", async () => {
      await api.resetConfig(key);
      await renderEngine();
    });
  }

  for (const row of document.querySelectorAll(".role-row")) {
    const role = row.dataset.role;
    const result = row.querySelector(".cfg-result");
    const commit = async () => {
      const options = [...row.querySelectorAll(".role-options input:checked")].map((i) => i.value);
      const active = row.querySelector(".role-active").value;
      result.className = "cfg-result";
      try {
        await api.setConfig(`roles.${role}`, {
          options,
          // keep active valid when it was just unchecked
          active: options.includes(active) ? active : options[0],
        });
        await renderEngine();
      } catch (err) {
        result.className = "cfg-result err";
        result.textContent = err.message;
      }
    };
    row.querySelector(".role-active").addEventListener("change", commit);
    for (const box of row.querySelectorAll(".role-options input")) {
      box.addEventListener("change", () => {
        if (!row.querySelectorAll(".role-options input:checked").length) {
          box.checked = true;
          result.className = "cfg-result err";
          result.textContent = "a role needs at least one option";
          return;
        }
        commit();
      });
    }
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
    await Promise.all([renderKeys(), renderMcp(), renderProviders(), renderEngine()]);
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
