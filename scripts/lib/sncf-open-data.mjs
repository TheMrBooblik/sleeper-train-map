// scripts/lib/sncf-open-data.mjs
// SNCF's own open data for the Intercités de Nuit, beside the GTFS timetable:
// what a ticket costs and how often the train arrives on time.
//
// Two datasets on SNCF's Opendatasoft portal (ressources.data.sncf.com), both
// ODbL, both re-published by SNCF itself:
//
//   tarifs-intercites  — "Tarifs Intercités": the full-fare (tarif plein) range,
//     a minimum and a maximum, per origin–destination and fare class, for day
//     AND night Intercités. SNCF revises it with each tariff change (the
//     current one took effect on 2 January 2026). The live export (first
//     probe, 2026-10-04: 2 559 records) carries transporteur, origine,
//     origine_uic8, destination, destination_uic8, classe ("1"/"2"),
//     profil_tarifaire (only "Tarif Normal"), type_place ("assise" for a
//     seat), prix_min, prix_max. A night pair has three rows: class 2 from
//     €19 (seat), class 2 from €29 (couchette), class 1 from €39 (couchette).
//   regularite-mensuelle-intercites — "Régularité mensuelle Intercités": per
//     month and per origin–destination the AQST selects, trains scheduled,
//     run, cancelled and late at the terminus (a journey over 3h is late from
//     15 minutes), and the resulting rate. Columns: Date, Axe, Départ,
//     Arrivée, Nombre de trains programmés, Nombre de trains ayant circulé,
//     Nombre de trains annulés, Nombre de trains en retard à l'arrivée, Taux
//     de régularité, …
//
// Neither host is reachable from a dev sandbox, so — like jr-sunrise.mjs and
// es-last-minute.mjs — this reader was written from SNCF's documented column
// labels without seeing a live answer, and is layout-agnostic and strict
// instead: a column is found by what its folded label says (Opendatasoft
// exports labels as `gare_origine_code_uic`, its CSV as "Gare origine - code
// UIC", either works), and every fact is refused rather than guessed when the
// data cannot pin it to the night train. `npm run probe-sncf-open-data` (the
// "Probe SNCF open data" workflow, or the `run-probes` label on a PR) prints
// what the live datasets hold and what this reader makes of them.
//
// Two refusals carry the design:
//
// * Only BERTHS are priced, and a berth is what `type_place` (or a label)
//   says, never the bare class: a night pair lists a seat AND a couchette
//   under class "2". Paris–Toulouse is served by day Intercités as well, so
//   where `transporteur` names the night service only its rows are read. A
//   row whose class and place type say nothing is reported, not priced.
// * Punctuality is attributed only where no daytime Intercités runs the same
//   pair. The AQST counts every selected train between two stations, day and
//   night alike, so a Paris–Toulouse rate is mostly the day trains'. The GTFS
//   feed the adapter already reads says which pairs have a day service
//   (`dayServedPairs`, built by `dayServedStationPairs` in gtfs.mjs); those
//   pairs carry no punctuality figure at all.
//
// Pure: no I/O. The adapter fetches, this reads.

/** Opendatasoft portal SNCF publishes both datasets on. */
export const SNCF_ODS_BASE = "https://ressources.data.sncf.com";
export const TARIFFS_DATASET = "tarifs-intercites";
export const PUNCTUALITY_DATASET = "regularite-mensuelle-intercites";

/**
 * The addresses one dataset can be read from, most specific first: the
 * Explore v2.1 export (flat records keyed by field name), then the classic
 * download (records nested under `fields`). Both are the same portal; the
 * second is there because Opendatasoft has moved its API once already.
 */
export function odsExportUrls(dataset, base = SNCF_ODS_BASE) {
  const root = String(base || SNCF_ODS_BASE).replace(/\/+$/, "");
  return [
    `${root}/api/explore/v2.1/catalog/datasets/${dataset}/exports/json?lang=fr&timezone=Europe%2FParis`,
    `${root}/explore/dataset/${dataset}/download/?format=json&timezone=Europe/Paris&lang=fr`,
  ];
}

/** The dataset's own metadata record (last modified, records count). */
export function odsMetadataUrl(dataset, base = SNCF_ODS_BASE) {
  const root = String(base || SNCF_ODS_BASE).replace(/\/+$/, "");
  return `${root}/api/explore/v2.1/catalog/datasets/${dataset}`;
}

/** "2025-12-26T10:12:00+00:00" → "2025-12-26", from a v2.1 metadata answer. */
export function datasetModified(meta) {
  const raw =
    meta?.metas?.default?.modified ??
    meta?.metas?.default?.data_processed ??
    meta?.dataset?.metas?.default?.modified ??
    null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw ?? ""));
  return m ? m[1] : null;
}

// ─── Reading records ──────────────────────────────────────────────────────────

/** Fold a label or a name: lowercase, no accents, alphanumerics only. */
export function fold(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Words of a name, folded: "Latour-de-Carol - Enveitg" → [latour, de, carol, enveitg]. */
export function foldWords(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Split one CSV line on `sep`, honouring double quotes. */
function splitCsvLine(line, sep) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** CSV text → records. Opendatasoft writes `;`; a plain `,` file reads too. */
export function parseCsv(text) {
  const lines = String(text ?? "")
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ";" : ",";
  const header = splitCsvLine(lines[0], sep).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line, sep);
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? "").trim()]));
  });
}

/**
 * Whatever the portal answered → flat records. Accepts the v2.1 export (an
 * array of flat objects), the classic download (an array of
 * `{ fields: {...} }`), a v2.1 records page (`{ results: [...] }`), a v2.0
 * page (`{ records: [{ record: { fields } }] }`), and CSV text.
 */
export function recordsFromPayload(payload) {
  if (payload == null) return [];
  if (typeof payload === "string") {
    const t = payload.trim();
    if (t.startsWith("[") || t.startsWith("{")) {
      try {
        return recordsFromPayload(JSON.parse(t));
      } catch {
        return [];
      }
    }
    return parseCsv(t);
  }
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.results)
      ? payload.results
      : Array.isArray(payload.records)
        ? payload.records
        : [];
  return list
    .map((r) => r?.record?.fields ?? r?.fields ?? r)
    .filter((r) => r && typeof r === "object" && !Array.isArray(r));
}

/**
 * The column whose folded label passes `test`, or null. Labels are folded
 * once ("Gare origine - code UIC" and `gare_origine_code_uic` both become
 * "gareoriginecodeuic"), and the first key across the first records that
 * passes wins, so a sparse first record cannot hide a column.
 */
function findColumn(records, test) {
  const seen = new Set();
  for (const r of records.slice(0, 50)) {
    for (const key of Object.keys(r)) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (test(fold(key))) return key;
    }
  }
  return null;
}

/** "39,00 €" / "39.5" / 39 → 39 / 39.5; anything else → null. */
export function parseAmount(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "")
    .replace(/\s| |€|eur/gi, "")
    .replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * A French UIC station code, reduced to the seven digits that name the
 * station: SNCF writes Paris-Austerlitz as 87547000 (with a check digit), as
 * 0087547000, and in GTFS as "StopPoint:OCEINTERCITES de nuit-87547000". The
 * check digit is dropped so a seven-digit column matches too. null when the
 * value carries no plausible code.
 */
export function uicKey(code) {
  const runs = String(code ?? "").match(/\d{7,10}/g);
  if (!runs) return null;
  let digits = runs[runs.length - 1].replace(/^0+/, "");
  if (digits.length === 8) digits = digits.slice(0, 7);
  return digits.length === 7 ? digits : null;
}

// ─── Tariffs ─────────────────────────────────────────────────────────────────

/** Which column is which in the tariff dataset; null where it has none. */
export function tariffColumns(records) {
  const isUic = (k) => k.includes("uic") || k.endsWith("code");
  return {
    carrier: findColumn(records, (k) => k.includes("transporteur")),
    originName: findColumn(records, (k) => k.includes("origine") && !isUic(k)),
    originUic: findColumn(records, (k) => k.includes("origine") && isUic(k)),
    destName: findColumn(records, (k) => k.includes("destination") && !isUic(k)),
    destUic: findColumn(records, (k) => k.includes("destination") && isUic(k)),
    classLabel: findColumn(records, (k) => k.startsWith("classe") || k === "class"),
    // "Profil tarifaire" by name first: a class column may itself be called
    // "Classe tarifaire", and must not be read as the profile.
    profile:
      findColumn(records, (k) => k.includes("profil")) ??
      findColumn(records, (k) => k.includes("tarif") && !k.includes("prix") && !k.startsWith("classe")),
    // What the class sells: the live export's `type_place` ("assise" for a
    // seat). It, not the bare class, is what tells a night train's couchette
    // range from its seat range — both are "2" (first probe, 2026-10-04).
    placeType: findColumn(records, (k) => k.includes("typeplace") || (k.includes("place") && !k.includes("prix"))),
    min: findColumn(records, (k) => k.includes("prix") && k.includes("min")),
    max: findColumn(records, (k) => k.includes("prix") && k.includes("max")),
  };
}

/**
 * Tariff records → rows. Rows without both ends or without a price are
 * dropped and counted, so a renamed column reads as "every row unread" in the
 * log rather than as an empty dataset.
 */
export function readTariffRows(records) {
  const cols = tariffColumns(records);
  const rows = [];
  let unread = 0;
  for (const r of records) {
    const min = parseAmount(r[cols.min]);
    const max = parseAmount(r[cols.max]);
    const row = {
      carrier: String(r[cols.carrier] ?? "").trim(),
      originName: String(r[cols.originName] ?? "").trim(),
      originUic: uicKey(r[cols.originUic]),
      destName: String(r[cols.destName] ?? "").trim(),
      destUic: uicKey(r[cols.destUic]),
      classLabel: String(r[cols.classLabel] ?? "").trim(),
      profile: String(r[cols.profile] ?? "").trim(),
      placeType: String(r[cols.placeType] ?? "").trim(),
      min: min ?? max,
      max: max ?? min,
    };
    const hasEnds = (row.originUic || row.originName) && (row.destUic || row.destName);
    if (!hasEnds || !(row.min > 0)) {
      unread++;
      continue;
    }
    rows.push(row);
  }
  return { rows, columns: cols, unread };
}

/**
 * A profile a standard adult can buy. SNCF lists reduced and card fares in
 * the same table as the full fare, and the cheapest of them is often a
 * restricted one — read by price alone, the range would quote fares most
 * travellers cannot buy (the rule lefrecce.mjs follows for Trenitalia). An
 * empty profile is kept: nothing says it is restricted.
 */
const RESTRICTED_PROFILE = [
  "avantage", "carte", "jeune", "senior", "enfant", "reduit", "reduction", "abonn",
  "eleve", "etudiant", "apprenti", "militaire", "famille", "nombreuse", "groupe",
  "liberte", "social", "solidaire", "handicap", "pmr", "accompagn", "forfait",
  "pass", "professionnel", "agent", "fip", "conge", "remise", "promo",
];
export function isStandardAdultProfile(profile) {
  const f = fold(profile);
  if (!f) return true;
  return !RESTRICTED_PROFILE.some((w) => f.includes(w));
}

/**
 * What a fare class sells, or null when its label cannot say.
 * Returns "couchetteFirst" | "couchetteSecond" | "couchette" | "seat" | null.
 * Only couchettes are priced (see the header); "seat" is classified so it can
 * be left out on purpose rather than by accident.
 */
export function classifyTariffClass(classLabel, profile = "", placeType = "") {
  const label = fold(classLabel);
  const both = `${label} ${fold(profile)} ${fold(placeType)}`;
  const first = /(^|[^0-9])1(ere|re|er|st)?($|[^0-9])|premiere|first|1classe|classe1/.test(label);
  const second = /(^|[^0-9])2(nde|nd|de|e|eme)?($|[^0-9])|seconde|second|2classe|classe2/.test(label);
  // Folded text has no word breaks, so a bare "lit" would match inside other
  // words; only the whole label "lit" or "voiture-lit" counts.
  if (/couch|allonge|voiturelit|sleeper|berth/.test(both) || label === "lit" || fold(placeType) === "lit") {
    if (/4places|4couchettes|quatre/.test(both)) return "couchetteFirst";
    if (/6places|6couchettes|six/.test(both)) return "couchetteSecond";
    if (first && !second) return "couchetteFirst";
    if (second && !first) return "couchetteSecond";
    return "couchette";
  }
  if (/assis|siege|seat|fauteuil|inclinable/.test(both)) return "seat";
  return null;
}

/** Is a station name the one SNCF wrote? Folded words, one a prefix of the other. */
export function namesMatch(stationName, datasetName) {
  const a = foldWords(stationName);
  const b = foldWords(datasetName);
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((w, i) => long[i] === w);
}

/** The first and last stop of a trains-file train, as { name, uic }. */
export function trainEnds(train) {
  const st = Array.isArray(train?.stations) ? train.stations : [];
  if (st.length < 2) return null;
  const end = (s) => ({ name: s?.name ?? "", uic: uicKey(s?.code) });
  return { origin: end(st[0]), destination: end(st[st.length - 1]) };
}

function endMatches(end, uic, name) {
  if (end.uic && uic) return end.uic === uic;
  return namesMatch(end.name, name);
}

/**
 * The tariff rows for one oriented pair; the reverse pair when SNCF lists the
 * pair only the other way round (a full fare does not depend on direction),
 * flagged so the log can say so.
 */
export function tariffRowsForTrain(train, rows) {
  const ends = trainEnds(train);
  if (!ends) return { rows: [], reversed: false };
  const forward = rows.filter(
    (r) => endMatches(ends.origin, r.originUic, r.originName) && endMatches(ends.destination, r.destUic, r.destName),
  );
  if (forward.length) return { rows: forward, reversed: false };
  const backward = rows.filter(
    (r) => endMatches(ends.origin, r.destUic, r.destName) && endMatches(ends.destination, r.originUic, r.originName),
  );
  return { rows: backward, reversed: backward.length > 0 };
}

/**
 * One train's fare from the tariff rows, in the shape every priced source
 * writes (`fare` on the train; see stampOfficialFares):
 *   { fromPrice, currency, seatClass, classes: { couchetteSecond: 39 },
 *     classMax: { couchetteSecond: 75 }, basis: "tariff", sampledAt }
 * `classes` holds each class's minimum and `classMax` its maximum: the range
 * is the standard fare as it moves with demand, which is what SNCF publishes.
 * Returns { fare | null, why } — `why` names the refusal for the log.
 */
export function fareFromTariffs(train, rows, { today = null, modified = null } = {}) {
  const { rows: pairRows, reversed } = tariffRowsForTrain(train, rows);
  if (!pairRows.length) return { fare: null, why: "no tariff row for this origin–destination" };
  // The live export files each row under its service ("Intercités de nuit à
  // réservation obligatoire" / "… de jour …"): where it says, keep the night
  // train's. Paris–Toulouse carries both, and a day train's 1st class is not
  // a couchette whatever else a row says.
  const night = pairRows.filter((r) => /nuit|night/.test(fold(r.carrier)));
  const matched = night.length ? night : pairRows;
  const classes = {};
  const classMax = {};
  const skipped = { restricted: 0, seat: 0, ambiguous: [] };
  for (const r of matched) {
    if (!isStandardAdultProfile(r.profile)) {
      skipped.restricted++;
      continue;
    }
    const key = classifyTariffClass(r.classLabel, r.profile, r.placeType);
    if (key === "seat") {
      skipped.seat++;
      continue;
    }
    if (!key) {
      skipped.ambiguous.push([r.classLabel || "(no class)", r.placeType].filter(Boolean).join(" "));
      continue;
    }
    classes[key] = Math.min(classes[key] ?? Infinity, r.min);
    classMax[key] = Math.max(classMax[key] ?? 0, r.max);
  }
  const keys = Object.keys(classes);
  if (!keys.length) {
    const amb = [...new Set(skipped.ambiguous)];
    return {
      fare: null,
      why:
        `${matched.length} row(s), none a berth` +
        (amb.length ? ` (classes that do not say: ${amb.join(", ")})` : "") +
        (skipped.seat ? `, ${skipped.seat} seat` : "") +
        (skipped.restricted ? `, ${skipped.restricted} restricted profile` : ""),
    };
  }
  const seatClass = keys.reduce((a, b) => (classes[b] < classes[a] ? b : a));
  return {
    fare: {
      fromPrice: classes[seatClass],
      currency: "EUR",
      seatClass,
      classes,
      classMax,
      basis: "tariff",
      sampledAt: today,
      ...(modified ? { tariffModified: modified } : {}),
    },
    why: reversed ? "priced from the reverse pair" : "",
  };
}

// ─── Punctuality ─────────────────────────────────────────────────────────────

/** Which column is which in the punctuality dataset. */
export function punctualityColumns(records) {
  return {
    date: findColumn(records, (k) => k === "date" || k.startsWith("date") || k === "mois" || k.includes("periode")),
    axis: findColumn(records, (k) => k === "axe" || k.startsWith("axe")),
    departure: findColumn(records, (k) => k.startsWith("depart") || k.includes("garededepart") || k === "origine"),
    arrival: findColumn(records, (k) => k.startsWith("arrivee") || k.includes("garedarrivee") || k === "destination"),
    scheduled: findColumn(records, (k) => k.includes("programme")),
    ran: findColumn(records, (k) => k.includes("circule")),
    cancelled: findColumn(records, (k) => k.includes("annule")),
    late: findColumn(records, (k) => k.includes("retard") && k.includes("nombre") && !k.includes("heure")),
    rate: findColumn(records, (k) => k.includes("taux") && k.includes("regularite")),
  };
}

const FRENCH_MONTHS = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};

/** "2026-08", "2026-08-01", "08/2026", "août 2026" → "2026-08"; else null. */
export function monthKey(v) {
  const s = String(v ?? "").trim();
  let m = /^(\d{4})[-/](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}`;
  m = /^(\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return `${m[2]}-${m[1].padStart(2, "0")}`;
  const words = foldWords(s);
  const month = words.map((w) => FRENCH_MONTHS[w]).find(Boolean);
  const year = words.find((w) => /^\d{4}$/.test(w));
  return month && year ? `${year}-${String(month).padStart(2, "0")}` : null;
}

/** Punctuality records → rows; unreadable ones counted, as for tariffs. */
export function readPunctualityRows(records) {
  const cols = punctualityColumns(records);
  const rows = [];
  let unread = 0;
  for (const r of records) {
    const num = (c) => {
      const n = parseAmount(r[c]);
      return Number.isFinite(n) ? n : null;
    };
    const row = {
      month: monthKey(r[cols.date]),
      axis: String(r[cols.axis] ?? "").trim(),
      departure: String(r[cols.departure] ?? "").trim(),
      arrival: String(r[cols.arrival] ?? "").trim(),
      scheduled: num(cols.scheduled),
      ran: num(cols.ran),
      cancelled: num(cols.cancelled),
      late: num(cols.late),
      rate: num(cols.rate),
    };
    if (!row.month || !row.departure || !row.arrival || !(row.ran > 0) || row.late == null) {
      unread++;
      continue;
    }
    rows.push(row);
  }
  return { rows, columns: cols, unread };
}

/** "8754700|8761183" — an unordered station pair, for the day-service gate. */
export function pairKey(a, b) {
  return [a, b].sort().join("|");
}

/** Months covered by the trailing figure. */
export const TRAILING_MONTHS = 12;
/**
 * A train's latest month may trail the dataset's own latest by this much and
 * no more: a line the AQST stopped reporting (Paris–Latour-de-Carol's last
 * month was February when the rest reached May) is not quoted as current.
 */
export const MAX_LAG_BEHIND_DATASET = 1;
/** …and never older than this, however late SNCF publishes (it runs ~5 months behind). */
export const MAX_MONTH_AGE = 12;

/** The latest month any row carries — the dataset's own "now". */
export function latestMonth(rows) {
  return (rows || []).reduce((m, r) => (r.month > m ? r.month : m), "");
}

/**
 * Does an AQST end name this station? SNCF writes a joined train as both its
 * ends ("ALBI/RODEZ", "PARIS-AUSTERLITZ → RODEZ/ALBI"): the Rodez and Albi
 * portions run as one train, so either half names it.
 */
function aqstEndMatches(stationName, aqstName) {
  return String(aqstName ?? "")
    .split("/")
    .some((part) => namesMatch(stationName, part));
}

const monthIndex = (key) => {
  const m = /^(\d{4})-(\d{2})$/.exec(key ?? "");
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
};
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * One train's punctuality, or { value: null, why }.
 *
 * The AQST row is matched to the train's own two ends, in the train's
 * direction (the AQST counts arrivals, so Paris→Briançon and Briançon→Paris
 * are different figures). A pair a daytime Intercités also runs is refused
 * outright — see the header. The latest month must be recent, both against
 * the dataset's own latest month (MAX_LAG_BEHIND_DATASET) and against today
 * (MAX_MONTH_AGE), and the trailing figure is summed from the counts rather
 * than averaged from the rates, so a month with three trains does not weigh
 * as much as one with thirty.
 */
export function punctualityForTrain(
  train,
  rows,
  { dayServedPairs = new Set(), today = null, datasetLatest = latestMonth(rows) } = {},
) {
  const ends = trainEnds(train);
  if (!ends) return { value: null, why: "no endpoints" };
  if (ends.origin.uic && ends.destination.uic && dayServedPairs.has(pairKey(ends.origin.uic, ends.destination.uic))) {
    return { value: null, why: "a daytime Intercités runs the same pair" };
  }
  // A row naming exactly this pair beats one naming a joined train: Cerbère
  // has its own row now and a "TOULOUSE-MATABIAU/CERBERE" one from before 2022.
  const exact = rows.filter(
    (r) => namesMatch(ends.origin.name, r.departure) && namesMatch(ends.destination.name, r.arrival),
  );
  const matched = exact.length
    ? exact
    : rows.filter(
        (r) => aqstEndMatches(ends.origin.name, r.departure) && aqstEndMatches(ends.destination.name, r.arrival),
      );
  if (!matched.length) return { value: null, why: "no AQST row for this origin–destination" };

  // One row per month (sum duplicates: an axis split in two the same month).
  const byMonth = new Map();
  for (const r of matched) {
    const acc = byMonth.get(r.month) ?? { month: r.month, scheduled: 0, ran: 0, cancelled: 0, late: 0 };
    acc.scheduled += r.scheduled ?? 0;
    acc.ran += r.ran;
    acc.cancelled += r.cancelled ?? 0;
    acc.late += r.late;
    byMonth.set(r.month, acc);
  }
  const months = [...byMonth.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
  const latest = months[0];
  const todayMonth = today ? monthIndex(String(today).slice(0, 7)) : null;
  if (todayMonth != null && todayMonth - monthIndex(latest.month) > MAX_MONTH_AGE) {
    return { value: null, why: `latest month ${latest.month} is too old` };
  }
  if (datasetLatest && monthIndex(datasetLatest) - monthIndex(latest.month) > MAX_LAG_BEHIND_DATASET) {
    return { value: null, why: `last reported ${latest.month}, while the dataset runs to ${datasetLatest}` };
  }
  const window = months.filter((m) => monthIndex(latest.month) - monthIndex(m.month) < TRAILING_MONTHS);
  const ran = window.reduce((s, m) => s + m.ran, 0);
  const late = window.reduce((s, m) => s + m.late, 0);
  const scheduled = window.reduce((s, m) => s + m.scheduled, 0);
  const cancelled = window.reduce((s, m) => s + m.cancelled, 0);
  return {
    value: {
      month: latest.month,
      onTimeRate: round1(((latest.ran - latest.late) / latest.ran) * 100),
      ran: latest.ran,
      late: latest.late,
      cancelled: latest.cancelled,
      scheduled: latest.scheduled,
      trailing: {
        months: window.length,
        from: window[window.length - 1].month,
        to: latest.month,
        onTimeRate: round1(((ran - late) / ran) * 100),
        ran,
        late,
        cancelled,
        scheduled,
      },
      // A journey over 3h is late from 15 minutes (AQST's composite rule);
      // every night train is over 3h.
      lateAfterMinutes: 15,
      source: PUNCTUALITY_DATASET,
      sampledAt: today,
    },
    why: "",
  };
}
