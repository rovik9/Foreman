import { syncProductRepo } from "../journal/gitsync.js";

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!slug) throw new Error(`cannot derive a slug from "${name}"`);
  return slug;
}

/** Creates a private GitHub repo for a project's memory. Optional path —
 *  used only when GITHUB_TOKEN is set and the user didn't paste a repo URL. */
export async function githubCreateRepo(
  token: string,
  name: string,
): Promise<string> {
  const res = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "foreman",
    },
    body: JSON.stringify({ name, private: true, auto_init: false }),
  });
  const body = (await res.json()) as {
    ssh_url?: string;
    message?: string;
  };
  if (!res.ok || !body.ssh_url) {
    throw new Error(`github create repo: ${body.message ?? res.status}`);
  }
  return body.ssh_url;
}

/**
 * Scaffolds a project's local memory repo and returns its directory.
 * Local-first: the repo exists and commits even if no remote is configured.
 */
export function scaffoldProjectRepo(memoryDir: string, slug: string): string {
  const repoDir = `${memoryDir}/products/${slug}`;
  syncProductRepo(repoDir, "project created", undefined);
  return repoDir;
}
