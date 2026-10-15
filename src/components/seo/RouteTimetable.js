import { useState } from "react";
import { FiExternalLink } from "react-icons/fi";
import FareCalendar from "./FareCalendar";
import { formatNight } from "../../lib/fareCalendarView.mjs";
import { stopsForNight } from "../../lib/nightTimes.mjs";

/**
 * Resolve the clock time to show against a stop. Stops are { name, arrival,
 * departure } objects (legacy string stops are tolerated). The first stop shows
 * its departure, the last its arrival, intermediate stops whichever is known.
 */
function stopTime(stop, isFirst, isLast) {
  if (typeof stop === "string") return "";
  const dep = stop.departure || "";
  const arr = stop.arrival || "";
  if (isFirst) return dep || arr;
  if (isLast) return arr || dep;
  return arr || dep;
}

const stopName = (stop) => (typeof stop === "string" ? stop : stop.name);

/**
 * Static timetable for one direction of a route: header (train number, endpoints,
 * times, days) + the ordered stop list with per-stop times where the operator feed
 * provides them (otherwise just origin departure / destination arrival).
 *
 * Choosing a night in the fare calendar retimes it to that night where the
 * calendar knows the night's own clock (Nightjet's, src/lib/nightTimes.mjs):
 * the published times are one run's, and a works night leaves an hour later.
 * Until a night is chosen the page shows the published run, so the static
 * HTML keeps every stop's time.
 */
export default function RouteTimetable({ direction, bookingHref = null }) {
  const [pickedDate, setPickedDate] = useState(null);
  if (!direction) return null;
  const {
    trainNumber,
    origin,
    destination,
    departureTime,
    arrivalTime,
    stops,
    serviceDays,
    irregularities,
    scheduleUrl,
    scheduleLabel,
    scheduleAffiliate,
    fare,
    fareCalendar,
    punctuality,
    nextDepartureText,
  } = direction;
  const pickedNight = pickedDate
    ? (fareCalendar?.days ?? []).find((d) => d.date === pickedDate) ?? null
    : null;
  const timedCalendar = (fareCalendar?.days ?? []).some((d) => d.dep);
  const retimed =
    pickedNight?.dep && pickedNight?.arr
      ? stopsForNight(stops, { departure: pickedNight.dep, arrival: pickedNight.arr })
      : null;
  const shownStops = retimed?.stops ?? stops;
  const shownDeparture = retimed?.departure ?? departureTime;
  const shownArrival = retimed?.arrival ?? arrivalTime;
  const lastIdx = shownStops.length - 1;

  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-lg font-semibold text-white">
          {origin} → {destination}
        </h3>
        {trainNumber && (
          <span className="font-mono text-sm text-primary-green">{trainNumber}</span>
        )}
      </div>

      {/* Out of season: the times below are next season's, and the first
          thing to say is when that is. */}
      {nextDepartureText && (
        <p className="mt-2 text-sm font-medium text-amber-300" data-testid="next-departure">
          Next departure {nextDepartureText}
        </p>
      )}

      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-white/60">
        {shownDeparture && <span>Departs {shownDeparture}</span>}
        {shownArrival && <span>Arrives {shownArrival}</span>}
        {retimed && <span>on {formatNight(pickedNight.date)}</span>}
        {serviceDays && <span>{serviceDays}</span>}
      </div>

      {/* This train's official fares: a night-by-night calendar where the
          source prices every night (lefrecce), else one chip per berth class
          (e.g. 12306's hard and soft sleeper), cheapest first. The facts tile
          above carries the route-wide "from". */}
      {fareCalendar ? (
        <FareCalendar
          calendar={fareCalendar}
          trainNumber={trainNumber}
          bookingHref={bookingHref}
          onPick={timedCalendar ? setPickedDate : undefined}
        />
      ) : (
        fare?.classes?.length > 0 && (
          <div className="mt-4" data-testid="route-fares">
            <div className="text-xs uppercase tracking-wide text-white/40">Fares</div>
            <ul className="mt-2 flex flex-wrap gap-2">
              {fare.classes.map((c) => (
                <li
                  key={c.key}
                  className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-white/70"
                >
                  {c.label}{" "}
                  <span className="font-medium text-white">{c.price}</span>
                  {c.eur && <span className="text-white/40"> ({c.eur})</span>}
                </li>
              ))}
            </ul>
            {fare.checkedLabel && (
              <p className="mt-2 text-xs text-white/40">
                {fare.basisLabel || "Official fare"}
                {fare.travelLabel ? ` ${fare.travelLabel}` : ""} ·{" "}
                {fare.checkedLabel}
              </p>
            )}
          </div>
        )
      )}

      {/* The operator's own monthly punctuality for this train, where it
          publishes one that is this train's alone (SNCF's AQST figures). */}
      {punctuality && (
        <div className="mt-4" data-testid="route-punctuality">
          <div className="text-xs uppercase tracking-wide text-white/40">Punctuality</div>
          <p className="mt-1 text-sm text-white/70">
            <span className="font-medium text-white">{punctuality.headline}</span>
            {" — "}
            {punctuality.detail}
            {punctuality.cancelled ? `, ${punctuality.cancelled}` : ""}.
            {punctuality.trailing ? ` ${punctuality.trailing}.` : ""}
          </p>
          {punctuality.sourceLabel && (
            <p className="mt-1 text-xs text-white/40">
              {punctuality.sourceUrl ? (
                <a
                  href={punctuality.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-white/70 hover:underline"
                >
                  {punctuality.sourceLabel}
                </a>
              ) : (
                punctuality.sourceLabel
              )}
            </p>
          )}
        </div>
      )}

      {pickedNight && timedCalendar && (
        <NightTimesNote
          night={pickedNight}
          retimed={retimed}
          runDeparture={departureTime}
          runArrival={arrivalTime}
          onReset={() => setPickedDate(null)}
        />
      )}

      <ol className="mt-5 space-y-0">
        {shownStops.map((stop, i) => {
          const isFirst = i === 0;
          const isLast = i === lastIdx;
          const name = stopName(stop);
          const time = stopTime(stop, isFirst, isLast);
          return (
            <li key={`${name}-${i}`} className="flex items-stretch gap-3">
              {/* rail */}
              <div className="flex flex-col items-center">
                <span
                  className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
                    isFirst || isLast ? "bg-primary-green" : "bg-white/30"
                  }`}
                />
                {!isLast && <span className="w-px flex-1 bg-white/10" />}
              </div>
              <div className={`flex flex-1 items-baseline justify-between gap-3 ${isLast ? "pb-0" : "pb-4"}`}>
                <span
                  className={`text-sm ${
                    isFirst || isLast ? "font-medium text-white" : "text-white/70"
                  }`}
                >
                  {name}
                </span>
                {time && <span className="font-mono text-sm text-white/50">{time}</span>}
              </div>
            </li>
          );
        })}
      </ol>

      {/* Helper link, not a CTA: check these times against the operator's own
          timetable. Sits under the stop list it refers to. */}
      {scheduleUrl && (
        <p className="mt-4 text-xs text-white/40">
          <a
            href={scheduleUrl}
            target="_blank"
            rel={
              scheduleAffiliate
                ? "sponsored nofollow noopener noreferrer"
                : "noopener noreferrer"
            }
            className="inline-flex items-center gap-1 hover:text-white/70 hover:underline"
          >
            {scheduleLabel || "Official timetable"}
            <FiExternalLink className="h-3 w-3 shrink-0" aria-hidden />
          </a>
        </p>
      )}

      {irregularities && (
        <p className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/80">
          {irregularities}
        </p>
      )}
    </section>
  );
}

/**
 * What the stop list below is showing once a night is chosen: that night's
 * own times, and — where the night leaves or arrives at another time than the
 * published run — why the stops in between have none.
 */
function NightTimesNote({ night, retimed, runDeparture, runArrival, onReset }) {
  const date = formatNight(night.date);
  let text;
  if (!retimed) {
    text = `No times recorded for ${date}; the times below are the published timetable's.`;
  } else if (retimed.sameAsRun) {
    text = `Times for ${date}.`;
  } else {
    const moved = [
      retimed.departure !== runDeparture && runDeparture
        ? `leaves at ${retimed.departure} instead of ${runDeparture}`
        : null,
      retimed.arrival !== runArrival && runArrival
        ? `arrives at ${retimed.arrival} instead of ${runArrival}`
        : null,
    ].filter(Boolean);
    text =
      `Times for ${date}: the train ${moved.join(" and ") || "runs to another timetable"} that night. ` +
      "Its times at the stops in between are not published here — check the operator's timetable for that date.";
  }
  return (
    <p
      className="mt-5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/60"
      data-testid="night-times"
    >
      {text}{" "}
      <button
        type="button"
        onClick={onReset}
        className="cursor-pointer text-white/80 underline underline-offset-2 hover:text-white"
      >
        Show the published timetable
      </button>
    </p>
  );
}
