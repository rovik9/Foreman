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

// ---- repo rows — live git ls-remote validation, since these are usually private ----

function repoRow(placeholder) {
  const row = document.createElement("div");
  row.className = "pf-repo-row";
  row.innerHTML = `<input class="pf-repo-input" placeholder="${esc(placeholder)}"><span class="pf-repo-status"></span>`;
  return row;
}

function folderRow(placeholder) {
  const row = document.createElement("div");
  row.className = "pf-path-row";
  row.innerHTML = `<input class="pf-folder-path" placeholder="${esc(placeholder)}"><button type="button" class="pf-browse">Browse&hellip;</button>`;
  return row;
}

async function checkRepoRow(input) {
  const status = input.closest(".pf-repo-row").querySelector(".pf-repo-status");
  const url = input.value.trim();
  if (!url) { status.textContent = ""; status.className = "pf-repo-status"; return; }
  status.textContent = "checking…";
  status.className = "pf-repo-status checking";
  try {
    const result = await api.checkRepo(url);
    status.textContent = result.ok ? "connected" : result.error;
    status.className = `pf-repo-status ${result.ok ? "ok" : "err"}`;
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
    if (e.target.classList.contains("pf-repo-input")) checkRepoRow(e.target);
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
    const payload = {
      name: val("pf-name"),
      memory_dir: val("pf-memory-dir") || undefined,
      memory_repo: val("pf-memory-repo") || undefined,
      monorepo: monorepo.checked,
      workspace_dirs: [...document.querySelectorAll(".pf-folder-path")]
        .map((el) => el.value.trim()).filter(Boolean),
      code_repos: [...document.querySelectorAll(".pf-repo-input")]
        .map((el) => el.value.trim()).filter(Boolean),
    };
    try {
      await api.createProject(payload);
      modal.classList.add("hidden");
      e.target.reset();
      await refreshAll();
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
