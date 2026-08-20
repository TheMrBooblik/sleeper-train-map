// scripts/lib/es-timetable.mjs
// Parser for European Sleeper's own published timetable
// (https://www.europeansleeper.eu/timetable), which is the operator's source of
// truth for which stations a train calls at and when. The Mobility Database
// GTFS feed still supplies track geometry, but its times drift from what the
// operator publishes and it disagrees outright about where some trains start:
// the feed runs ES 474 out of Berlin-Spandau at 17:52 while the operator runs
// it out of Berlin Gesundbrunnen at 17:25.
//
// The page is plain server-rendered HTML — no framework payload to read — so
// this parses the markup directly. Each train renders as
//
//   <div … id="474">
//     <h3 …>Train ES 474</h3>
//     <table …>
//       <tr><td>Berlin Gesundbrunnen</td><td>…</td><td>Paris Nord</td></tr>
//       <tr><td>Wed 19 August 2026</td><td></td><td>Thu 20 August 2026</td></tr>
//     </table>
//     <div class="margin-auto stops">
//       <div class="flex margin-top">
//         <b>17:25</b>
//         <span class="flex-col stop">Berlin Gesundbrunnen</span>
//       </div>
//       <div class="flex margin-top">
//         <b>21:55</b>
//         <span class="flex-col stop">Hamburg-Harburg<i …>Arrival 21:47</i></span>
//       </div>
//       …
//       <div class="flex margin-top">
//         <b>11:23</b>
//         <span class="flex-col stop stop-last">Paris Nord</span>
//       </div>
//     </div>
//   </div>
//
// The bold time is the DEPARTURE at every stop except the last, where it is the
// arrival; intermediate stops carry their arrival in the trailing <i>. Pure
// module — no network, no fs — so tests run it against a committed fixture.

const WEEKDAYS = {
  monday: "mon",
  tuesday: "tue",
  wednesday: "wed",
  thursday: "thu",
  friday: "fri",
  saturday: "sat",
  sunday: "sun",
};

/** Strip tags and collapse whitespace/entities to a plain trimmed string. */
function text(html) {
  return String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}

/** "17:25" from a bold cell, or null when it holds no clock time. */
function clock(html) {
  const m = /\b(\d{1,2}):(\d{2})\b/.exec(text(html));
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23 || Number(m[2]) > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/**
 * One train's rendered timetable block → its ordered stop list.
 *
 * @param {string} block  HTML from the block's <h3> to the end of its .stops div
 * @returns {{name: string, arrival: string|null, departure: string|null}[]}
 */
function stopsFromBlock(block) {
  const stopsAt = block.search(/<div[^>]+class="[^"]*\bstops\b[^"]*"/);
  const region = stopsAt === -1 ? block : block.slice(stopsAt);

  const stops = [];
  const entry = /<b>([\s\S]*?)<\/b>\s*<span[^>]+class="([^"]*)"[^>]*>([\s\S]*?)<\/span>/g;
  for (const m of region.matchAll(entry)) {
    const bold = clock(m[1]);
    const classes = m[2] ?? "";
    const inner = m[3] ?? "";

    // The trailing <i>Arrival HH:MM</i>, when the stop has one.
    const arrivalNote = /Arrival\s*(\d{1,2}:\d{2})/i.exec(text(inner));
    const name = text(inner.replace(/<i[\s\S]*?<\/i>/g, ""));
    if (!name) continue;

    const isLast = /\bstop-last\b/.test(classes);
    stops.push({
      name,
      // Last stop: the bold time is the arrival and there is nothing after it.
      arrival: isLast ? bold : (arrivalNote ? arrivalNote[1].padStart(5, "0") : null),
      departure: isLast ? null : bold,
    });
  }

  // First stop shows only a departure; anything the page left blank stays null
  // rather than being invented from the neighbouring column.
  if (stops.length && stops[0].arrival && !stops[0].departure) {
    stops[0] = { ...stops[0], departure: stops[0].arrival, arrival: null };
  }
  return stops;
}

/**
 * Service days stated in the page's prose, per train.
 *
 * Only the sentences that name their train are read ("Train ES 452 (Prague >
 * Brussels) departs on Tuesday, Thursday and Sunday."). The Brussels–Milan
 * paragraph names directions but not train numbers, so those fall through to
 * the caller's fallback rather than being guessed at.
 *
 * @param {string} html
 * @returns {Record<string, string[]>} bare train number → ["tue","thu","sun"]
 */
export function serviceDaysFromHtml(html) {
  const out = {};
  const sentence = /Train\s+ES\s*(\d{3,5})[^.]*?departs\s+on\s+([^.]+)\./gi;
  for (const m of text(html).matchAll(sentence)) {
    const days = [];
    for (const [name, short] of Object.entries(WEEKDAYS)) {
      if (new RegExp(`\\b${name}\\b`, "i").test(m[2])) days.push(short);
    }
    if (days.length) {
      const order = Object.values(WEEKDAYS);
      out[m[1]] = days.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    }
  }
  return out;
}

/**
 * Every train the page renders a timetable for.
 *
 * @param {string} html  The timetable page
 * @returns {{train: string, number: string, origin: string|null,
 *   destination: string|null, stops: {name, arrival, departure}[],
 *   daysOfWeek: string[]|null}[]}
 */
export function parseTimetableHtml(html) {
  const source = String(html ?? "");
  const days = serviceDaysFromHtml(source);

  // Blocks are delimited by their headings, so a layout change around them
  // (wrapper divs, ordering) doesn't break the split.
  const heads = [...source.matchAll(/<h3[^>]*>\s*Train\s+ES\s*(\d{3,5})\s*<\/h3>/gi)];
  const journeys = [];

  for (const [i, head] of heads.entries()) {
    const from = head.index + head[0].length;
    const to = i + 1 < heads.length ? heads[i + 1].index : source.length;
    const block = source.slice(from, to);
    const number = head[1];

    const stops = stopsFromBlock(block);
    if (stops.length < 2) continue;

    // The header table repeats the endpoints; used only as a cross-check, since
    // the stop list is the authority on both order and naming.
    const headerRow = /<tr>([\s\S]*?)<\/tr>/i.exec(block);
    const cells = headerRow ? [...headerRow[1].matchAll(/<td>([\s\S]*?)<\/td>/gi)].map((c) => text(c[1])) : [];

    journeys.push({
      train: `ES ${number}`,
      number,
      origin: cells[0] || null,
      destination: cells[cells.length - 1] || null,
      stops,
      daysOfWeek: days[number] ?? null,
    });
  }

  return journeys;
}
