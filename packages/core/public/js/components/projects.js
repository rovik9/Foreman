import { api } from "../api.js";
import { state, setActiveProject } from "../state.js";
import { renderRuns } from "./runs.js";

const esc = (s) => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; };

export async function renderProjects() {
  state.projects = await api.listProjects();
  const el = document.getElementById("projects-list");
  el.innerHTML =
    `<div class="project-card ${state.activeProject === null ? "active" : ""}" data-slug="">
       <span class="project-name">All projects</span>
     </div>` +
    state.projects.map((p) => `
      <div class="project-card ${p.slug === state.activeProject ? "active" : ""}" data-slug="${esc(p.slug)}">
        <span class="project-name">${esc(p.name)}</span>
        <button class="project-remove" data-slug="${esc(p.slug)}" title="Remove project">×</button>
      </div>`).join("");

  for (const card of el.querySelectorAll(".project-card")) {
    card.addEventListener("click", async (e) => {
      if (e.target.classList.contains("project-remove")) return;
      setActiveProject(card.dataset.slug || null);
      await renderProjects();
      await renderRuns();
    });
  }
  for (const btn of el.querySelectorAll(".project-remove")) {
    btn.addEventListener("click", async () => {
      if (!window.confirm(`Remove project "${btn.dataset.slug}"? (memory repo stays on disk)`)) return;
      await api.deleteProject(btn.dataset.slug);
      if (state.activeProject === btn.dataset.slug) setActiveProject(null);
      await renderProjects();
      await renderRuns();
    });
  }
}

// ---- new-project modal ----

function addRow(listId, placeholder) {
  const row = document.createElement("input");
  row.className = "pf-dyn";
  row.placeholder = placeholder;
  document.getElementById(listId).appendChild(row);
}

export function bindProjects() {
  const modal = document.getElementById("project-modal");
  document.getElementById("new-project-btn").addEventListener("click", () => {
    document.getElementById("pf-workspace-list").innerHTML = "";
    document.getElementById("pf-repo-list").innerHTML = "";
    addRow("pf-workspace-list", "~/code/rovik-capital");
    addRow("pf-repo-list", "git@github.com:rovik/rovik-capital.git");
    modal.showModal();
  });
  document.getElementById("pf-add-workspace").addEventListener("click", () =>
    addRow("pf-workspace-list", "~/code/another-folder"));
  document.getElementById("pf-add-repo").addEventListener("click", () =>
    addRow("pf-repo-list", "git@github.com:rovik/another-repo.git"));
  document.getElementById("pf-cancel").addEventListener("click", () => modal.close());

  document.getElementById("project-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = (id) => document.getElementById(id).value.trim();
    const dyn = (listId) =>
      [...document.getElementById(listId).querySelectorAll(".pf-dyn")]
        .map((i) => i.value.trim())
        .filter(Boolean);
    try {
      await api.createProject({
        name: val("pf-name"),
        memory_dir: val("pf-memory-dir") || undefined,
        memory_repo: val("pf-memory-repo") || undefined,
        workspace_dirs: dyn("pf-workspace-list"),
        code_repos: dyn("pf-repo-list"),
      });
      modal.close();
      await renderProjects();
    } catch (err) {
      window.alert(`Could not create project: ${err.message}`);
    }
  });

  document.getElementById("sidebar-toggle").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("collapsed");
  });
}
