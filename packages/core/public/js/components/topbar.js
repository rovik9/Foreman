import { api } from "../api.js";
import { state, setActiveProject } from "../state.js";

const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };

export async function renderTopbar() {
  state.projects = await api.listProjects();
  const tabs = document.getElementById("project-tabs");
  tabs.innerHTML =
    `<button class="ptab ${state.activeProject === null ? "active" : ""}" data-slug="">all</button>` +
    state.projects.map((p) => `
      <span class="ptab ${p.slug === state.activeProject ? "active" : ""}" data-slug="${p.slug}">
        ${esc(p.name)}
        <span class="ptab-x" data-del="${p.slug}" title="Remove project">×</span>
      </span>`).join("");

  for (const el of tabs.querySelectorAll(".ptab[data-slug]")) {
    el.addEventListener("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (del) return;
      const slug = el.dataset.slug || null;
      setActiveProject(slug);
    });
  }
  for (const x of tabs.querySelectorAll("[data-del]")) {
    x.addEventListener("click", async () => {
      if (!window.confirm(`Remove project "${x.dataset.del}" from the list? (files stay on disk)`)) return;
      await api.deleteProject(x.dataset.del);
      if (state.activeProject === x.dataset.del) setActiveProject(null);
      await renderTopbar();
    });
  }

  const active = state.projects.find((p) => p.slug === state.activeProject);
  document.getElementById("cost-project").textContent =
    active ? `proj $${active.cost_usd.toFixed(2)}` : "proj $0.00";
}

// ---- local folder picker — server lists real directories, browsers can't ----

let fsPickerTarget = null;
let fsPickerPath = null;

async function loadFsPicker(path) {
  const picker = document.getElementById("fs-picker");
  const pathEl = document.getElementById("fs-picker-path");
  const list = document.getElementById("fs-picker-list");
  try {
    const listing = await api.listDir(path);
    fsPickerPath = listing.path;
    pathEl.textContent = listing.path;
    const rows = [];
    if (listing.parent) rows.push(`<div class="fs-entry fs-up" data-path="${esc(listing.parent)}">.. (up)</div>`);
    rows.push(...listing.entries.map((e) => `<div class="fs-entry" data-path="${esc(e.path)}">${esc(e.name)}</div>`));
    list.innerHTML = rows.length ? rows.join("") : '<div class="fs-empty">No subfolders here.</div>';
    for (const row of list.querySelectorAll(".fs-entry")) {
      row.addEventListener("click", () => loadFsPicker(row.dataset.path));
    }
  } catch (err) {
    pathEl.textContent = path ?? "";
    list.innerHTML = `<div class="fs-empty">${esc(err.message)}</div>`;
  }
  picker.classList.remove("hidden");
}

function bindFsPicker() {
  document.getElementById("fs-picker-cancel").addEventListener("click", () => {
    document.getElementById("fs-picker").classList.add("hidden");
    fsPickerTarget = null;
  });
  document.getElementById("fs-picker-choose").addEventListener("click", () => {
    if (fsPickerTarget && fsPickerPath) fsPickerTarget.value = fsPickerPath;
    document.getElementById("fs-picker").classList.add("hidden");
    fsPickerTarget = null;
  });
  document.getElementById("project-form").addEventListener("click", (e) => {
    const btn = e.target.closest(".pf-browse");
    if (!btn) return;
    fsPickerTarget = btn.closest(".pf-path-row").querySelector("input");
    loadFsPicker(fsPickerTarget.value.trim() || undefined);
  });
}

// ---- repo rows — live git ls-remote validation, since these are usually private.
// Modular auth: system (ambient git identity, default) / ssh_key / token — see
// server/git-auth.ts, the single place that knows how to turn these into a
// real git invocation. Nothing here is persisted; it's used for this request only.

function repoRow(placeholder) {
  const block = document.createElement("div");
  block.className = "pf-repo-block";
  block.innerHTML = `
    <div class="pf-repo-row">
      <input class="pf-repo-input" placeholder="${esc(placeholder)}">
      <span class="pf-repo-status"></span>
    </div>
    <div class="pf-repo-auth">
      <select class="pf-repo-auth-method">
        <option value="system">System git (default)</option>
        <option value="ssh_key">SSH key…</option>
        <option value="token">Token…</option>
      </select>
      <div class="pf-repo-auth-field"></div>
    </div>`;
  return block;
}

function folderRow(placeholder) {
  const row = document.createElement("div");
  row.className = "pf-path-row";
  row.innerHTML = `<input class="pf-folder-path" placeholder="${esc(placeholder)}"><button type="button" class="pf-browse">Browse&hellip;</button>`;
  return row;
}

function renderRepoAuthField(block) {
  const method = block.querySelector(".pf-repo-auth-method").value;
  const field = block.querySelector(".pf-repo-auth-field");
  if (method === "ssh_key") {
    field.innerHTML = `<div class="pf-path-row"><input class="pf-repo-ssh-key" placeholder="~/.ssh/id_ed25519"><button type="button" class="pf-browse">Browse&hellip;</button></div>`;
  } else if (method === "token") {
    field.innerHTML = `<input class="pf-repo-token" type="password" placeholder="personal access token">`;
  } else {
    field.innerHTML = "";
  }
}

function repoCredential(block) {
  const method = block.querySelector(".pf-repo-auth-method").value;
  if (method === "ssh_key") {
    const keyPath = block.querySelector(".pf-repo-ssh-key")?.value.trim();
    return keyPath ? { method: "ssh_key", keyPath } : undefined;
  }
  if (method === "token") {
    const token = block.querySelector(".pf-repo-token")?.value.trim();
    return token ? { method: "token", token } : undefined;
  }
  return undefined;
}

async function checkRepoRow(block) {
  const input = block.querySelector(".pf-repo-input");
  const status = block.querySelector(".pf-repo-status");
  const url = input.value.trim();
  if (!url) { status.textContent = ""; status.className = "pf-repo-status"; return; }
  status.textContent = "checking…";
  status.className = "pf-repo-status checking";
  try {
    const result = await api.checkRepo(url, repoCredential(block));
    status.textContent = result.ok ? "connected" : result.error;
    status.className = `pf-repo-status ${result.ok ? "ok" : "err"}`;
    if (!result.ok) status.title = result.error;
  } catch {
    status.textContent = "check failed";
    status.className = "pf-repo-status err";
  }
}

function bindModal(refreshAll) {
  const modal = document.getElementById("project-modal");
  const folderCount = document.getElementById("pf-folder-count");
  const folderInputs = document.getElementById("pf-folder-inputs");
  const monorepo = document.getElementById("pf-monorepo");
  const repoCount = document.getElementById("pf-repo-count");
  const repoCountRow = document.getElementById("pf-repo-count-row");
  const repoInputs = document.getElementById("pf-repo-inputs");

  const renderFolderInputs = () => {
    const n = Math.max(0, Number(folderCount.value) || 0);
    folderInputs.innerHTML = "";
    for (let i = 0; i < n; i++) folderInputs.appendChild(folderRow(`/path/to/folder ${i + 1}`));
  };
  folderCount.addEventListener("input", renderFolderInputs);

  const renderRepoInputs = () => {
    repoCountRow.classList.toggle("hidden", monorepo.checked);
    repoInputs.innerHTML = "";
    if (monorepo.checked) {
      repoInputs.appendChild(repoRow("git@github.com:you/app.git (blank for local-only)"));
      return;
    }
    const n = Math.max(1, Number(repoCount.value) || 1);
    for (let i = 0; i < n; i++) repoInputs.appendChild(repoRow(`Repo ${i + 1} — git@github.com:you/repo-${i + 1}.git`));
  };
  monorepo.addEventListener("change", renderRepoInputs);
  repoCount.addEventListener("input", renderRepoInputs);
  repoInputs.addEventListener("focusout", (e) => {
    if (e.target.matches(".pf-repo-input, .pf-repo-token, .pf-repo-ssh-key")) {
      checkRepoRow(e.target.closest(".pf-repo-block"));
    }
  });
  repoInputs.addEventListener("change", (e) => {
    if (e.target.classList.contains("pf-repo-auth-method")) {
      const block = e.target.closest(".pf-repo-block");
      renderRepoAuthField(block);
      checkRepoRow(block);
    }
  });

  bindFsPicker();

  document.getElementById("new-project-btn").addEventListener("click", () => {
    modal.classList.remove("hidden");
    renderFolderInputs();
    renderRepoInputs();
  });
  document.getElementById("pf-cancel").addEventListener("click", () => {
    modal.classList.add("hidden");
  });

  document.getElementById("project-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = (id) => document.getElementById(id).value.trim();

    const code_repos = [];
    const credentials = {};
    for (const block of document.querySelectorAll(".pf-repo-block")) {
      const url = block.querySelector(".pf-repo-input").value.trim();
      if (!url) continue;
      code_repos.push(url);
      const cred = repoCredential(block);
      if (cred) credentials[url] = cred;
    }

    const payload = {
      name: val("pf-name"),
      memory_dir: val("pf-memory-dir") || undefined,
      memory_repo: val("pf-memory-repo") || undefined,
      monorepo: monorepo.checked,
      workspace_dirs: [...document.querySelectorAll(".pf-folder-path")]
        .map((el) => el.value.trim()).filter(Boolean),
      code_repos,
      credentials,
    };
    try {
      const result = await api.createProject(payload);
      modal.classList.add("hidden");
      e.target.reset();
      await refreshAll();
      const failed = (result.clone_results || []).filter((r) => !r.ok);
      if (failed.length) {
        window.alert(
          `Project created, but ${failed.length} repo clone(s) failed:\n` +
          failed.map((f) => `${f.url}\n  ${f.error}`).join("\n"),
        );
      }
    } catch (err) {
      window.alert(`Could not create project: ${err.message}`);
    }
  });
}

export function bindTopbar(refreshAll) {
  bindModal(refreshAll);
  document.getElementById("mode-select").addEventListener("change", (e) => {
    state.mode = e.target.value;
  });
  document.getElementById("yolo-toggle").addEventListener("change", (e) => {
    state.yolo = e.target.checked;
  });
}
