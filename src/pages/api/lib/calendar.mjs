// lib/calendar.mjs
// One canonical representation for "when does this train run", with parsers
// from the two encodings in the wild and a renderer back to the BoT-style
// display string the UI already shows. Pure and dependency-free.
//
// Canonical shape:
//   { validFrom: "YYYY-MM-DD"|null, validUntil: "YYYY-MM-DD"|null,
//     daysOfWeek: ["mon".."sun"], exceptions: [], cadence: string|null,
//     note: string|null, raw: string|null }
// `raw` preserves the source string verbatim so unparseable inputs round-trip
// unchanged (renderCalendar prefers structure, falls back to raw).
//
// `cadence` is the third answer between "runs on these weekdays" and "no idea":
// a string like "Every 2nd day" states how OFTEN a train runs without saying
// WHICH days, so no weekday list can be derived and no caller may pretend one.
// It exists because 52 of the payload's 545 legs say exactly that, and a reader
// that only knows daysOfWeek has to either invent a schedule or discard a real
// fact. Callers asking "does it run on date D" must answer "unknown" for these,
// never "yes" — see src/lib/plan/availability.mjs.

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABELS = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const LABEL_TO_KEY = Object.fromEntries(
  Object.entries(DAY_LABELS).map(([k, v]) => [v.toLowerCase(), k]),
);

export function emptyCalendar() {
  return {
    validFrom: null,
    validUntil: null,
    daysOfWeek: [],
    exceptions: [],
    cadence: null,
    note: null,
    raw: null,
  };
}

// Day spellings beyond the canonical three-letter labels. Back-on-Track is
// compiled by hand from operator timetables in a dozen languages, so the full
// English name and the odd German slip both appear ("Son" is Sonntag).
const DAY_ALIASES = {
  monday: "mon", tuesday: "tue", wednesday: "wed", thursday: "thu",
  friday: "fri", saturday: "sat", sunday: "sun",
  son: "sun", sonntag: "sun", montag: "mon", dienstag: "tue",
  mittwoch: "wed", donnerstag: "thu", freitag: "fri", samstag: "sat",
};

/** One day token → canonical key, or undefined. */
function dayKeyFor(token) {
  const t = String(token).trim().toLowerCase().replace(/\.$/, "");
  return LABEL_TO_KEY[t] || DAY_ALIASES[t];
}

/**
 * Cadence phrasings that state a FREQUENCY without naming days. Kept verbatim
 * in `cadence` so the string still renders, while daysOfWeek stays empty —
 * there is no honest weekday list to derive from "every 2nd day".
 */
const CADENCE_RE = /^(every\s+\d+(?:st|nd|rd|th)?\s+day|every\s+other\s+day|\d+(?:\s*[-–]\s*\d+)?\s+times?\s+per\s+week|\d+(?:\s*[-–]\s*\d+)?\s*x\s*(?:per\s+)?week)$/i;

/** "YYYY-MM-DD"/"YYYY/MM/DD" → ISO, or null. */
function isoDate(year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * The validity prefix before the colon. Four shapes occur in the payload:
 *   "2026"                        a whole year
 *   "2026/06/22-08/30"            a season inside one year
 *   "2026/06/13-2026/09/06"       the same with the year repeated
 *   "2026-12-14 – 2027-09-06"     a cross-year window
 * The last one is the shape renderCalendar itself emits for a range spanning
 * two years, so before it was read here the module could not re-read its own
 * output — six legs in the published payload arrived as unparseable notes for
 * exactly that reason.
 * @returns {{validFrom: string, validUntil: string}|null}
 */
function parseValidityPrefix(prefix) {
  let m = prefix.match(/^(\d{4})$/);
  if (m) return { validFrom: `${m[1]}-01-01`, validUntil: `${m[1]}-12-31` };

  m = prefix.match(/^(\d{4})\/(\d{2})\/(\d{2})\s*[-–]\s*(?:(\d{4})\/)?(\d{2})\/(\d{2})$/);
  if (m) {
    const [, y1, m1, d1, y2, m2, d2] = m;
    const from = isoDate(y1, m1, d1);
    const until = isoDate(y2 || y1, m2, d2);
    return from && until ? { validFrom: from, validUntil: until } : null;
  }

  m = prefix.match(/^(\d{4})-(\d{2})-(\d{2})\s*[-–—]\s*(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [, y1, m1, d1, y2, m2, d2] = m;
    const from = isoDate(y1, m1, d1);
    const until = isoDate(y2, m2, d2);
    return from && until ? { validFrom: from, validUntil: until } : null;
  }

  return null;
}

/**
 * The part after the colon. "Daily", a day list, "Daily, except Sat" — the
 * exception form is 25 legs of the payload and is fully determinable, so it
 * resolves to the six days it actually means rather than to a note.
 * @returns {{daysOfWeek?: string[], cadence?: string}|null}
 */
function parseDaysPart(daysPart) {
  if (/^daily$/i.test(daysPart)) return { daysOfWeek: [...DAY_KEYS] };

  const except = daysPart.match(/^daily,?\s*(?:except|but not|excl\.?)\s+(.+)$/i);
  if (except) {
    const excluded = except[1].split(/\s*(?:,|and|\/|&)\s*/i).map(dayKeyFor);
    if (excluded.length && excluded.every(Boolean)) {
      return { daysOfWeek: DAY_KEYS.filter((d) => !excluded.includes(d)) };
    }
    return null;
  }

  if (CADENCE_RE.test(daysPart)) return { cadence: daysPart };

  const tokens = daysPart.split(",");
  const days = tokens.map((d) => dayKeyFor(d)).filter(Boolean);
  if (days.length > 0 && days.length === tokens.length) {
    // Preserve canonical week order regardless of input order.
    return { daysOfWeek: DAY_KEYS.filter((d) => days.includes(d)) };
  }

  return null;
}

// "2026: Mon, Wed, Fri" | "2026: Daily" | "2026/06/22-08/30: Daily" |
// "2026-12-14 – 2027-09-06: Mon, Wed, Fri" | "2026: Daily, except Sat" |
// "2026: Every 2nd day" | "Daily"
// Unrecognised input → { note/raw } so nothing is ever lost.
export function parseBotServiceString(input) {
  const cal = emptyCalendar();
  if (input == null || typeof input !== "string" || !input.trim()) return cal;
  const raw = input.trim();
  cal.raw = raw;

  let daysPart = raw;
  // Split on the LAST colon, so an ISO prefix ("2026-12-14 – 2027-09-06") is
  // not cut at a colon it does not contain while a time-like one still is.
  const colonIdx = raw.lastIndexOf(":");
  if (colonIdx !== -1) {
    const prefix = raw.slice(0, colonIdx).trim();
    daysPart = raw.slice(colonIdx + 1).trim();

    const validity = parseValidityPrefix(prefix);
    if (!validity) {
      // Unrecognised prefix — keep whole string as note.
      cal.note = raw;
      return cal;
    }
    cal.validFrom = validity.validFrom;
    cal.validUntil = validity.validUntil;
  }

  const parsed = parseDaysPart(daysPart);
  if (!parsed) {
    cal.note = raw;
    return cal;
  }
  if (parsed.daysOfWeek) cal.daysOfWeek = parsed.daysOfWeek;
  if (parsed.cadence) cal.cadence = parsed.cadence;
  return cal;
}

// GTFS calendar.txt row: { monday..sunday: "1"|"0"|1|0, start_date: "YYYYMMDD", end_date }
export function parseGtfsCalendar(row) {
  const cal = emptyCalendar();
  if (!row || typeof row !== "object") return cal;
  const gtfsDays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  cal.daysOfWeek = DAY_KEYS.filter(
    (_, i) => Number(row[gtfsDays[i]]) === 1,
  );
  const toIso = (v) => {
    const m = String(v ?? "").match(/^(\d{4})(\d{2})(\d{2})$/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  };
  cal.validFrom = toIso(row.start_date);
  cal.validUntil = toIso(row.end_date);
  return cal;
}

/** The weekday half of the display string, or "" when there is nothing to say. */
function renderDays(cal) {
  const days = cal.daysOfWeek ?? [];
  if (days.length === 7) return "Daily";
  // Six days reads far better as the exception than as a list of six, and it is
  // also how the source writes it — so this is the exact inverse of the
  // "Daily, except X" parse rather than a lossy normalisation of it.
  if (days.length === 6) {
    const missing = DAY_KEYS.find((d) => !days.includes(d));
    return `Daily, except ${DAY_LABELS[missing]}`;
  }
  return days.map((d) => DAY_LABELS[d]).filter(Boolean).join(", ");
}

// Render back to the BoT-style display string ("2026: Mon, Wed, Fri").
// Structure wins; raw is the fallback for inputs we couldn't parse.
export function renderCalendar(cal) {
  if (!cal) return null;
  if (cal.note) return cal.note;

  // A cadence stands in for the weekday list — it is what the source said, and
  // there is no day list to render instead.
  const days = cal.cadence || renderDays(cal);
  if (!days) return cal.raw ?? null;

  const f = cal.validFrom;
  const u = cal.validUntil;
  if (f && u) {
    const [fy, fm, fd] = f.split("-");
    const [uy, um, ud] = u.split("-");
    if (fy === uy) {
      if (fm === "01" && fd === "01" && um === "12" && ud === "31") {
        return `${fy}: ${days}`;
      }
      return `${fy}/${fm}/${fd}-${um}/${ud}: ${days}`;
    }
    return `${f} – ${u}: ${days}`;
  }
  return days;
}
