// lib/calendar.mjs
// One canonical representation for "when does this train run", with parsers
// from the two encodings in the wild and a renderer back to the BoT-style
// display string the UI already shows. Pure and dependency-free.
//
// Canonical shape:
//   { validFrom: "YYYY-MM-DD"|null, validUntil: "YYYY-MM-DD"|null,
//     daysOfWeek: ["mon".."sun"], exceptions: [], note: string|null,
//     raw: string|null }
// `raw` preserves the source string verbatim so unparseable inputs round-trip
// unchanged (renderCalendar prefers structure, falls back to raw).

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
    note: null,
    raw: null,
  };
}

// "2026: Mon, Wed, Fri" | "2026: Daily" | "2026/06/22-08/30: Daily" | "Daily"
// Unrecognised input → { note/raw } so nothing is ever lost.
export function parseBotServiceString(input) {
  const cal = emptyCalendar();
  if (input == null || typeof input !== "string" || !input.trim()) return cal;
  const raw = input.trim();
  cal.raw = raw;

  let daysPart = raw;
  const colonIdx = raw.indexOf(":");
  if (colonIdx !== -1) {
    const prefix = raw.slice(0, colonIdx).trim();
    daysPart = raw.slice(colonIdx + 1).trim();

    // "2026" or "2026/06/22-08/30" (a season within one year)
    const seasonMatch = prefix.match(
      /^(\d{4})\/(\d{2})\/(\d{2})-(\d{2})\/(\d{2})$/,
    );
    const yearMatch = prefix.match(/^(\d{4})$/);
    if (seasonMatch) {
      const [, year, m1, d1, m2, d2] = seasonMatch;
      cal.validFrom = `${year}-${m1}-${d1}`;
      cal.validUntil = `${year}-${m2}-${d2}`;
    } else if (yearMatch) {
      cal.validFrom = `${yearMatch[1]}-01-01`;
      cal.validUntil = `${yearMatch[1]}-12-31`;
    } else {
      // Unrecognised prefix — keep whole string as note.
      cal.note = raw;
      return cal;
    }
  }

  if (/^daily$/i.test(daysPart)) {
    cal.daysOfWeek = [...DAY_KEYS];
    return cal;
  }

  const days = daysPart
    .split(",")
    .map((d) => LABEL_TO_KEY[d.trim().toLowerCase()])
    .filter(Boolean);
  if (days.length > 0 && days.length === daysPart.split(",").length) {
    // Preserve canonical week order regardless of input order.
    cal.daysOfWeek = DAY_KEYS.filter((d) => days.includes(d));
    return cal;
  }

  cal.note = raw;
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

// Render back to the BoT-style display string ("2026: Mon, Wed, Fri").
// Structure wins; raw is the fallback for inputs we couldn't parse.
export function renderCalendar(cal) {
  if (!cal) return null;
  if (cal.note) return cal.note;

  const days =
    cal.daysOfWeek?.length === 7
      ? "Daily"
      : (cal.daysOfWeek ?? []).map((d) => DAY_LABELS[d]).filter(Boolean).join(", ");
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
