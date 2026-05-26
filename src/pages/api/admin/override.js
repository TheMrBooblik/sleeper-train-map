// pages/api/admin/override.js
// Admin write path for the data/overrides/*.json store. Reads the current
// override file from GitHub, applies one mutation (see overrides-mutate.mjs),
// and commits the result via the GitHub contents API. The commit triggers a
// redeploy, which makes the corrected data live — git is the audit log.
//
// Configuration (env):
//   ADMIN_SESSION_SECRET required — HMAC key for the admin_session cookie
//                        (shared with the /login flow and middleware)
//   ADMIN_GITHUB_TOKEN   required — token with contents:write on the repo
//                        (falls back to GITHUB_TOKEN)
//   ADMIN_REPO           "owner/repo"  (falls back to GITHUB_REPOSITORY)
//   ADMIN_COMMIT_BRANCH  branch to commit to (default "main")
//
// Auth model: the /data page login (middleware) gates the UI; this endpoint is
// an /api route, which the middleware matcher does not cover, so it verifies
// the same admin_session cookie itself before doing anything.

import { OVERRIDE_FILES, applyOverrideMutation } from "../lib/overrides-mutate.mjs";
import { SESSION_COOKIE, verifySessionToken } from "../../../lib/adminAuth";

const GH_API = "https://api.github.com";

const repoSlug = () =>
  process.env.ADMIN_REPO || process.env.GITHUB_REPOSITORY || "";
const commitBranch = () => process.env.ADMIN_COMMIT_BRANCH || "main";
const githubToken = () =>
  process.env.ADMIN_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";

function ghHeaders() {
  return {
    Authorization: `Bearer ${githubToken()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "sleeper-train-map-admin",
  };
}

function isAuthorized(req) {
  return verifySessionToken(req.cookies?.[SESSION_COOKIE]);
}

function contentsUrlFor(slug, filePath) {
  return `${GH_API}/repos/${slug}/contents/${filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

// Read a JSON override file from the commit branch. Returns { json, sha } or
// { error } (404 → file missing, treated as empty by the caller).
async function readOverrideFile(slug, branch, filePath) {
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

// GET: return current content of every override file (also validates the
// secret, so the UI uses it as a login + initial-load step). A missing file
// (404) is reported as null; any other read failure is surfaced in `errors`
// so the UI never silently presents real data as empty.
async function handleGet(res, slug, branch) {
  const overrides = {};
  const errors = {};
  await Promise.all(
    Object.entries(OVERRIDE_FILES).map(async ([resource, filePath]) => {
      const result = await readOverrideFile(slug, branch, filePath);
      if (result.error) errors[resource] = result.error;
      overrides[resource] = result.error ? null : result.json;
    }),
  );
  return res.status(200).json({
    repo: slug,
    branch,
    overrides,
    ...(Object.keys(errors).length ? { errors } : {}),
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!githubToken() || !repoSlug()) {
    return res.status(503).json({
      error:
        "GitHub write access not configured (set ADMIN_GITHUB_TOKEN and ADMIN_REPO)",
    });
  }

  const slug = repoSlug();
  const branch = commitBranch();

  if (req.method === "GET") {
    return handleGet(res, slug, branch);
  }

  const { resource, action, payload, message } = req.body || {};
  const filePath = OVERRIDE_FILES[resource];
  if (!filePath) {
    return res.status(400).json({ error: `Unknown resource: ${resource}` });
  }

  const contentsUrl = contentsUrlFor(slug, filePath);

  try {
    // Read current file (need its sha to update).
    const existing = await readOverrideFile(slug, branch, filePath);
    if (existing.error) {
      return res.status(502).json({ error: `Failed to ${existing.error}` });
    }
    const current = existing.json;
    const fileSha = existing.sha;

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
        ...(fileSha ? { sha: fileSha } : {}),
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
