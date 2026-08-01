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

function bindModal(refreshAll) {
  const modal = document.getElementById("project-modal");
  const folderCount = document.getElementById("pf-folder-count");
  const folderInputs = document.getElementById("pf-folder-inputs");

  const renderFolderInputs = () => {
    const n = Math.max(0, Number(folderCount.value) || 0);
    folderInputs.innerHTML = Array.from({ length: n }, (_, i) =>
      `<input class="pf-folder-path" placeholder="/path/to/folder ${i + 1}">`,
    ).join("");
  };
  folderCount.addEventListener("input", renderFolderInputs);

  document.getElementById("new-project-btn").addEventListener("click", () => {
    modal.classList.remove("hidden");
    renderFolderInputs();
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
      monorepo: document.getElementById("pf-monorepo").checked,
      workspace_dirs: [...document.querySelectorAll(".pf-folder-path")]
        .map((el) => el.value.trim()).filter(Boolean),
      code_repos: val("pf-code-repos").split(",").map((s) => s.trim()).filter(Boolean),
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
