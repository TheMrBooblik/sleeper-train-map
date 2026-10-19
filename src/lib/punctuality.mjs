/**
 * A night train's punctuality, as the connection pages print it.
 *
 * The figure is the operator's own: SNCF publishes, per month and per
 * origin–destination, how many trains ran and how many reached the terminus
 * late (scripts/lib/sncf-open-data.mjs reads it, and only for a pair no day
 * train shares). A row carries it as `punctuality_{dir}`:
 *   { month: "2026-08", onTimeRate: 84.2, ran, late, cancelled, scheduled,
 *     trailing: { months, from, to, onTimeRate, ran, late, cancelled },
 *     lateAfterMinutes: 15, source, sampledAt }
 *
 * Dependency-free `.mjs`, and month names from a fixed table rather than Intl:
 * the strings are server-rendered and must read the same after hydration.
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-08" → "August 2026", or "". */
export function formatMonth(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key ?? ""));
  const name = m && MONTHS[Number(m[2]) - 1];
  return name ? `${name} ${m[1]}` : "";
}

/** Where the figure comes from, for a source line under it. */
export const PUNCTUALITY_SOURCES = {
  "regularite-mensuelle-intercites": {
    label: "SNCF open data, Régularité mensuelle Intercités",
    url: "https://ressources.data.sncf.com/explore/dataset/regularite-mensuelle-intercites/",
  },
};

const pct = (n) => `${Math.round(n)}%`;

/**
 * Plain strings for one direction, or null when the row carries no usable
 * figure:
 *   { rate: 84.2, headline: "84% on time",
 *     detail: "27 of 32 trains in August 2026 arrived within 15 minutes of schedule",
 *     trailing: "79% over the last 12 months (352 trains)" | "",
 *     cancelled: "1 cancelled that month" | "",
 *     sourceLabel, sourceUrl }
 */
export function punctualitySummary(p) {
  if (!p || !Number.isFinite(p.onTimeRate) || !(p.ran > 0)) return null;
  const month = formatMonth(p.month);
  if (!month) return null;
  const onTime = Math.max(0, p.ran - (p.late ?? 0));
  const minutes = Number.isFinite(p.lateAfterMinutes) ? p.lateAfterMinutes : 15;
  const t = p.trailing;
  // A trailing figure over one month is the latest month again; say it only
  // when it covers more.
  const trailing =
    t && t.months > 1 && Number.isFinite(t.onTimeRate) && t.ran > 0
      ? `${pct(t.onTimeRate)} over the last ${t.months} months (${t.ran} trains)`
      : "";
  const trailingShort = trailing ? `${pct(t.onTimeRate)} over the last ${t.months} months` : "";
  const source = PUNCTUALITY_SOURCES[p.source] ?? null;
  return {
    rate: p.onTimeRate,
    month: p.month,
    monthLabel: month,
    onTime,
    ran: p.ran,
    minutes,
    headline: `${pct(p.onTimeRate)} on time`,
    detail: `${onTime} of ${p.ran} ${p.ran === 1 ? "train" : "trains"} in ${month} arrived within ${minutes} minutes of schedule`,
    trailing,
    trailingShort,
    cancelled: p.cancelled > 0 ? `${p.cancelled} cancelled that month` : "",
    sourceLabel: source?.label ?? "",
    sourceUrl: source?.url ?? "",
  };
}

/**
 * The FAQ answer for "Is the night train from A to B on time?", from every
 * direction on the corridor that carries a figure, or "" when none does.
 * @param {{origin: string, destination: string, punctuality: object}[]} directions
 */
export function punctualityAnswer(directions) {
  const parts = (directions || [])
    .map((d) => ({ d, s: punctualitySummary(d?.punctuality) }))
    .filter((x) => x.s);
  if (!parts.length) return "";
  const sentences = parts.map(
    ({ d, s }) =>
      `${s.onTime} of ${s.ran} ${d.origin} → ${d.destination} ${s.ran === 1 ? "train" : "trains"} in ` +
      `${s.monthLabel} arrived within ${s.minutes} minutes of schedule ` +
      `(${pct(s.rate)}${s.trailingShort ? `; ${s.trailingShort}` : ""}).`,
  );
  return `${sentences.join(" ")} These are the operator's own monthly figures, measured at the terminus.`;
}
