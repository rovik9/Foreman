/** Shared UI state — tiny, explicit, no framework. */

export const state = {
  activeProject: null, // slug | null (null = all projects)
  activeRun: null,     // run id | null
  projects: [],        // ProjectRow[]
};

export function setActiveProject(slug) {
  state.activeProject = slug;
  document.dispatchEvent(new CustomEvent("project:changed", { detail: slug }));
}

export function setActiveRun(runId) {
  state.activeRun = runId;
  document.body.dataset.run = runId ?? "";
  document.dispatchEvent(new CustomEvent("run:changed", { detail: runId }));
}
