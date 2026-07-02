/**
 * Build a compact, data-driven FAQ for a country hub page.
 *
 * Every answer is derived strictly from the country's own data (route counts,
 * operators, connected countries, durations, prices) — nothing is invented — so
 * the FAQ stays genuinely useful and safe to emit as FAQPage structured data.
 *
 * Returns [{ q, a }] where both are plain strings (FAQPage JSON-LD needs text
 * answers). Questions with no supporting data are simply omitted.
 */

import { formatFromPrice } from "../operatorPricing";

/** Join a list of names as "A, B and C". */
function humanJoin(names) {
  const list = names.filter(Boolean);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/**
 * @param {object} args
 * @param {{name:string}} args.country
 * @param {{name:string}[]} args.operators
 * @param {object} args.facts - from getCountryHub().facts
 * @param {{name:string}[]} args.connectedCountries
 */
export function buildCountryFaq({ country, operators, facts, connectedCountries }) {
  const faq = [];
  const name = country.name;
  const operatorNames = humanJoin(operators.map((o) => o.name));

  // How many trains + who runs them.
  if (facts.routeCount > 0) {
    faq.push({
      q: `How many night trains serve ${name}?`,
      a:
        `${facts.routeCount} night and sleeper train ${
          facts.routeCount === 1 ? "route" : "routes"
        } currently serve ${name}` +
        (operatorNames ? `, operated by ${operatorNames}.` : "."),
    });
  }

  // Where you can go — the genuinely useful "planning" answer.
  if (connectedCountries.length > 0) {
    faq.push({
      q: `Where can I travel by night train from ${name}?`,
      a: `Direct night trains connect ${name} with ${humanJoin(
        connectedCountries.map((c) => c.name),
      )}.`,
    });
  }

  // Shortest vs longest journey, when both are known and differ.
  if (
    facts.fastest &&
    facts.longest &&
    facts.fastest.durationText &&
    facts.longest.durationText &&
    facts.fastest.slug !== facts.longest.slug
  ) {
    faq.push({
      q: `How long are night train journeys from ${name}?`,
      a: `Journeys range from the ${facts.fastest.title} (${facts.fastest.durationText}) up to the ${facts.longest.title} (${facts.longest.durationText}).`,
    });
  }

  // Price, only when we actually have a concrete "from" figure.
  const priceLabel = formatFromPrice(facts.minFromPrice);
  if (priceLabel) {
    faq.push({
      q: `How much do night trains from ${name} cost?`,
      a: `Fares vary by date and comfort class, but tickets start ${priceLabel} on the cheapest routes.`,
    });
  }

  // How to book — points people to the concrete next step.
  if (operators.length > 0) {
    faq.push({
      q: `How do I book a night train in ${name}?`,
      a: `Book directly with the operator (${operatorNames}). Open any route below or on the map to see its timetable and booking link.`,
    });
  }

  return faq;
}
