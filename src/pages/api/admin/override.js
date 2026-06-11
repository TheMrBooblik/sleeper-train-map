// pages/api/admin/override.js
// Admin write path for the data/overrides/*.json store. Reads the current
// override file from GitHub, applies one mutation (see overrides-mutate.mjs),
// and commits the result via the GitHub contents API. The commit triggers a
// redeploy, which makes the corrected data live — git is the audit log.
//
// GitHub access + branch configuration lives in lib/github-content.mjs
// (ADMIN_GITHUB_TOKEN / ADMIN_REPO / ADMIN_COMMIT_BRANCH).
//
// Auth model: the /data page login (middleware) gates the UI; this endpoint is
// an /api route, which the middleware matcher does not cover, so it verifies
// the same admin_session cookie itself before doing anything.

import { OVERRIDE_FILES, applyOverrideMutation } from "../lib/overrides-mutate.mjs";
import { validateRegistry } from "../../../../scripts/lib/registry.mjs";
import { SESSION_COOKIE, verifySessionToken } from "../../../lib/adminAuth";
import {
  commitBranch,
  isGithubWriteConfigured,
  putJsonFile,
  readJsonFile,
  repoSlug,
} from "../lib/github-content.mjs";

function isAuthorized(req) {
  return verifySessionToken(req.cookies?.[SESSION_COOKIE]);
}

// Read-only approval index, surfaced alongside the override files so the
// Routes tab can label disabled routes (which no longer appear in
// /api/initial-data) from their stored fingerprints. Not in OVERRIDE_FILES, so
// it is never mutated by the POST path.
const SEEN_PATH = "data/canonical/state/seen.json";

// GET: return current content of every override file (also validates the
// secret, so the UI uses it as a login + initial-load step). A missing file
// (404) is reported as null; any other read failure is surfaced in `errors`
// so the UI never silently presents real data as empty.
async function handleGet(res, slug, branch) {
  const overrides = {};
  const errors = {};
  await Promise.all(
    Object.entries(OVERRIDE_FILES).map(async ([resource, filePath]) => {
      const result = await readJsonFile(slug, branch, filePath);
      if (result.error) errors[resource] = result.error;
      overrides[resource] = result.error ? null : result.json;
    }),
  );

  const seen = await readJsonFile(slug, branch, SEEN_PATH);
  if (seen.error) errors["seen-state"] = seen.error;

  return res.status(200).json({
    repo: slug,
    branch,
    overrides,
    seenState: seen.error ? null : seen.json,
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
  if (!isGithubWriteConfigured()) {
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

  try {
    // Read current file (need its sha to update).
    const existing = await readJsonFile(slug, branch, filePath);
    if (existing.error) {
      return res.status(502).json({ error: `Failed to ${existing.error}` });
    }

    // Apply the mutation (pure; validates input).
    const updated = applyOverrideMutation(resource, action, payload, existing.json);

    // A broken registry would take down the nightly scrape — re-validate the
    // whole document before committing, not just the mutated entry.
    if (resource === "source-registry") {
      const problems = validateRegistry(updated);
      if (problems.length) {
        return res
          .status(400)
          .json({ error: `Invalid registry: ${problems.join("; ")}` });
      }
    }

    // Commit the result.
    const put = await putJsonFile(
      slug,
      branch,
      filePath,
      updated,
      message || `chore(override): ${resource} ${action}`,
      existing.sha,
    );
    if (put.error) {
      return res
        .status(502)
        .json({ error: `Failed to ${put.error}`, detail: put.detail });
    }
    return res.status(200).json({
      ok: true,
      resource,
      action,
      path: filePath,
      commit: put.commit,
    });
  } catch (err) {
    if (err?.code === "INVALID_OVERRIDE") {
      return res.status(400).json({ error: err.message });
    }
    console.error("[admin/override] error:", err);
    return res.status(500).json({ error: "Override failed" });
  }
}
