/**
 * Static timetable for one direction of a route: header (train number, endpoints,
 * times, days) + the ordered stop list. Intermediate (via) stops have no per-stop
 * times in the source data, so only origin departure / destination arrival show.
 */
export default function RouteTimetable({ direction }) {
  if (!direction) return null;
  const { trainNumber, origin, destination, departureTime, arrivalTime, stops, serviceDays, irregularities } = direction;
  const lastIdx = stops.length - 1;

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

      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-white/60">
        {departureTime && <span>Departs {departureTime}</span>}
        {arrivalTime && <span>Arrives {arrivalTime}</span>}
        {serviceDays && <span>{serviceDays}</span>}
      </div>

      <ol className="mt-5 space-y-0">
        {stops.map((name, i) => {
          const isFirst = i === 0;
          const isLast = i === lastIdx;
          const time = isFirst ? departureTime : isLast ? arrivalTime : "";
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

      {irregularities && (
        <p className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/80">
          {irregularities}
        </p>
      )}
    </section>
  );
}
