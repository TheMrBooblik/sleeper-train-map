// pages/api/admin/override.js
// Admin write path for the data/overrides/*.json store. Reads the current
// override file from GitHub, applies one mutation (see overrides-mutate.mjs),
// and commits the result via the GitHub contents API. The commit triggers a
// redeploy, which makes the corrected data live — git is the audit log.
//
// Configuration (env):
//   ADMIN_API_SECRET    required — bearer secret callers must present
//   ADMIN_GITHUB_TOKEN  required — token with contents:write on the repo
//                       (falls back to GITHUB_TOKEN)
//   ADMIN_REPO          "owner/repo"  (falls back to GITHUB_REPOSITORY)
//   ADMIN_COMMIT_BRANCH branch to commit to (default "main")
//
// Auth model: the /data page login gates the UI; this endpoint independently
// requires the bearer secret so it can never be called unauthenticated.

import { OVERRIDE_FILES, applyOverrideMutation } from "../lib/overrides-mutate.mjs";

const GH_API = "https://api.github.com";

const repoSlug = () =>
  process.env.ADMIN_REPO || process.env.GITHUB_REPOSITORY || "";
const commitBranch = () => process.env.ADMIN_COMMIT_BRANCH || "main";
const githubToken = () =>
  process.env.ADMIN_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";
const adminSecret = () => process.env.ADMIN_API_SECRET || "";

function ghHeaders() {
  return {
    Authorization: `Bearer ${githubToken()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "sleeper-train-map-admin",
  };
}

function isAuthorized(req) {
  const secret = adminSecret();
  if (!secret) return false;
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  return bearer.length > 0 && bearer === secret;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!adminSecret()) {
    return res
      .status(503)
      .json({ error: "Admin endpoint not configured (set ADMIN_API_SECRET)" });
  }
  if (!githubToken() || !repoSlug()) {
    return res.status(503).json({
      error:
        "GitHub write access not configured (set ADMIN_GITHUB_TOKEN and ADMIN_REPO)",
    });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { resource, action, payload, message } = req.body || {};
  const filePath = OVERRIDE_FILES[resource];
  if (!filePath) {
    return res.status(400).json({ error: `Unknown resource: ${resource}` });
  }

  const slug = repoSlug();
  const branch = commitBranch();
  const contentsUrl = `${GH_API}/repos/${slug}/contents/${filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

  try {
    // Read current file (need its sha to update).
    const getRes = await fetch(
      `${contentsUrl}?ref=${encodeURIComponent(branch)}`,
      { headers: ghHeaders() },
    );
    if (!getRes.ok) {
      return res
        .status(502)
        .json({ error: `Failed to read ${filePath} (${getRes.status})` });
    }
    const file = await getRes.json();
    let current;
    try {
      current = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    } catch {
      return res.status(500).json({ error: `Current ${filePath} is not valid JSON` });
    }

    // Apply the mutation (pure; validates input).
    const updated = applyOverrideMutation(resource, action, payload, current);
    const newContent = `${JSON.stringify(updated, null, 2)}\n`;

    // Commit the result.
    const putRes = await fetch(contentsUrl, {
      method: "PUT",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: message || `chore(override): ${resource} ${action}`,
        content: Buffer.from(newContent, "utf8").toString("base64"),
        sha: file.sha,
        branch,
      }),
    });
    if (!putRes.ok) {
      const detail = (await putRes.text()).slice(0, 300);
      return res
        .status(502)
        .json({ error: `Failed to commit (${putRes.status})`, detail });
    }
    const result = await putRes.json();
    return res.status(200).json({
      ok: true,
      resource,
      action,
      path: filePath,
      commit: result.commit?.html_url || result.commit?.sha || null,
    });
  } catch (err) {
    if (err?.code === "INVALID_OVERRIDE") {
      return res.status(400).json({ error: err.message });
    }
    console.error("[admin/override] error:", err);
    return res.status(500).json({ error: "Override failed" });
  }
}
