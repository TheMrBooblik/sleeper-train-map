// pages/api/admin/proposals/[id].js
// GET  → full proposal envelope (find by ?filename= fast path, else dir scan).
// POST → decide: { decision: "approve"|"reject", note?, editedApply? }.
//   Approve plans the apply (proposals-apply.mjs), commits each target file to
//   the live branch (main), then moves the proposal file to resolved/ on the
//   proposals branch. Reject just moves the file. Sequential GitHub calls stay
//   ≤5 so the handler fits Vercel Hobby's 10s budget.

import { rejectUnlessLocalAdmin } from "../../../../lib/localAdmin.mjs";
import {
  commitBranch,
  deleteFile,
  isGithubWriteConfigured,
  listDir,
  proposalsBranch,
  putJsonFile,
  readJsonFile,
  repoSlug,
} from "../../lib/github-content.mjs";
import {
  PENDING_DIR,
  RESOLVED_DIR,
  parseProposalFilename,
  validateProposal,
} from "../../lib/proposals.mjs";
import { planProposalApply } from "../../lib/proposals-apply.mjs";

async function locateProposal(slug, branch, id, filenameHint) {
  if (filenameHint && parseProposalFilename(filenameHint)?.id === id) {
    return `${PENDING_DIR}/${filenameHint}`;
  }
  const listing = await listDir(slug, branch, PENDING_DIR);
  if (listing.error) return { error: listing.error };
  const entry = listing.entries.find((e) => parseProposalFilename(e.name)?.id === id);
  return entry ? entry.path : null;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (rejectUnlessLocalAdmin(req, res)) return;
  if (!isGithubWriteConfigured()) {
    return res.status(503).json({
      error: "GitHub access not configured (set ADMIN_GITHUB_TOKEN and ADMIN_REPO)",
    });
  }

  const slug = repoSlug();
  const branch = proposalsBranch();
  const id = (req.query.id || "").toString();
  const filenameHint = (req.query.filename || req.body?.filename || "").toString();

  const located = await locateProposal(slug, branch, id, filenameHint);
  if (located?.error) {
    return res.status(502).json({ error: `Failed to ${located.error}` });
  }
  if (!located) {
    return res.status(404).json({ error: `Proposal ${id} not found in pending queue` });
  }
  const pendingPath = located;
  const filename = pendingPath.split("/").pop();

  const file = await readJsonFile(slug, branch, pendingPath);
  if (file.error) return res.status(502).json({ error: `Failed to ${file.error}` });
  if (!file.json) return res.status(404).json({ error: `Proposal ${id} not found` });
  const proposal = file.json;

  if (req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ proposal, filename, sha: file.sha });
  }

  const { decision, note, editedApply } = req.body || {};
  if (decision !== "approve" && decision !== "reject") {
    return res.status(400).json({ error: 'decision must be "approve" or "reject"' });
  }

  try {
    let applyCommit = null;

    if (decision === "approve") {
      const apply = editedApply ?? proposal.apply;
      const steps = planProposalApply(apply);

      for (const step of steps) {
        const target = await readJsonFile(slug, commitBranch(), step.path);
        if (target.error) {
          return res.status(502).json({ error: `Failed to ${target.error}` });
        }
        const nextJson = step.mutate(target.json);
        const message = `data(proposal): ${proposal.kind} ${proposal.id}\n\n${proposal.title}`;
        const put = await putJsonFile(
          slug,
          commitBranch(),
          step.path,
          nextJson,
          message,
          target.sha,
        );
        if (put.error) {
          const status = put.status === 409 ? 409 : 502;
          return res.status(status).json({
            error: status === 409 ? "conflict" : `Failed to ${put.error}`,
            detail: put.detail,
          });
        }
        applyCommit = put.commit;
      }
    }

    // Move the proposal to resolved/ with the decision recorded.
    const resolved = {
      ...proposal,
      status: decision === "approve" ? "approved" : "rejected",
      resolution: {
        decision: decision === "approve" ? "approved" : "rejected",
        decidedAt: new Date().toISOString(),
        commit: applyCommit,
        note: (note ?? "").toString().slice(0, 500) || null,
        editedApply: editedApply ?? null,
      },
    };
    const problems = validateProposal({ ...resolved, status: "pending" });
    if (problems.length) {
      console.warn(`[proposals] resolved envelope problems: ${problems.join("; ")}`);
    }

    const create = await putJsonFile(
      slug,
      branch,
      `${RESOLVED_DIR}/${filename}`,
      resolved,
      `chore(proposals): ${decision} ${proposal.id}`,
    );
    if (create.error) {
      return res.status(502).json({ error: `Failed to ${create.error}` });
    }
    const remove = await deleteFile(
      slug,
      branch,
      pendingPath,
      `chore(proposals): close ${proposal.id}`,
      file.sha,
    );
    if (remove.error) {
      // Non-fatal: a stray pending copy is healed by the nightly prune.
      console.warn(`[proposals] failed to ${remove.error}`);
    }

    return res.status(200).json({
      ok: true,
      decision,
      applyCommit,
      proposal: `${RESOLVED_DIR}/${filename}`,
    });
  } catch (err) {
    if (err?.code === "INVALID_PROPOSAL" || err?.code === "INVALID_OVERRIDE") {
      return res.status(400).json({ error: err.message });
    }
    console.error("[admin/proposals] error:", err);
    return res.status(500).json({ error: "Proposal decision failed" });
  }
}
