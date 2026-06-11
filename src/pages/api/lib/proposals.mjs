// lib/proposals.mjs
// Pure helpers for the proposal queue: envelope construction + validation and
// the filename codec. Proposals live as one JSON file each on the `proposals`
// git branch under data/proposals/{pending,resolved}/; queue metadata is
// encoded in the filename so listing the queue is a single Contents-API call:
//
//   {createdAtCompact}__{source}__{kind}__{id}.json
//   e.g. 20260610T120301Z__public__price.update__p_20260610_ab12cd.json
//
// Dependency-free (same convention as primitives.mjs) — shared by the API
// routes and the GitHub Actions scripts.

export const PENDING_DIR = "data/proposals/pending";
export const RESOLVED_DIR = "data/proposals/resolved";

export const PROPOSAL_SOURCES = ["scrape", "ai", "public", "probe", "admin"];

export const PROPOSAL_KINDS = [
  "override.set", // apply.payload = { resource, action, payload } (overrides-mutate)
  "route.add", // canonical curated route (data/canonical/routes/{key}.json)
  "route.update",
  "route.remove",
  "price.update", // data/canonical/prices.json entry
  "source.update", // data/sources/registry.json entry
  "seen.approve", // approve a gated route/station in data/canonical/state/seen.json
  "note", // no machine apply — admin acts manually, then resolves
];

export const MAX_PROPOSAL_BYTES = 16 * 1024;
export const MAX_EVIDENCE_EXCERPT = 2048;

const invalid = (message) => {
  const err = new Error(message);
  err.code = "INVALID_PROPOSAL";
  return err;
};

export function generateProposalId(now = new Date()) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `p_${day}_${rand}`;
}

function compactTimestamp(iso) {
  // 2026-06-10T12:03:01.000Z → 20260610T120301Z
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function expandTimestamp(compact) {
  // 20260610T120301Z → 2026-06-10T12:03:01.000Z
  const m = compact.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
}

export function encodeProposalFilename({ createdAt, source, kind, id }) {
  for (const [label, value] of [["source", source], ["kind", kind], ["id", id]]) {
    if (typeof value !== "string" || !/^[\w.-]+$/.test(value) || value.includes("__")) {
      throw invalid(`unencodable proposal ${label}: ${JSON.stringify(value)}`);
    }
  }
  return `${compactTimestamp(createdAt)}__${source}__${kind}__${id}.json`;
}

export function parseProposalFilename(name) {
  const m = name.match(/^(\d{8}T\d{6}Z)__([\w.-]+)__([\w.-]+)__([\w.-]+)\.json$/);
  if (!m) return null;
  const createdAt = expandTimestamp(m[1]);
  if (!createdAt) return null;
  return { createdAt, source: m[2], kind: m[3], id: m[4] };
}

// Build a full envelope from partial input, applying defaults.
export function buildProposal({
  id = generateProposalId(),
  createdAt = new Date().toISOString(),
  source,
  sourceDetail = null,
  kind,
  title,
  summary = "",
  target = {},
  before = null,
  after = null,
  apply = null,
  evidence = null,
  submitter = null,
}) {
  const proposal = {
    v: 1,
    id,
    createdAt,
    source,
    sourceDetail,
    kind,
    title,
    summary,
    target: {
      routeKey: target.routeKey ?? null,
      agencyId: target.agencyId ?? null,
      resource: target.resource ?? null,
      stationName: target.stationName ?? null,
    },
    before,
    after,
    apply,
    evidence: evidence
      ? {
          urls: Array.isArray(evidence.urls) ? evidence.urls.slice(0, 10) : [],
          excerpt: (evidence.excerpt ?? "").toString().slice(0, MAX_EVIDENCE_EXCERPT),
          fetchedAt: evidence.fetchedAt ?? null,
        }
      : null,
    submitter: submitter
      ? {
          ipHash: submitter.ipHash ?? null,
          email: submitter.email ?? null,
          userAgent: (submitter.userAgent ?? "").toString().slice(0, 200) || null,
        }
      : null,
    status: "pending",
    resolution: null,
  };
  const problems = validateProposal(proposal);
  if (problems.length) throw invalid(problems.join("; "));
  return proposal;
}

// Returns an array of human-readable problems (empty = valid).
export function validateProposal(p) {
  const problems = [];
  if (p?.v !== 1) problems.push("v must be 1");
  if (!p?.id || !/^[\w.-]+$/.test(p.id)) problems.push("invalid id");
  if (!PROPOSAL_SOURCES.includes(p?.source)) problems.push(`unknown source "${p?.source}"`);
  if (!PROPOSAL_KINDS.includes(p?.kind)) problems.push(`unknown kind "${p?.kind}"`);
  if (!p?.title || typeof p.title !== "string" || p.title.length > 300) {
    problems.push("title required (≤300 chars)");
  }
  if (typeof p?.summary !== "string" || p.summary.length > 2000) {
    problems.push("summary must be a string ≤2000 chars");
  }
  if (!p?.createdAt || Number.isNaN(Date.parse(p.createdAt))) {
    problems.push("createdAt must be an ISO timestamp");
  }
  if (p?.kind !== "note" && p?.apply != null && typeof p.apply?.type !== "string") {
    problems.push("apply.type required when apply is set");
  }
  if (p?.evidence?.excerpt && p.evidence.excerpt.length > MAX_EVIDENCE_EXCERPT) {
    problems.push(`evidence.excerpt exceeds ${MAX_EVIDENCE_EXCERPT} chars`);
  }
  try {
    if (JSON.stringify(p).length > MAX_PROPOSAL_BYTES) {
      problems.push(`proposal exceeds ${MAX_PROPOSAL_BYTES} bytes`);
    }
  } catch {
    problems.push("proposal is not serialisable");
  }
  return problems;
}
