// lib/github-content.mjs
// Thin GitHub Contents-API helpers shared by the admin override endpoint, the
// proposal queue endpoints and the public suggest endpoint. Git is the
// database: every write is a commit. Extracted from admin/override.js.
//
// Configuration (env):
//   ADMIN_GITHUB_TOKEN   token with contents:write (falls back to GITHUB_TOKEN)
//   ADMIN_REPO           "owner/repo" (falls back to GITHUB_REPOSITORY)
//   ADMIN_COMMIT_BRANCH  branch for live-data commits (default "main")
//   PROPOSALS_BRANCH     branch holding the proposal queue (default "proposals")

const GH_API = "https://api.github.com";

export const repoSlug = () =>
  process.env.ADMIN_REPO || process.env.GITHUB_REPOSITORY || "";
export const commitBranch = () => process.env.ADMIN_COMMIT_BRANCH || "main";
export const proposalsBranch = () => process.env.PROPOSALS_BRANCH || "proposals";
export const githubToken = () =>
  process.env.ADMIN_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";

export function isGithubWriteConfigured() {
  return Boolean(githubToken() && repoSlug());
}

export function ghHeaders() {
  return {
    Authorization: `Bearer ${githubToken()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "sleeper-train-map-admin",
  };
}

export function contentsUrlFor(slug, filePath) {
  return `${GH_API}/repos/${slug}/contents/${filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

// Read a JSON file from a branch. Returns { json, sha } — both null when the
// file doesn't exist (404) — or { error } for any other failure.
export async function readJsonFile(slug, branch, filePath) {
  const res = await fetch(
    `${contentsUrlFor(slug, filePath)}?ref=${encodeURIComponent(branch)}`,
    { headers: ghHeaders() },
  );
  if (res.status === 404) return { json: null, sha: null };
  if (!res.ok) return { error: `read ${filePath} (${res.status})` };
  const file = await res.json();
  try {
    return {
      json: JSON.parse(Buffer.from(file.content, "base64").toString("utf8")),
      sha: file.sha,
    };
  } catch {
    return { error: `${filePath} is not valid JSON` };
  }
}

// List a directory on a branch. Returns { entries: [{ name, path, sha }] };
// a missing directory is an empty list. GitHub caps dir listings at 1000
// entries — `truncated` reports that.
export async function listDir(slug, branch, dirPath) {
  const res = await fetch(
    `${contentsUrlFor(slug, dirPath)}?ref=${encodeURIComponent(branch)}`,
    { headers: ghHeaders() },
  );
  if (res.status === 404) return { entries: [], truncated: false };
  if (!res.ok) return { error: `list ${dirPath} (${res.status})` };
  const items = await res.json();
  if (!Array.isArray(items)) return { error: `${dirPath} is not a directory` };
  return {
    entries: items
      .filter((it) => it.type === "file")
      .map((it) => ({ name: it.name, path: it.path, sha: it.sha })),
    truncated: items.length >= 1000,
  };
}

async function putOnce(slug, branch, filePath, content, message, sha) {
  const res = await fetch(contentsUrlFor(slug, filePath), {
    method: "PUT",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      ...(sha ? { sha } : {}),
      branch,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    return { error: `commit ${filePath} (${res.status})`, status: res.status, detail };
  }
  const result = await res.json();
  return {
    ok: true,
    commit: result.commit?.html_url || result.commit?.sha || null,
    contentSha: result.content?.sha || null,
  };
}

// Create or update a JSON file with one commit. On a sha conflict (409 — the
// file changed under us) the current sha is re-read and the PUT retried once.
export async function putJsonFile(slug, branch, filePath, json, message, sha = null) {
  const content = `${JSON.stringify(json, null, 2)}\n`;
  let result = await putOnce(slug, branch, filePath, content, message, sha);
  if (result.error && (result.status === 409 || result.status === 422)) {
    const fresh = await readJsonFile(slug, branch, filePath);
    if (!fresh.error) {
      result = await putOnce(slug, branch, filePath, content, message, fresh.sha);
    }
  }
  return result;
}

// Delete a file (needs its current sha).
export async function deleteFile(slug, branch, filePath, message, sha) {
  const res = await fetch(contentsUrlFor(slug, filePath), {
    method: "DELETE",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ message, sha, branch }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    return { error: `delete ${filePath} (${res.status})`, status: res.status, detail };
  }
  return { ok: true };
}

// Create `branch` from the HEAD of `fromBranch` when it doesn't exist yet.
export async function ensureBranch(slug, branch, fromBranch = "main") {
  const refRes = await fetch(
    `${GH_API}/repos/${slug}/git/ref/${encodeURIComponent(`heads/${branch}`)}`,
    { headers: ghHeaders() },
  );
  if (refRes.ok) return { ok: true, created: false };
  if (refRes.status !== 404) return { error: `read ref ${branch} (${refRes.status})` };

  const baseRes = await fetch(
    `${GH_API}/repos/${slug}/git/ref/${encodeURIComponent(`heads/${fromBranch}`)}`,
    { headers: ghHeaders() },
  );
  if (!baseRes.ok) return { error: `read base ref ${fromBranch} (${baseRes.status})` };
  const base = await baseRes.json();

  const createRes = await fetch(`${GH_API}/repos/${slug}/git/refs`, {
    method: "POST",
    headers: { ...ghHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object?.sha }),
  });
  if (!createRes.ok && createRes.status !== 422) {
    // 422 = already exists (raced another writer) — that's fine.
    return { error: `create branch ${branch} (${createRes.status})` };
  }
  return { ok: true, created: createRes.ok };
}
