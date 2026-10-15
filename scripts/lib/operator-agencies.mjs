// scripts/lib/operator-agencies.mjs
// Which carrier runs a train, read from the operator's own words.
//
// nightjet.com sells ÖBB's Nightjets and its partners' EuroNights from one
// shop, and its train answer says who runs each one in German prose:
// "Operated by Polnische Bahn PKP". A partner EuroNight belongs to its carrier
// — PKP, MÁV, ČD, HŽPP — whose own site sells it, and whose name, Book button
// and timetable link the map should show. This module turns that sentence
// into one of the repo's agency ids.
//
// The mapping is data (registry `params.operatorAgencies` on the source that
// reads the sentence), compiled here:
//
//   { "home": "ÖBB",
//     "carriers": [{ "agency": "PKP", "match": ["PKP", "Polnisch*", …] }, …] }
//
// A keyword matches whole words of the folded text: "PKP Intercity" is two
// consecutive words, and a trailing `*` matches a word stem ("Polnisch*" →
// "Polnische", "Polnischen"). Whole words are load-bearing: a prefix "slov"
// would read Slovak "Slovensko" and Slovenian "Slovenske" as one carrier, and
// a substring "cd" or "sz" is inside other words.
//
// Dependency-free and pure: scripts/lib/registry.mjs validates the config
// with it, and that module is bundled into an admin API route.

/**
 * Lower-case words of a text with diacritics folded away:
 * "Tschechische Bahn ČD" → ["tschechische", "bahn", "cd"].
 * @param {unknown} text
 * @returns {string[]}
 */
export function foldOperatorWords(text) {
  if (text == null) return [];
  return String(text)
    .replace(/ß/g, "ss")
    .replace(/[łŁ]/g, "l")
    .replace(/[đĐ]/g, "d")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The operator text out of whatever shape the answer gives it: a string, or a
 * localised object read as en, int, then de, then its first string value.
 * Trimmed and NFC; null when there is nothing to read.
 * @param {unknown} value
 * @returns {string|null}
 */
export function readOperatorText(value) {
  let text = null;
  if (typeof value === "string") text = value;
  else if (value && typeof value === "object") {
    text =
      [value.en, value.int, value.de].find((v) => typeof v === "string" && v.trim()) ??
      Object.values(value).find((v) => typeof v === "string" && v.trim()) ??
      null;
  }
  const trimmed = text == null ? "" : String(text).normalize("NFC").trim();
  return trimmed || null;
}

const MIN_STEM_LENGTH = 4;

function compileKeyword(keyword) {
  const raw = String(keyword ?? "");
  const stem = raw.trim().endsWith("*");
  const words = foldOperatorWords(stem ? raw.trim().slice(0, -1) : raw);
  return { raw, stem, words };
}

/**
 * Problems with a mapping, as messages; empty when it is usable. A typo here
 * would silently send every partner train to its fallback carrier, which is
 * today's behaviour and so would never be noticed — hence the strictness.
 * @param {unknown} config
 * @returns {string[]}
 */
export function validateOperatorAgencies(config) {
  const errors = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["operatorAgencies must be an object { home, carriers }"];
  }
  for (const key of Object.keys(config)) {
    if (key !== "home" && key !== "carriers") errors.push(`operatorAgencies: unknown key "${key}"`);
  }
  const validId = (id) =>
    typeof id === "string" && id.trim() === id && id.length > 0 && id === id.normalize("NFC") && !id.includes("/");
  if (!validId(config.home)) {
    errors.push(`operatorAgencies.home must be one NFC agency id without "/"`);
  }
  if (!Array.isArray(config.carriers) || !config.carriers.length) {
    errors.push("operatorAgencies.carriers must be a non-empty array");
    return errors;
  }
  const seenAgencies = new Set();
  const owner = new Map(); // folded keyword → agency
  const stems = []; // { agency, word }
  for (const [i, carrier] of config.carriers.entries()) {
    const tag = `operatorAgencies.carriers[${i}]`;
    if (!carrier || typeof carrier !== "object") {
      errors.push(`${tag} must be an object { agency, match }`);
      continue;
    }
    for (const key of Object.keys(carrier)) {
      if (key !== "agency" && key !== "match") errors.push(`${tag}: unknown key "${key}"`);
    }
    if (!validId(carrier.agency)) {
      errors.push(`${tag}.agency must be one NFC agency id without "/" (a compound id books by link quality)`);
    } else if (seenAgencies.has(carrier.agency)) {
      errors.push(`${tag}.agency "${carrier.agency}" is listed twice`);
    } else {
      seenAgencies.add(carrier.agency);
    }
    if (!Array.isArray(carrier.match) || !carrier.match.length) {
      errors.push(`${tag}.match must be a non-empty array of keywords`);
      continue;
    }
    for (const keyword of carrier.match) {
      if (typeof keyword !== "string") {
        errors.push(`${tag}.match: keyword ${JSON.stringify(keyword)} is not a string`);
        continue;
      }
      if (keyword.trim().replace(/\*$/, "").includes("*")) {
        errors.push(`${tag}.match: "${keyword}" — "*" is only allowed at the end`);
        continue;
      }
      const { stem, words } = compileKeyword(keyword);
      if (!words.length) {
        errors.push(`${tag}.match: "${keyword}" folds to no word`);
        continue;
      }
      if (stem && (words.length !== 1 || words[0].length < MIN_STEM_LENGTH)) {
        errors.push(`${tag}.match: stem "${keyword}" must be one word of at least ${MIN_STEM_LENGTH} letters`);
        continue;
      }
      const folded = (stem ? "*" : "") + words.join(" ");
      const prior = owner.get(folded);
      if (prior && prior !== carrier.agency) {
        errors.push(`${tag}.match: "${keyword}" also belongs to ${prior}`);
      }
      owner.set(folded, carrier.agency);
      if (stem) stems.push({ agency: carrier.agency, word: words[0], keyword });
    }
  }
  if (validId(config.home) && !seenAgencies.has(config.home)) {
    errors.push(`operatorAgencies.home "${config.home}" must also be listed as a carrier`);
  }
  // A stem must not swallow another carrier's keyword.
  for (const { agency, word, keyword } of stems) {
    for (const [folded, other] of owner) {
      if (other === agency) continue;
      const otherWord = folded.replace(/^\*/, "").split(" ")[0];
      if (otherWord.startsWith(word)) {
        errors.push(`operatorAgencies: stem "${keyword}" (${agency}) also matches ${other}'s "${folded.replace(/^\*/, "")}"`);
      }
    }
  }
  return errors;
}

/**
 * Compile a validated mapping for agencyForOperatorText. Throws on an invalid
 * one: the registry validator has already said why.
 * @param {object} config
 */
export function compileOperatorAgencies(config) {
  const errors = validateOperatorAgencies(config);
  if (errors.length) throw new Error(errors.join("; "));
  return {
    home: config.home,
    carriers: config.carriers.map((c) => ({
      agency: c.agency,
      keywords: c.match.map(compileKeyword),
    })),
  };
}

function keywordPositions(words, keyword) {
  const hits = [];
  const n = keyword.words.length;
  for (let i = 0; i + n <= words.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      const word = words[i + j];
      const want = keyword.words[j];
      const isLast = j === n - 1;
      if (!(keyword.stem && isLast ? word.startsWith(want) : word === want)) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/**
 * Which carrier an operator text names.
 *
 * - `matched`: one carrier other than home is named (home named beside it
 *   does not count: "ÖBB and Polnische Bahn PKP" is PKP's train);
 * - `ambiguous`: two or more carriers other than home; `agency` is the one
 *   named first, `all` lists them;
 * - `home`: only the home carrier is named;
 * - `unknown`: text, but no carrier in it;
 * - `missing`: no text.
 *
 * @param {unknown} text
 * @param {ReturnType<typeof compileOperatorAgencies>} compiled
 * @returns {{ status: "matched"|"ambiguous"|"home"|"unknown"|"missing", agency: string|null, all: string[] }}
 */
export function agencyForOperatorText(text, compiled) {
  const value = readOperatorText(text);
  if (!value) return { status: "missing", agency: null, all: [] };
  const words = foldOperatorWords(value);
  const firstAt = new Map();
  for (const carrier of compiled.carriers) {
    for (const keyword of carrier.keywords) {
      const hits = keywordPositions(words, keyword);
      if (!hits.length) continue;
      const at = Math.min(...hits);
      if (!firstAt.has(carrier.agency) || at < firstAt.get(carrier.agency)) firstAt.set(carrier.agency, at);
    }
  }
  const named = [...firstAt.entries()].sort((a, b) => a[1] - b[1]).map(([agency]) => agency);
  const partners = named.filter((a) => a !== compiled.home);
  if (partners.length === 1) return { status: "matched", agency: partners[0], all: named };
  if (partners.length > 1) return { status: "ambiguous", agency: partners[0], all: named };
  if (named.length) return { status: "home", agency: compiled.home, all: named };
  return { status: "unknown", agency: null, all: [] };
}

/**
 * The carrier in a Back-on-Track agency id, for a train whose own operator
 * text says nothing usable: the first component that is a listed carrier
 * other than home ("HŽPP/ÖBB" → "HŽPP", "PKP/ČD" → "PKP"), else null. Never
 * the compound itself: a compound id picks its booking link by link quality,
 * and that sends a HŽPP train to ÖBB's shop.
 * @param {unknown} agencyId
 * @param {ReturnType<typeof compileOperatorAgencies>} compiled
 * @returns {string|null}
 */
export function carrierInAgencyId(agencyId, compiled) {
  const listed = new Set(compiled.carriers.map((c) => c.agency));
  const parts = String(agencyId ?? "")
    .split("/")
    .map((p) => p.normalize("NFC").trim())
    .filter(Boolean);
  return parts.find((p) => p !== compiled.home && listed.has(p)) ?? null;
}
