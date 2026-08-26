// pages/api/admin/proposals/index.js
// Lists the proposal queue (one Contents-API directory call — metadata is
// encoded in the filenames). Auth + env model identical to admin/override.js.

import { rejectUnlessLocalAdmin } from "../../../../lib/localAdmin.mjs";
import {
  isGithubWriteConfigured,
  listDir,
  proposalsBranch,
  repoSlug,
} from "../../lib/github-content.mjs";
import { PENDING_DIR, RESOLVED_DIR, parseProposalFilename } from "../../lib/proposals.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (rejectUnlessLocalAdmin(req, res)) return;
  if (!isGithubWriteConfigured()) {
    return res.status(503).json({
      error: "GitHub access not configured (set ADMIN_GITHUB_TOKEN and ADMIN_REPO)",
    });
  }

  const status = req.query.status === "resolved" ? "resolved" : "pending";
  const dir = status === "resolved" ? RESOLVED_DIR : PENDING_DIR;
  const branch = proposalsBranch();

  const listing = await listDir(repoSlug(), branch, dir);
  if (listing.error) {
    return res.status(502).json({ error: `Failed to ${listing.error}` });
  }

  const proposals = listing.entries
    .map((entry) => {
      const meta = parseProposalFilename(entry.name);
      if (!meta) return null;
      return { ...meta, filename: entry.name, sha: entry.sha };
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    branch,
    status,
    proposals,
    truncated: listing.truncated,
  });
}
