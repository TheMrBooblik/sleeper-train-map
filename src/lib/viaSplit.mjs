// src/lib/viaSplit.mjs
// Split a via string into station names.
//
// A via string is stations joined with " - ", which works right up until a
// station's own name contains " - " — and 437 of the payload's stops do.
// Splitting on the separator then tears the name in half and invents two
// places that do not exist: SNCF's "Rocamadour - Padirac" became "Rocamadour"
// and "Padirac", "Viviez - Decazeville" became "Viviez" and "Decazeville".
// Both halves then resolve to no coordinate, so the real station loses its map
// dot as well — 28 of the 59 unresolved via tokens across the whole payload,
// the single largest cause, and the only one that puts fabricated place names
// on a public page rather than merely omitting a dot.
//
// The fix is to split by what a station is CALLED rather than by a character:
// walk left to right and take the longest run of atoms that names a real
// station. The station table is injected because the callers differ — the map
// hooks have the stops index, a raw scrape step may not — and with no
// predicate this degrades to the plain separator split, so a caller that
// cannot tell a station from a fragment behaves exactly as it did before.
//
// Two guards, both measured against the published payload before being
// written down:
//
//   * a merge only happens when the merged name IS a known station, so two
//     ordinary adjacent stations are never glued together;
//   * and not when BOTH halves are themselves known stations, because then the
//     join is far more likely to be the separator doing its job than a name
//     that happens to look like one. Across the payload this second guard is a
//     no-op today (14 merges qualify, 0 are ambiguous) — it exists so that a
//     station added later cannot silently start swallowing its neighbour.
//
// MAX_ATOMS_PER_NAME bounds the lookahead. The longest station name in the
// payload holds two " - " separators ("Saint-Pierre - des-Corps" style triples
// exist), so 3 atoms covers the data with a margin; an unbounded scan would be
// quadratic in a long via list for no gain.
const MAX_ATOMS_PER_NAME = 3;

export const VIA_SEPARATOR = " - ";

/**
 * @param {string} via            e.g. "Limoges - Rocamadour - Padirac - Figeac"
 * @param {(name: string) => boolean} [isKnownStation] resolves a name to a real
 *        station. Omit it and the result is the plain separator split.
 * @returns {string[]} station names, trimmed, empties dropped
 */
export function splitViaString(via, isKnownStation = null) {
  const atoms = String(via ?? "")
    .split(VIA_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!isKnownStation || atoms.length < 2) return atoms;

  const out = [];
  let i = 0;
  while (i < atoms.length) {
    let taken = 1;
    // Longest first: a 3-atom name must win over the 2-atom prefix inside it.
    for (let n = Math.min(MAX_ATOMS_PER_NAME, atoms.length - i); n >= 2; n -= 1) {
      const merged = atoms.slice(i, i + n).join(VIA_SEPARATOR);
      if (!isKnownStation(merged)) continue;
      // Never glue two stations that each stand on their own.
      const everyPartIsItsOwnStation = atoms
        .slice(i, i + n)
        .every((part) => isKnownStation(part));
      if (everyPartIsItsOwnStation) continue;
      out.push(merged);
      taken = n;
      break;
    }
    if (taken === 1) out.push(atoms[i]);
    i += taken;
  }
  return out;
}

/**
 * The station-table predicate the map and the merge share: a name resolves when
 * some stop carries it as `stop_id` or `stop_name`. Both are checked because
 * 703 records spell the two differently.
 *
 * @param {Array} stops
 * @param {(name: string) => string} normalize the lookup normalizer
 */
export function knownStationPredicate(stops, normalize) {
  const keys = new Set();
  for (const stop of stops ?? []) {
    for (const name of [stop?.stop_id, stop?.stop_name]) {
      if (name) keys.add(normalize(String(name)));
    }
  }
  return (name) => keys.has(normalize(String(name ?? "")));
}

/**
 * Every name a via string could be referring to: each atom, plus every
 * contiguous run of them up to MAX_ATOMS_PER_NAME.
 *
 * For deciding which stops to KEEP — the payload projection's keep-set — this
 * beats splitViaString, because keeping is a superset operation: an extra key
 * that matches no stop costs nothing, while a missing one drops the station
 * from the payload and no later fix can bring it back. The projection has no
 * station table of its own (it runs before we know which stops survive), and
 * this way it does not need one.
 *
 * That is not a hypothetical: all five of the torn SNCF stations were present
 * in the published artifact and absent from the shipped payload, so the browser
 * never received them and they could not have had a marker whatever the map
 * did with the name.
 *
 * @param {string} via
 * @returns {string[]}
 */
export function viaNameCandidates(via) {
  const atoms = String(via ?? "")
    .split(VIA_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (let i = 0; i < atoms.length; i += 1) {
    const limit = Math.min(MAX_ATOMS_PER_NAME, atoms.length - i);
    for (let n = 1; n <= limit; n += 1) {
      out.push(atoms.slice(i, i + n).join(VIA_SEPARATOR));
    }
  }
  return out;
}
