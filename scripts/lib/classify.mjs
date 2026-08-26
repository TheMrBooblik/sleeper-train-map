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
// Trusted sources (registry entries with trusted:true, see trustConfig in
// scripts/lib/registry.mjs) bypass the gate: their new routes/stations are
// auto-approved and reported in ONE aggregate FYI note per night. A route is
// trusted when its key carries a trusted source's synthetic idPrefix, or when
// the scrape post-step stamped its row with official_sources tonight.
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

// Any fingerprint difference at all, stop-sequence drift included. Used only to
// date `lastChanged` — the integration dashboard's honest staleness signal.
// A nightly fetch of a stale upstream keeps the feed timestamp green forever;
// what actually tells you Back-on-Track has stopped maintaining a route is that
// its content has not moved in months.
function fingerprintChanged(prevFp, fp) {
  const keys = new Set([...Object.keys(prevFp ?? {}), ...Object.keys(fp ?? {})]);
  for (const key of keys) {
    if ((prevFp?.[key] ?? null) !== (fp?.[key] ?? null)) return true;
  }
  return false;
}

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
 * @param {Date} [args.now]
 */
export function classify({
  previousSeen,
  viewMap,
  injectedStations,
  stationSources = {},
  trust = { sourceIds: new Set(), prefixes: [] },
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

  // ── Routes present tonight ────────────────────────────────────────────────
  for (const [key, route] of Object.entries(viewMap ?? {})) {
    const fp = fingerprintRoute(route);
    const prev = prevRoutes[key];

    if (!prev) {
      if (isTrustedRoute(key, route)) {
        // Official data from a trusted source — live immediately, FYI only.
        nextSeen.routes[key] = {
          firstSeen: today,
          lastSeen: today,
          lastChanged: today,
          approved: true,
          autoApproved: today,
          fingerprint: fp,
        };
        autoAdded.routes.push({ key, route });
        continue;
      }
      // Brand new — gated until approved.
      gatedRouteKeys.push(key);
      nextSeen.routes[key] = {
        firstSeen: today,
        lastSeen: today,
        lastChanged: today,
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

    // Entries written before lastChanged existed inherit firstSeen, which is the
    // earliest date we can honestly claim; it self-corrects on the next change.
    nextSeen.routes[key] = {
      ...prev,
      lastSeen: today,
      lastChanged: fingerprintChanged(prev.fingerprint, fp)
        ? today
        : (prev.lastChanged ?? prev.firstSeen ?? today),
      fingerprint: fp,
    };
    delete nextSeen.routes[key].removalNoticed;
    if (prev.approved !== true) {
      if (isTrustedRoute(key, route)) {
        // Trusted corroboration arrived after the key was first seen (e.g. the
        // source was just marked trusted, or official data caught up) — self-heal.
        nextSeen.routes[key].approved = true;
        nextSeen.routes[key].autoApproved = today;
        autoAdded.routes.push({ key, route });
      } else {
        gatedRouteKeys.push(key);
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
    const aggregateKey = `trusted-${today}`;
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
        "Auto-approved from trusted official sources (already live — FYI):\n" +
        lines.join("\n");
      if (summary.length > 1900) summary = `${summary.slice(0, 1900)}…`;
      proposals.unshift(
        buildProposal({
          source: "scrape",
          kind: "note",
          title:
            `Auto-added from trusted sources ` +
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
