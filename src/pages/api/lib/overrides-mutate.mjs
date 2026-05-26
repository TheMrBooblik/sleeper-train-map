// lib/overrides-mutate.mjs
// Pure (no-IO) mutation logic for the data/overrides/*.json store. The admin
// write endpoint reads the current JSON from GitHub, applies one of these
// mutations, and commits the result. Kept dependency-free and side-effect-free
// so it can be unit-tested with raw `node` (tests/verify-overrides-mutate.mjs).

// resource key → path of the override file in the repo.
export const OVERRIDE_FILES = {
  "station-coordinates": "data/overrides/station-coordinates.json",
  "stations-to-skip": "data/overrides/stations-to-skip.json",
  "always-show-stations": "data/overrides/always-show-stations.json",
  "station-name-replacements": "data/overrides/station-name-replacements.json",
  "operator-pricing": "data/overrides/operator-pricing.json",
};

function invalid(message) {
  const err = new Error(message);
  err.code = "INVALID_OVERRIDE";
  return err;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(`"${field}" must be a non-empty string`);
  }
  return value;
}

function requireFiniteNumber(value, field) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw invalid(`"${field}" must be a finite number`);
  return n;
}

function addToList(list, name) {
  const arr = Array.isArray(list) ? [...list] : [];
  if (!arr.includes(name)) arr.push(name);
  return arr;
}

function removeFromList(list, name) {
  return (Array.isArray(list) ? list : []).filter((n) => n !== name);
}

/**
 * Apply a single override mutation to the current parsed JSON value.
 * Returns a new value (input is never mutated). Throws an Error with
 * code "INVALID_OVERRIDE" on bad input.
 *
 * @param {string} resource - one of OVERRIDE_FILES keys
 * @param {string} action
 * @param {object} payload
 * @param {*} current - current parsed JSON for the resource file
 * @returns {*} new JSON value to write back
 */
export function applyOverrideMutation(resource, action, payload, current) {
  if (!(resource in OVERRIDE_FILES)) {
    throw invalid(`unknown resource: ${resource}`);
  }
  const p = payload || {};
  const next = current == null ? null : structuredClone(current);

  switch (resource) {
    case "station-coordinates": {
      const obj = next && typeof next === "object" ? next : {};
      const name = requireString(p.name, "name");
      if (action === "set") {
        obj[name] = {
          lat: requireFiniteNumber(p.lat, "lat"),
          lon: requireFiniteNumber(p.lon, "lon"),
        };
        return obj;
      }
      if (action === "remove") {
        delete obj[name];
        return obj;
      }
      throw invalid(`unknown action "${action}" for ${resource}`);
    }

    case "stations-to-skip":
    case "always-show-stations": {
      const name = requireString(p.name, "name");
      if (action === "add") return addToList(next, name);
      if (action === "remove") return removeFromList(next, name);
      throw invalid(`unknown action "${action}" for ${resource}`);
    }

    case "operator-pricing": {
      const obj = next && typeof next === "object" ? next : {};
      const agencyId = requireString(p.agencyId, "agencyId");
      if (action === "set") {
        if (p.type !== "fixed" && p.type !== "dynamic") {
          throw invalid('"type" must be "fixed" or "dynamic"');
        }
        obj[agencyId] = {
          type: p.type,
          currency: p.currency ?? null,
          fromPrice:
            p.fromPrice == null
              ? null
              : requireFiniteNumber(p.fromPrice, "fromPrice"),
          source: p.source || "manual",
          ...(p.note ? { note: p.note } : {}),
        };
        return obj;
      }
      if (action === "remove") {
        delete obj[agencyId];
        return obj;
      }
      throw invalid(`unknown action "${action}" for ${resource}`);
    }

    case "station-name-replacements": {
      const obj =
        next && typeof next === "object"
          ? next
          : { routeReplacements: {}, stopReplacements: {} };
      obj.routeReplacements = obj.routeReplacements || {};
      obj.stopReplacements = obj.stopReplacements || {};
      const oldName = requireString(p.oldName, "oldName");
      switch (action) {
        case "setStop":
          obj.stopReplacements[oldName] = requireString(p.newName, "newName");
          return obj;
        case "removeStop":
          delete obj.stopReplacements[oldName];
          return obj;
        case "setRoute": {
          const newName = requireString(p.newName, "newName");
          obj.routeReplacements[oldName] =
            Array.isArray(p.routeIds) && p.routeIds.length
              ? { newName, routeIds: p.routeIds }
              : newName;
          return obj;
        }
        case "removeRoute":
          delete obj.routeReplacements[oldName];
          return obj;
        default:
          throw invalid(`unknown action "${action}" for ${resource}`);
      }
    }

    default:
      throw invalid(`unhandled resource: ${resource}`);
  }
}
