/**
 * A connection page reads "from A to B" in slug order, so each train on it
 * lists the direction leaving A first: /connections/takamatsu-to-tokyo opened
 * with "Tokyo → Takamatsu" because that is the row's direction 0.
 *
 * Dependency-free (.mjs) so raw-node tests can import it; the station → city
 * resolver is injected for the same reason the page passes cityForStation.
 */

/**
 * The train with the direction that leaves `city` first — heading, train
 * numbers and timetables together. Returned unchanged when it already does,
 * or when no direction starts there (a one-way train, a pair reached
 * mid-route). The booking fields are left alone: a deep link preselects the
 * direction it was built for, whatever order the timetables are shown in.
 *
 * @param {{origin:string, destination:string, trainNumbers:string[], directions:{origin:string, destination:string, trainNumber:string}[]}} train
 * @param {string} city
 * @param {(station: string) => string} cityOf
 */
export function leadWithCity(train, city, cityOf) {
  const lead = train.directions.findIndex((x) => cityOf(x.origin) === city);
  if (lead <= 0) return train;
  const directions = [train.directions[lead], ...train.directions.filter((_, j) => j !== lead)];
  return {
    ...train,
    origin: directions[0].origin,
    destination: directions[0].destination,
    trainNumbers: directions.map((x) => x.trainNumber).filter(Boolean),
    directions,
  };
}
