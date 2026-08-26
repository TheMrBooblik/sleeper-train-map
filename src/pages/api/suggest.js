// pages/api/suggest.js
// Public suggestion endpoint — the community entry point into the review
// queue. Strictly validated; never writes live data. Creates one proposal
// file on the (non-deploying) proposals branch; the admin reviews it in /data.
//
// Abuse controls: hidden honeypot field (silent accept), per-IP token bucket
// (best effort per lambda instance), global cap on pending public proposals,
// hard size caps. SUGGEST_DRY_RUN=1 skips the GitHub write (CI/dev).

import crypto from "node:crypto";
import {
  ensureBranch,
  isGithubWriteConfigured,
  listDir,
  proposalsBranch,
  putJsonFile,
  repoSlug,
} from "./lib/github-content.mjs";
import {
  PENDING_DIR,
  buildProposal,
  encodeProposalFilename,
  parseProposalFilename,
} from "./lib/proposals.mjs";

const MAX_BODY_BYTES = 8 * 1024;
const SUGGESTION_TYPES = ["correction", "missing-train", "price", "booking"];
const RATE_LIMIT = { max: 5, windowMs: 60 * 60 * 1000 }; // 5/hour/IP
const MAX_PENDING_PUBLIC = 100;

// Best-effort per-instance rate limiting (resets on cold start — acceptable
// first line of defence; the global pending cap is the backstop).
const ipBuckets = new Map();
function rateLimited(ipHash) {
  const now = Date.now();
  const hits = (ipBuckets.get(ipHash) ?? []).filter(
    (t) => now - t < RATE_LIMIT.windowMs,
  );
  if (hits.length >= RATE_LIMIT.max) return true;
  hits.push(now);
  ipBuckets.set(ipHash, hits);
  if (ipBuckets.size > 5000) ipBuckets.clear(); // bound memory
  return false;
}

// Pending-public count, cached briefly so bursts cost one listing.
let pendingPublicCache = { count: 0, fetchedAt: 0 };
async function pendingPublicCount(slug, branch) {
  if (Date.now() - pendingPublicCache.fetchedAt < 60_000) {
    return pendingPublicCache.count;
  }
  const listing = await listDir(slug, branch, PENDING_DIR);
  const count = listing.error
    ? 0
    : listing.entries.filter((e) => parseProposalFilename(e.name)?.source === "public").length;
  pendingPublicCache = { count, fetchedAt: Date.now() };
  return count;
}

function clientIp(req) {
  const fwd = (req.headers["x-forwarded-for"] || "").toString();
  return fwd.split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
}

const str = (v, max) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

function validateBody(body) {
  if (!body || typeof body !== "object") return { error: "Invalid body" };
  if (JSON.stringify(body).length > MAX_BODY_BYTES) {
    return { error: "Suggestion too large" };
  }
  if (!SUGGESTION_TYPES.includes(body.type)) {
    return { error: `type must be one of: ${SUGGESTION_TYPES.join(", ")}` };
  }
  const message = str(body.message, 1000);
  if (!message || message.length < 10) {
    return { error: "message must be 10–1000 characters" };
  }

  const ctx = body.context ?? {};
  const context = {
    routeKey: str(ctx.routeKey, 200),
    trainName: str(ctx.trainName, 100),
    stationName: str(ctx.stationName, 200),
    agencyId: str(ctx.agencyId, 50),
    url: null,
  };
  const url = str(ctx.url, 500);
  if (url) {
    if (!/^https?:\/\//i.test(url)) return { error: "context.url must be http(s)" };
    context.url = url;
  }

  const f = body.fields ?? {};
  const fields = {};
  if (f.fromPrice != null) {
    const price = Number(f.fromPrice);
    if (!Number.isFinite(price) || price < 0 || price > 10000) {
      return { error: "fields.fromPrice out of range" };
    }
    fields.fromPrice = price;
  }
  if (f.currency != null) {
    const currency = str(f.currency, 3);
    if (!currency || !/^[A-Za-z]{3}$/.test(currency)) {
      return { error: "fields.currency must be a 3-letter code" };
    }
    fields.currency = currency.toUpperCase();
  }
  if (f.bookingUrl != null) {
    const bookingUrl = str(f.bookingUrl, 500);
    if (!bookingUrl || !/^https?:\/\//i.test(bookingUrl)) {
      return { error: "fields.bookingUrl must be http(s)" };
    }
    fields.bookingUrl = bookingUrl;
  }

  return {
    type: body.type,
    message,
    context,
    fields,
    email: str(body.email, 200),
    honeypot: typeof body.website === "string" && body.website.trim() !== "",
  };
}

// Map a validated suggestion to a proposal envelope. Price suggestions with
// enough detail get a machine-applicable price.update; everything else is a
// note the admin can escalate via Edit & Approve.
function toProposal(input, ipHash, userAgent) {
  const { type, message, context, fields, email } = input;
  const label = context.trainName || context.routeKey || context.stationName || "general";

  let kind = "note";
  let apply = null;
  if (type === "price" && context.routeKey && fields.fromPrice != null && fields.currency) {
    kind = "price.update";
    apply = {
      type: "price.update",
      payload: {
        routeKey: context.routeKey,
        price: {
          fromPrice: fields.fromPrice,
          currency: fields.currency,
          source: "public-suggestion",
          sampledAt: new Date().toISOString(),
        },
      },
    };
  }

  return buildProposal({
    source: "public",
    sourceDetail: type,
    kind,
    title: `[${type}] ${label}`,
    summary: message,
    target: {
      routeKey: context.routeKey,
      agencyId: context.agencyId,
      stationName: context.stationName,
    },
    after: Object.keys(fields).length ? fields : null,
    apply,
    evidence: context.url ? { urls: [context.url] } : null,
    submitter: { ipHash, email, userAgent },
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const input = validateBody(req.body);
  if (input.error) return res.status(400).json({ error: input.error });

  // Honeypot tripped: pretend success, write nothing.
  if (input.honeypot) return res.status(201).json({ ok: true, id: "received" });

  // Salt the IP hash so a guessed hash function is not enough to forge the
  // rate-limit key. A fixed value is fine; this is not a login secret.
  const secret = "suggest";
  const ipHash = crypto
    .createHash("sha256")
    .update(clientIp(req) + secret)
    .digest("hex")
    .slice(0, 16);

  if (rateLimited(ipHash)) {
    return res.status(429).json({ error: "Too many suggestions — try again later" });
  }

  let proposal;
  try {
    proposal = toProposal(input, ipHash, req.headers["user-agent"]);
  } catch (err) {
    if (err?.code === "INVALID_PROPOSAL") {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  if (process.env.SUGGEST_DRY_RUN === "1") {
    return res.status(201).json({ ok: true, id: proposal.id, dryRun: true });
  }
  if (!isGithubWriteConfigured()) {
    return res.status(503).json({ error: "Suggestions are temporarily unavailable" });
  }

  const slug = repoSlug();
  const branch = proposalsBranch();

  if ((await pendingPublicCount(slug, branch)) >= MAX_PENDING_PUBLIC) {
    return res.status(429).json({ error: "Suggestion queue is full — try again later" });
  }

  const branchReady = await ensureBranch(slug, branch, "main");
  if (branchReady.error) {
    console.error(`[suggest] ${branchReady.error}`);
    return res.status(502).json({ error: "Could not store suggestion" });
  }

  const filename = encodeProposalFilename(proposal);
  const put = await putJsonFile(
    slug,
    branch,
    `${PENDING_DIR}/${filename}`,
    proposal,
    `chore(suggest): ${proposal.kind} from public`,
  );
  if (put.error) {
    console.error(`[suggest] ${put.error}`);
    return res.status(502).json({ error: "Could not store suggestion" });
  }

  pendingPublicCache.count += 1;
  return res.status(201).json({ ok: true, id: proposal.id });
}
