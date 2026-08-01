import { api } from "../api.js";
import { state, setActiveProject } from "../state.js";
import { renderRuns } from "./runs.js";

export async function renderProjects() {
  state.projects = await api.listProjects();
  const sel = document.getElementById("project-switcher");
  sel.innerHTML =
    `<option value="">all projects</option>` +
    state.projects.map((p) =>
      `<option value="${p.slug}" ${p.slug === state.activeProject ? "selected" : ""}>${p.name}</option>`,
    ).join("");
}

export function bindProjects() {
  document.getElementById("project-switcher").addEventListener("change", async (e) => {
    setActiveProject(e.target.value || null);
    await renderRuns();
  });
  document.getElementById("new-project-btn").addEventListener("click", async () => {
    const name = window.prompt("Project name:");
    if (!name?.trim()) return;
    const repo = window.prompt("GitHub repo URL for its memory (blank = auto/none):");
    try {
      await api.createProject(name.trim(), repo?.trim() || undefined);
      await renderProjects();
    } catch (err) {
      window.alert(`Could not create project: ${err.message}`);
    }
  });
}
