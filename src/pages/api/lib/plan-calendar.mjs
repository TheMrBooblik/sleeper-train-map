import { parseBotServiceString } from "./calendar.mjs";

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function toDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  const date = new Date(value);
  date.setHours(12, 0, 0, 0);
  return date;
}

export function serviceRunsOnDate(serviceId, value) {
  const date = toDate(value);
  if (!date) return false;
  if (!serviceId) return true;

  const calendar = parseBotServiceString(String(serviceId));
  if (calendar.note || !calendar.daysOfWeek.length) return true;

  const day = DAY_KEYS[date.getDay()];
  if (!calendar.daysOfWeek.includes(day)) return false;

  const iso = date.toISOString().slice(0, 10);
  if (calendar.validFrom && iso < calendar.validFrom) return false;
  if (calendar.validUntil && iso > calendar.validUntil) return false;
  return true;
}

export function routeRunsOnDate(route, value) {
  const serviceIds = [route?.service_id_0, route?.service_id_1].filter(Boolean);
  if (!serviceIds.length) return true;
  return serviceIds.some((serviceId) => serviceRunsOnDate(serviceId, value));
}
