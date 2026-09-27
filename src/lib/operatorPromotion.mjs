/**
 * Promoted operators first: the order in which the map lists a station's
 * routes (TrainBottomBar). Which operators, and in what order, lives in
 * data/overrides/operator-promotion.json — a commercial choice (an operator
 * paying commission), kept as data like every other operator rule here.
 *
 * Dependency-free apart from the ID splitter, with the table injectable, so
 * the ordering is testable in raw node.
 */
import PROMOTION from "../../data/overrides/operator-promotion.json" with { type: "json" };
import { splitAgencyIds } from "./seo/operatorNames.mjs";

/**
 * A route's promotion rank: the best rank of any operator it names, in either
 * its own agency_id or Back-on-Track's (a synthetic row overwrites agency_id,
 * and a joint train such as "FS/ÖBB" is promoted if either partner is).
 * Infinity when no operator is promoted, so unranked routes sort last.
 */
export function promotionRank(route, table = PROMOTION.operators) {
  let best = Infinity;
  for (const field of [route?.agency_id, route?.bot_agency_id]) {
    for (const id of splitAgencyIds(field)) {
      const rank = Number(table?.[id]?.rank);
      if (Number.isFinite(rank) && rank < best) best = rank;
    }
  }
  return best;
}

/**
 * Routes with promoted operators first (by rank), everyone else after, each
 * group keeping the order it came in (a stable sort). Returns a new array.
 */
export function orderByPromotion(routes, table = PROMOTION.operators) {
  return (routes ?? [])
    .map((route, i) => ({ route, i, rank: promotionRank(route, table) }))
    .sort((a, b) => (a.rank === b.rank ? a.i - b.i : a.rank < b.rank ? -1 : 1))
    .map((x) => x.route);
}
