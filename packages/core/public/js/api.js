/** REST client — the UI never fetches anywhere else. */

async function req(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  listRuns: () => req("/runs"),
  getRun: (id) => req(`/runs/${id}`),
  createRun: (prompt, project) =>
    req("/runs", { method: "POST", body: JSON.stringify({ prompt, project }) }),
  chat: (runId, message) =>
    req(`/runs/${runId}/chat`, { method: "POST", body: JSON.stringify({ message }) }),
  acceptRun: (runId) => req(`/runs/${runId}/accept`, { method: "POST" }),
  listProjects: () => req("/projects"),
  createProject: (payload) =>
    req("/projects", { method: "POST", body: JSON.stringify(payload) }),
  deleteProject: (slug) =>
    fetch(`/projects/${slug}`, { method: "DELETE" }).then((r) => {
      if (!r.ok) throw new Error(`${r.status}`);
    }),
  listMemories: () => req("/memories"),
  decideMemory: (id, decision) =>
    req(`/memories/${id}/decision`, { method: "POST", body: JSON.stringify({ decision }) }),
  fileUrl: (runId, path) => `/runs/${runId}/files/${path}`,
};
