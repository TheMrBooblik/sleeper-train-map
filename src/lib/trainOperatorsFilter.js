/**
 * Helpers to detect and filter out specific train operators from Back-on-Track data.
 * Used so we don't show stations that only have these operators, or their routes.
 */

// Train4you Vertriebs GmbH (Urlaubs-Express) is identified by agency_id in Back-on-Track data
export const TRAIN4YOU_AGENCY_ID = "UEX";

// Match Train4you by name: operator name or trip/route short name (fallback)
const TRAIN4YOU_PATTERNS = [
  /train\s*4\s*you/i,
  /train4you/i,
  /vertriebs\s*gmbh/i,
  /t4y\s*\d*/i,
  /^\s*T4Y\s+/i,
];

/**
 * Returns true if the given trip/route is operated by Train4you (incl. Urlaubs-Express / UEX)
 * @param {Object} item - Trip or route object (may have agency_id, trip_short_name, route_short_name, operator)
 * @param {string} tripName - Optional trip name string (e.g. trip_short_name_0)
 * @returns {boolean}
 */
export function isTrain4you(item = {}, tripName = "") {
  // Back-on-Track uses agency_id; UEX = Train4you Vertriebs GmbH
  const agencyId = (item?.agency_id || "").toString().trim();
  if (agencyId === TRAIN4YOU_AGENCY_ID) {
    return true;
  }

  const name =
    tripName || item?.trip_short_name || item?.route_short_name || "";
  const operator = (item?.operator || "").toString();
  const combined = `${name} ${operator}`.toLowerCase();
  return TRAIN4YOU_PATTERNS.some(
    (re) => re.test(combined) || re.test(name) || re.test(operator),
  );
}
