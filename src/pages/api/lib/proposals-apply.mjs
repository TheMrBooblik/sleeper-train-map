// lib/proposals-apply.mjs
// Pure dispatch from a proposal's `apply` instruction to file mutations.
// planProposalApply() returns the list of target files with pure mutate
// functions; the caller (admin proposals endpoint) reads each file from
// GitHub, applies mutate, and commits — same write path as overrides.
//
// Apply types land phase by phase:
//   override.set  → data/overrides/* via applyOverrideMutation (reused verbatim)
//   seen.approve  → data/canonical/state/seen.json (route/station gate)
//   route.remove  → data/canonical/state/seen.json (approved=false)
//   route.add/route.update → data/canonical/routes/{key}.json
//   price.update  → data/canonical/prices.json
//   note          → no-op (admin acts manually)

import { OVERRIDE_FILES, applyOverrideMutation } from "./overrides-mutate.mjs";

const SEEN_PATH = "data/canonical/state/seen.json";
const PRICES_PATH = "data/canonical/prices.json";
const ROUTES_DIR = "data/canonical/routes";

const invalid = (message) => {
  const err = new Error(message);
  err.code = "INVALID_PROPOSAL";
  return err;
};

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw invalid(`${label} must be a non-empty string`);
  }
  return value.trim();
}

// A route key is also used as a filename under data/canonical/routes/.
function requireRouteKey(value) {
  const key = requireString(value, "routeKey");
  if (!/^[\w.-]+$/.test(key)) throw invalid(`invalid routeKey: ${key}`);
  return key;
}

const APPLY_HANDLERS = {
  "override.set": (payload) => {
    const { resource, action } = payload ?? {};
    const filePath = OVERRIDE_FILES[resource];
    if (!filePath) throw invalid(`unknown override resource: ${resource}`);
    requireString(action, "action");
    return [
      {
        path: filePath,
        mutate: (current) =>
          applyOverrideMutation(resource, action, payload.payload, current),
      },
    ];
  },

  "seen.approve": (payload) => {
    const routeKey = payload?.routeKey ?? null;
    const stationName = payload?.stationName ?? null;
    if (!routeKey && !stationName) {
      throw invalid("seen.approve needs routeKey or stationName");
    }
    return [
      {
        path: SEEN_PATH,
        mutate: (current) => {
          const seen = current ?? { v: 1, routes: {}, injectedStations: {} };
          const next = {
            ...seen,
            updatedAt: new Date().toISOString(),
            routes: { ...(seen.routes ?? {}) },
            injectedStations: { ...(seen.injectedStations ?? {}) },
          };
          if (routeKey) {
            const key = requireRouteKey(routeKey);
            next.routes[key] = { ...(next.routes[key] ?? {}), approved: true };
          }
          if (stationName) {
            const name = requireString(stationName, "stationName");
            next.injectedStations[name] = {
              ...(next.injectedStations[name] ?? {}),
              approved: true,
            };
          }
          return next;
        },
      },
    ];
  },

  "route.remove": (payload) => {
    const key = requireRouteKey(payload?.routeKey);
    return [
      {
        path: SEEN_PATH,
        mutate: (current) => {
          const seen = current ?? { v: 1, routes: {}, injectedStations: {} };
          return {
            ...seen,
            updatedAt: new Date().toISOString(),
            routes: {
              ...(seen.routes ?? {}),
              [key]: { ...(seen.routes?.[key] ?? {}), approved: false },
            },
          };
        },
      },
    ];
  },

  "route.add": (payload) => routeWrite(payload, { mustExist: false }),
  "route.update": (payload) => routeWrite(payload, { mustExist: true }),

  "price.update": (payload) => {
    const key = requireRouteKey(payload?.routeKey);
    const price = payload?.price;
    if (price !== null) {
      if (!Number.isFinite(price?.fromPrice) || price.fromPrice < 0) {
        throw invalid("price.fromPrice must be a non-negative number (or price null to remove)");
      }
      requireString(price?.currency, "price.currency");
    }
    return [
      {
        path: PRICES_PATH,
        mutate: (current) => {
          const prices = { ...(current ?? {}) };
          if (price === null) {
            delete prices[key];
          } else {
            prices[key] = {
              fromPrice: price.fromPrice,
              currency: price.currency,
              source: price.source ?? null,
              sampledAt: price.sampledAt ?? null,
              sampleDate: price.sampleDate ?? null,
              evidenceUrl: price.evidenceUrl ?? null,
            };
          }
          return prices;
        },
      },
    ];
  },

  note: () => [],
};

function routeWrite(payload, { mustExist }) {
  const route = payload?.route;
  const key = requireRouteKey(route?.routeKey);
  if (route?.v !== 1) throw invalid("route.v must be 1");
  requireString(route?.agencyId, "route.agencyId");
  if (!Array.isArray(route?.directions) || route.directions.length === 0) {
    throw invalid("route.directions must be a non-empty array");
  }
  for (const dir of route.directions) {
    requireString(dir?.trainName, "direction.trainName");
    if (!Array.isArray(dir?.stations)) throw invalid("direction.stations must be an array");
  }
  return [
    {
      path: `${ROUTES_DIR}/${key}.json`,
      mutate: (current) => {
        if (mustExist && current == null) throw invalid(`route ${key} does not exist`);
        if (!mustExist && current != null) throw invalid(`route ${key} already exists`);
        return { ...route, updatedAt: new Date().toISOString() };
      },
    },
  ];
}

/**
 * @param {{type: string, payload: object}|null} apply
 * @returns {Array<{ path: string, mutate: (currentJson: any) => any }>}
 */
export function planProposalApply(apply) {
  if (apply == null) return [];
  const handler = APPLY_HANDLERS[apply.type];
  if (!handler) throw invalid(`unknown apply type: ${apply.type}`);
  return handler(apply.payload ?? {});
}
