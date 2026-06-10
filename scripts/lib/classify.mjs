// scripts/lib/classify.mjs
// Pure nightly change classifier. Compares the freshly built (un-gated)
// payload against the approval index (data/canonical/state/seen.json) and
// decides, per the review policy:
//   • new route key            → stays gated + "route.add" proposal (apply: seen.approve)
//   • new injected station     → marker gated + "seen.approve" proposal
//   • material change on an approved route (endpoints, operating days,
//     agency, train-number set) → flows through (AUTO) + FYI "note" proposal
//   • route disappears         → remembered ≤30 days; FYI note once after 7
// Mechanical refreshes (times/polylines, same fingerprint) produce nothing.
//
// Returns { nextSeen, proposals, gatedRouteKeys }. No I/O — callers feed it
// data and persist the results (see scripts/classify-changes.mjs).

import { buildProposal } from "../../src/pages/api/lib/proposals.mjs";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const REMOVAL_NOTICE_AFTER_DAYS = 7;
export const FORGET_AFTER_DAYS = 30;
export const MAX_PROPOSALS_PER_RUN = 30;

// Small stable hash (djb2) for stop-sequence fingerprints.
export function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function fingerprintRoute(route) {
  return {
    o: route?.origin_trip_0 ?? null,
    d: route?.destination_trip_0 ?? null,
    days0: route?.service_id_0 ?? null,
    days1: route?.service_id_1 ?? null,
    agency: route?.agency_id ?? null,
    trains: [route?.trip_short_name_0, route?.trip_short_name_1]
      .filter(Boolean)
      .map((n) => n.trim())
      .join("|"),
    stopsHash: hashString(`${route?.via_0 ?? ""}~${route?.via_1 ?? ""}`),
  };
}

const FIELD_LABELS = {
  o: "origin",
  d: "destination",
  days0: "operating days (outbound)",
  days1: "operating days (return)",
  agency: "operator",
  trains: "train numbers",
};

// Material fingerprint differences (stop-sequence drift alone is mechanical).
function materialChanges(prevFp, fp) {
  const changes = [];
  for (const field of Object.keys(FIELD_LABELS)) {
    if ((prevFp?.[field] ?? null) !== (fp?.[field] ?? null)) {
      changes.push({
        field,
        label: FIELD_LABELS[field],
        before: prevFp?.[field] ?? null,
        after: fp?.[field] ?? null,
      });
    }
  }
  return changes;
}

function routeLabel(key, route) {
  const train = route?.trip_short_name_0 || key;
  const o = route?.origin_trip_0 || "?";
  const d = route?.destination_trip_0 || "?";
  return `${train} (${o} – ${d})`;
}

/**
 * @param {object} args
 * @param {object|null} args.previousSeen   Current data/canonical/state/seen.json
 * @param {object} args.viewMap             Un-gated merged viewMap (route key → row)
 * @param {string[]} args.injectedStations  All injected-station candidates (from build stats)
 * @param {Set<string>} [args.openProposalKeys] `${kind}:${target}` keys of open
 *   proposals, for dedup across runs
 * @param {Date} [args.now]
 */
export function classify({
  previousSeen,
  viewMap,
  injectedStations,
  openProposalKeys = new Set(),
  now = new Date(),
}) {
  const today = now.toISOString().slice(0, 10);
  const prevRoutes = previousSeen?.routes ?? {};
  const prevStations = previousSeen?.injectedStations ?? {};

  const nextSeen = {
    v: 1,
    updatedAt: now.toISOString(),
    routes: {},
    injectedStations: {},
  };
  const proposals = [];
  const gatedRouteKeys = [];
  const dedup = (kind, target) => openProposalKeys.has(`${kind}:${target}`);

  // ── Routes present tonight ────────────────────────────────────────────────
  for (const [key, route] of Object.entries(viewMap ?? {})) {
    const fp = fingerprintRoute(route);
    const prev = prevRoutes[key];

    if (!prev) {
      // Brand new — gated until approved.
      gatedRouteKeys.push(key);
      nextSeen.routes[key] = {
        firstSeen: today,
        lastSeen: today,
        approved: false,
        fingerprint: fp,
      };
      if (!dedup("route.add", key)) {
        proposals.push(
          buildProposal({
            source: "scrape",
            sourceDetail: key.includes("_") ? key.split("_")[0] : "backontrack",
            kind: "route.add",
            title: `New train: ${routeLabel(key, route)}`,
            summary:
              `Route "${key}" appeared in tonight's scrape and is withheld from the map until approved. ` +
              `Via: ${(route?.via_0 || "").slice(0, 300)}`,
            target: { routeKey: key, agencyId: route?.agency_id ?? null },
            after: {
              train: route?.trip_short_name_0 ?? null,
              returnTrain: route?.trip_short_name_1 ?? null,
              origin: route?.origin_trip_0 ?? null,
              destination: route?.destination_trip_0 ?? null,
              operator: route?.agency_id ?? null,
              operatingDays: route?.service_id_0 ?? null,
            },
            apply: { type: "seen.approve", payload: { routeKey: key } },
          }),
        );
      }
      continue;
    }

    nextSeen.routes[key] = { ...prev, lastSeen: today, fingerprint: fp };
    delete nextSeen.routes[key].removalNoticed;
    if (prev.approved !== true) gatedRouteKeys.push(key);

    if (prev.approved === true) {
      const changes = materialChanges(prev.fingerprint, fp);
      if (changes.length && !dedup("note", key)) {
        proposals.push(
          buildProposal({
            source: "scrape",
            kind: "note",
            title: `Changed: ${routeLabel(key, route)}`,
            summary:
              "Material change on an approved route (already live — FYI): " +
              changes.map((c) => `${c.label}: "${c.before}" → "${c.after}"`).join("; "),
            target: { routeKey: key, agencyId: route?.agency_id ?? null },
            before: Object.fromEntries(changes.map((c) => [c.label, c.before])),
            after: Object.fromEntries(changes.map((c) => [c.label, c.after])),
          }),
        );
      }
    }
  }

  // ── Routes that disappeared ───────────────────────────────────────────────
  for (const [key, prev] of Object.entries(prevRoutes)) {
    if (viewMap?.[key]) continue;
    const daysGone = (now.getTime() - Date.parse(prev.lastSeen)) / MS_PER_DAY;
    if (daysGone > FORGET_AFTER_DAYS) continue; // forget entirely

    nextSeen.routes[key] = { ...prev };
    if (
      prev.approved === true &&
      daysGone >= REMOVAL_NOTICE_AFTER_DAYS &&
      !prev.removalNoticed &&
      !dedup("note", key)
    ) {
      nextSeen.routes[key].removalNoticed = true;
      proposals.push(
        buildProposal({
          source: "scrape",
          kind: "note",
          title: `Disappeared: ${prev.fingerprint?.trains || key}`,
          summary:
            `Route "${key}" (${prev.fingerprint?.o ?? "?"} – ${prev.fingerprint?.d ?? "?"}) ` +
            `has been missing from the sources for ${Math.floor(daysGone)} days and is no longer shown. ` +
            `No action needed if the train was discontinued.`,
          target: { routeKey: key },
        }),
      );
    }
  }

  // ── Injected stations ─────────────────────────────────────────────────────
  for (const name of injectedStations ?? []) {
    const prev = prevStations[name];
    if (prev) {
      nextSeen.injectedStations[name] = prev;
      continue;
    }
    nextSeen.injectedStations[name] = { firstSeen: today, approved: false };
    if (!dedup("seen.approve", name)) {
      proposals.push(
        buildProposal({
          source: "scrape",
          kind: "seen.approve",
          title: `New station: ${name}`,
          summary:
            `Station "${name}" was injected by an operator source for the first time. ` +
            `Its marker is hidden until approved (routes through it still render).`,
          target: { stationName: name },
          apply: { type: "seen.approve", payload: { stationName: name } },
        }),
      );
    }
  }

  const overflow = proposals.length - MAX_PROPOSALS_PER_RUN;
  return {
    nextSeen,
    proposals: proposals.slice(0, MAX_PROPOSALS_PER_RUN),
    droppedProposals: overflow > 0 ? overflow : 0,
    gatedRouteKeys,
  };
}
