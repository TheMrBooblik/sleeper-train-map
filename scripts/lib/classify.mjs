// scripts/lib/classify.mjs
// Pure nightly change classifier. Compares the freshly built (un-gated)
// payload against the approval index (data/canonical/state/seen.json) and
// decides, per the review policy:
//   • new route key            → AUTO-shown, UNLESS it looks like a duplicate of
//     a route already on the map (findDuplicateCandidate) — then gated + a
//     "possible duplicate" route.add proposal (apply: seen.approve)
//   • new injected station     → marker gated + "seen.approve" proposal
//   • material change on an approved route (endpoints, operating days,
//     agency, train-number set) → flows through (AUTO) + FYI "note" proposal
//   • route disappears         → remembered ≤30 days; FYI note once after 7
// Mechanical refreshes (times/polylines, same fingerprint) produce nothing.
//
// Auto-show-by-default keeps Back-on-Track coverage complete: a train only BoT
// knows about appears without manual review, while the deterministic duplicate
// detector (no AI — works every night) routes likely-doubles to the admin so
// official data keeps priority and the map never doubles a service.
//
// Trusted sources (registry entries with trusted:true, see trustConfig in
// scripts/lib/registry.mjs) skip the duplicate check entirely: their new
// routes/stations are auto-approved and reported in ONE aggregate FYI note per
// night. A route is trusted when its key carries a trusted source's synthetic
// idPrefix, or when the scrape post-step stamped its row with official_sources
// tonight.
//
// Returns { nextSeen, proposals, gatedRouteKeys }. No I/O — callers feed it
// data and persist the results (see scripts/classify-changes.mjs).

import { buildProposal } from "../../src/pages/api/lib/proposals.mjs";
import { findDuplicateCandidate } from "./duplicate-detect.mjs";

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
 * @param {object} [args.stationSources]    name → registry source id that injected
 *   the station (from build stats), for trusted-station auto-approval
 * @param {{sourceIds: Set<string>, prefixes: string[]}} [args.trust]
 *   Trusted-source config (trustConfig(registry)); empty = current gating for all
 * @param {Set<string>} [args.openProposalKeys] `${kind}:${target}` keys of open
 *   proposals, for dedup across runs
 * @param {object} [args.helpers] Duplicate-detector lookups injected by the
 *   caller (scripts/classify-changes.mjs): { resolveName, coordsOf }. Absent =
 *   exact-name endpoint matching only (no alias/coordinate proximity).
 * @param {Date} [args.now]
 */
export function classify({
  previousSeen,
  viewMap,
  injectedStations,
  stationSources = {},
  trust = { sourceIds: new Set(), prefixes: [] },
  openProposalKeys = new Set(),
  helpers = {},
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

  const trustedPrefixes = trust?.prefixes ?? [];
  const trustedSourceIds = trust?.sourceIds ?? new Set();
  const isTrustedRoute = (key, route) =>
    trustedPrefixes.some((p) => key.startsWith(p)) ||
    (Array.isArray(route?.official_sources) &&
      route.official_sources.some((s) => trustedSourceIds.has(s)));
  // Everything auto-approved tonight, reported as one aggregate FYI note.
  const autoAdded = { routes: [], stations: [] };

  // All train numbers running tonight — used to tell "key migrated to another
  // row" apart from "service actually disappeared".
  const currentTrainNumbers = new Set();
  for (const route of Object.values(viewMap ?? {})) {
    [route?.trip_short_name_0, route?.trip_short_name_1]
      .filter(Boolean)
      .forEach((n) => currentTrainNumbers.add(n.toString().trim()));
  }

  // Routes already on the map that a brand-new BoT route is checked against:
  // trusted/official synthetic rows + anything the admin previously approved.
  // A new non-trusted route that fuzzily matches one of these is gated for
  // review instead of auto-shown, so official data is never silently doubled.
  const onMap = [];
  for (const [key, route] of Object.entries(viewMap ?? {})) {
    if (isTrustedRoute(key, route) || prevRoutes[key]?.approved === true) {
      onMap.push([key, route]);
    }
  }

  // Gate a route and file its review card: a plain "new train" card, or a
  // "possible duplicate" card when `dup` is set (deduped downstream by the
  // stable proposal id).
  const gateRoute = (key, route, dup) => {
    gatedRouteKeys.push(key);
    if (dedup("route.add", key)) return;
    const dupNote = dup
      ? ` ⚠ Possible duplicate of route "${dup.key}" — ${dup.reasons.join(", ")}. ` +
        "Approve only if it is genuinely a separate service; reject to keep it hidden."
      : "";
    proposals.push(
      buildProposal({
        source: "scrape",
        sourceDetail: key.includes("_") ? key.split("_")[0] : "backontrack",
        kind: "route.add",
        title: dup
          ? `Possible duplicate: ${routeLabel(key, route)}`
          : `New train: ${routeLabel(key, route)}`,
        summary:
          `Route "${key}" appeared in tonight's scrape and is withheld from the map until approved.` +
          dupNote +
          ` Via: ${(route?.via_0 || "").slice(0, 280)}`,
        target: {
          routeKey: key,
          agencyId: route?.agency_id ?? null,
          duplicateOf: dup?.key ?? null,
        },
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
  };

  // ── Routes present tonight ────────────────────────────────────────────────
  for (const [key, route] of Object.entries(viewMap ?? {})) {
    const fp = fingerprintRoute(route);
    const prev = prevRoutes[key];

    if (!prev) {
      const newSeen = {
        firstSeen: today,
        lastSeen: today,
        approved: true,
        autoApproved: today,
        fingerprint: fp,
      };
      if (isTrustedRoute(key, route)) {
        // Official data from a trusted source — live immediately, FYI only.
        nextSeen.routes[key] = newSeen;
        autoAdded.routes.push({ key, route });
        continue;
      }
      const dup = findDuplicateCandidate(route, onMap, helpers);
      if (!dup) {
        // Nothing like it already on the map — auto-show (keeps BoT coverage
        // complete without manual review).
        nextSeen.routes[key] = newSeen;
        autoAdded.routes.push({ key, route });
        continue;
      }
      // Looks like a duplicate of an existing route — gate for a one-click
      // admin decision so official data keeps priority.
      nextSeen.routes[key] = {
        firstSeen: today,
        lastSeen: today,
        approved: false,
        fingerprint: fp,
      };
      gateRoute(key, route, dup);
      continue;
    }

    nextSeen.routes[key] = { ...prev, lastSeen: today, fingerprint: fp };
    delete nextSeen.routes[key].removalNoticed;
    if (prev.approved !== true) {
      const stillDup =
        !isTrustedRoute(key, route) && findDuplicateCandidate(route, onMap, helpers);
      if (stillDup) {
        // Still a likely duplicate — keep it gated, but don't re-file: its
        // original review card already stands (or the admin rejected it, and we
        // must not nag again).
        gatedRouteKeys.push(key);
      } else {
        // Trusted corroboration arrived, or the look-alike it was held against
        // is gone — let it through now (self-heal).
        nextSeen.routes[key].approved = true;
        nextSeen.routes[key].autoApproved = today;
        autoAdded.routes.push({ key, route });
      }
    }

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
      // Key migration, not a service loss: every train of the vanished key
      // still runs tonight under another row (e.g. a synthetic es_/nj_ row
      // handed back to Back-on-Track or vice versa) — flag silently.
      const prevTrains = (prev.fingerprint?.trains ?? "")
        .split("|")
        .filter(Boolean);
      if (
        prevTrains.length > 0 &&
        prevTrains.every((t) => currentTrainNumbers.has(t))
      ) {
        continue;
      }
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
  const trustedStation = (name) => trustedSourceIds.has(stationSources?.[name]);
  for (const name of injectedStations ?? []) {
    const prev = prevStations[name];
    if (prev) {
      nextSeen.injectedStations[name] = prev;
      if (prev.approved !== true && trustedStation(name)) {
        nextSeen.injectedStations[name] = {
          ...prev,
          approved: true,
          autoApproved: today,
        };
        autoAdded.stations.push(name);
      }
      continue;
    }
    if (trustedStation(name)) {
      nextSeen.injectedStations[name] = {
        firstSeen: today,
        approved: true,
        autoApproved: today,
      };
      autoAdded.stations.push(name);
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

  // ── Aggregate FYI for everything auto-approved tonight ───────────────────
  // One note per night regardless of volume (protects MAX_PROPOSALS_PER_RUN);
  // the dated target keeps the stable proposal id unique per night (a
  // target-less note would dedup-block all future nights as "p_general").
  if (autoAdded.routes.length || autoAdded.stations.length) {
    const aggregateKey = `auto-added-${today}`;
    if (!dedup("note", aggregateKey)) {
      const lines = [
        ...autoAdded.routes.map(
          ({ key, route }) => `route ${key}: ${routeLabel(key, route)}`,
        ),
        ...autoAdded.stations.map(
          (name) => `station ${name} (${stationSources?.[name] ?? "?"})`,
        ),
      ];
      let summary =
        "Auto-added tonight (already live — FYI): trusted official sources plus " +
        "new Back-on-Track routes with no duplicate already on the map.\n" +
        lines.join("\n");
      if (summary.length > 1900) summary = `${summary.slice(0, 1900)}…`;
      proposals.unshift(
        buildProposal({
          source: "scrape",
          kind: "note",
          title:
            `Auto-added ` +
            `(${autoAdded.routes.length} routes, ${autoAdded.stations.length} stations)`,
          summary,
          target: { routeKey: aggregateKey },
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
