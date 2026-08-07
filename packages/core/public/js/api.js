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
  deleteRun: (id) => req(`/runs/${id}`, { method: "DELETE" }),
  createRun: (prompt, project, mode, yolo) =>
    req("/runs", { method: "POST", body: JSON.stringify({ prompt, project, mode, yolo }) }),
  chat: (runId, message) =>
    req(`/runs/${runId}/chat`, { method: "POST", body: JSON.stringify({ message }) }),
  stopRun: (runId) => req(`/runs/${runId}/stop`, { method: "POST" }),
  approveRun: (runId) => req(`/runs/${runId}/approve`, { method: "POST" }),
  topUpBudget: (runId, add_usd) =>
    req(`/runs/${runId}/budget`, { method: "POST", body: JSON.stringify({ add_usd }) }),
  acceptRun: (runId) => req(`/runs/${runId}/accept`, { method: "POST" }),
  listProjects: () => req("/projects"),
  createProject: (payload) =>
    req("/projects", { method: "POST", body: JSON.stringify(payload) }),
  deleteProject: (slug) => req(`/projects/${slug}`, { method: "DELETE" }),
  listMemories: () => req("/memories"),
  decideMemory: (id, decision) =>
    req(`/memories/${id}/decision`, { method: "POST", body: JSON.stringify({ decision }) }),
  fileUrl: (runId, path) => `/runs/${runId}/files/${path}`,
  listDir: (path) => req(`/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  checkRepo: (url, credential) =>
    req("/fs/check-repo", { method: "POST", body: JSON.stringify({ url, credential }) }),
  listApiKeys: () => req("/settings/api-keys"),
  saveApiKey: (name, value) =>
    req("/settings/api-keys", { method: "POST", body: JSON.stringify({ name, value }) }),
  deleteApiKey: (name) => req(`/settings/api-keys/${encodeURIComponent(name)}`, { method: "DELETE" }),
  testApiKey: (name, value) =>
    req(`/settings/api-keys/${encodeURIComponent(name)}/test`, {
      method: "POST", body: JSON.stringify({ value }),
    }),
  testMcpServer: (id) => req(`/settings/mcp-servers/${id}/test`, { method: "POST" }),
  listProviders: () => req("/settings/providers"),
  createProvider: (payload) =>
    req("/settings/providers", { method: "POST", body: JSON.stringify(payload) }),
  deleteProvider: (id) => req(`/settings/providers/${id}`, { method: "DELETE" }),
  testProvider: (id) => req(`/settings/providers/${id}/test`, { method: "POST" }),
  spend: (project) => req(`/spend${project ? `?project=${encodeURIComponent(project)}` : ""}`),
  listMcpServers: () => req("/settings/mcp-servers"),
  createMcpServer: (payload) =>
    req("/settings/mcp-servers", { method: "POST", body: JSON.stringify(payload) }),
  setMcpServerEnabled: (id, enabled) =>
    req(`/settings/mcp-servers/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  deleteMcpServer: (id) => req(`/settings/mcp-servers/${id}`, { method: "DELETE" }),
};
