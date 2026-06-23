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
  "operator-booking": "data/overrides/operator-booking.json",
  "station-aliases": "data/overrides/station-aliases.json",
  // Routes the admin has turned off from the map. An array of route_id keys
  // (the same keys used in viewMap / seen.json). Applied at /api/initial-data
  // serve time, so a toggle here goes live on the next redeploy and is fully
  // reversible — see stripDisabledRoutes() in build-initial-data.mjs.
  "disabled-routes": "data/overrides/disabled-routes.json",
  // Manual route geometry keyed by route_id → { nj_polyline_0?, nj_polyline_1? }.
  // Overlaid onto the matching viewMap row in build-initial-data.mjs (baked into
  // the published artifact), so an admin can attach a real track polyline to a
  // row that ships without one. Values are encoded @mapbox/polyline strings.
  "route-polylines": "data/overrides/route-polylines.json",
  // The source registry rides the same admin write path (array of entries,
  // mutated by entry id). Scrapes pick changes up on the next nightly run.
  "source-registry": "data/sources/registry.json",
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

    // List of route_id keys turned off from the map (keyed on routeKey to
    // match the proposal/seen.json vocabulary rather than the station "name").
    case "disabled-routes": {
      const routeKey = requireString(p.routeKey, "routeKey");
      if (action === "add") return addToList(next, routeKey);
      if (action === "remove") return removeFromList(next, routeKey);
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

    // Per-operator booking config keyed by agency_id. Holds the deep-link URL
    // template (with {origin}/{dest} placeholders), an optional "deals" link,
    // and a station-name map (our name -> the booking site's expected name).
    case "operator-booking": {
      const obj = next && typeof next === "object" ? next : {};
      const agencyId = requireString(p.agencyId, "agencyId");
      // Existing record (so we don't clobber stationNames when editing URLs).
      const existing =
        obj[agencyId] && typeof obj[agencyId] === "object" ? obj[agencyId] : {};

      if (action === "set") {
        obj[agencyId] = {
          // Empty strings are normalized to null so the UI can fall back cleanly.
          urlTemplate: p.urlTemplate ? String(p.urlTemplate) : null,
          dealsUrl: p.dealsUrl ? String(p.dealsUrl) : null,
          dealsLabel: p.dealsLabel ? String(p.dealsLabel) : null,
          // Preserve the curated station-name map across URL edits.
          stationNames:
            existing.stationNames && typeof existing.stationNames === "object"
              ? existing.stationNames
              : {},
        };
        return obj;
      }
      if (action === "setStationName") {
        const stationName = requireString(p.stationName, "stationName");
        const bookingName = requireString(p.bookingName, "bookingName");
        const stationNames = { ...(existing.stationNames || {}) };
        stationNames[stationName] = bookingName;
        obj[agencyId] = { ...existing, stationNames };
        return obj;
      }
      if (action === "removeStationName") {
        const stationName = requireString(p.stationName, "stationName");
        const stationNames = { ...(existing.stationNames || {}) };
        delete stationNames[stationName];
        obj[agencyId] = { ...existing, stationNames };
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

    // Manual route geometry keyed by route_id. Each entry holds one or both
    // per-direction encoded polylines; `set` writes only the directions given
    // (preserving the other), `remove` drops the whole route_id entry.
    case "route-polylines": {
      const obj = next && typeof next === "object" ? next : {};
      const routeId = requireString(p.routeId, "routeId");
      if (action === "set") {
        const existing =
          obj[routeId] && typeof obj[routeId] === "object" ? obj[routeId] : {};
        const record = { ...existing };
        let touched = false;
        for (const dir of [0, 1]) {
          const key = `nj_polyline_${dir}`;
          if (p[key] != null) {
            record[key] = requireString(p[key], key);
            touched = true;
          }
        }
        if (!touched) {
          throw invalid('"set" requires nj_polyline_0 and/or nj_polyline_1');
        }
        obj[routeId] = record;
        return obj;
      }
      if (action === "remove") {
        delete obj[routeId];
        return obj;
      }
      throw invalid(`unknown action "${action}" for ${resource}`);
    }

    // Source registry: array of source entries keyed by `id` (see
    // scripts/lib/registry.mjs for the schema; the endpoint re-validates the
    // result with validateRegistry before committing).
    case "source-registry": {
      const arr = Array.isArray(next) ? next : [];
      const id = requireString(p.id, "id");
      const index = arr.findIndex((e) => e?.id === id);

      if (action === "setEnabled") {
        if (index === -1) throw invalid(`unknown source: ${id}`);
        if (typeof p.enabled !== "boolean") throw invalid('"enabled" must be boolean');
        arr[index] = { ...arr[index], enabled: p.enabled };
        return arr;
      }
      if (action === "setParams") {
        if (index === -1) throw invalid(`unknown source: ${id}`);
        if (p.params == null || typeof p.params !== "object" || Array.isArray(p.params)) {
          throw invalid('"params" must be an object');
        }
        arr[index] = { ...arr[index], params: p.params };
        return arr;
      }
      if (action === "set") {
        if (p.entry == null || typeof p.entry !== "object" || p.entry.id !== id) {
          throw invalid('"entry" must be an object with a matching id');
        }
        if (index === -1) arr.push(p.entry);
        else arr[index] = p.entry;
        return arr;
      }
      if (action === "remove") {
        if (index === -1) throw invalid(`unknown source: ${id}`);
        arr.splice(index, 1);
        return arr;
      }
      throw invalid(`unknown action "${action}" for ${resource}`);
    }

    // Station aliases: flat { "lowercase alias": "Canonical Name" } object.
    // Keys must be lowercase (the resolver does .toLowerCase() at lookup time).
    case "station-aliases": {
      const obj = next && typeof next === "object" ? next : {};
      if (action === "set") {
        const alias = requireString(p.alias, "alias").toLowerCase().trim();
        const canonical = requireString(p.canonical, "canonical");
        obj[alias] = canonical;
        return obj;
      }
      if (action === "remove") {
        const alias = requireString(p.alias, "alias").toLowerCase().trim();
        delete obj[alias];
        return obj;
      }
      throw invalid(`unknown action "${action}" for ${resource}`);
    }

    default:
      throw invalid(`unhandled resource: ${resource}`);
  }
}
