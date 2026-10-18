// Shared country data for SEO and map features
export const COUNTRIES = [
  { code: "AT", name: "Austria", center: [47.5, 14.5], zoom: 7 },
  { code: "BE", name: "Belgium", center: [50.8, 4.4], zoom: 8 },
  { code: "BG", name: "Bulgaria", center: [42.7, 25.5], zoom: 7 },
  { code: "CH", name: "Switzerland", center: [46.8, 8.2], zoom: 8 },
  { code: "CN", name: "China", center: [35.9, 104.2], zoom: 4 },
  { code: "CZ", name: "Czechia", center: [49.8, 15.5], zoom: 7 },
  { code: "DE", name: "Germany", center: [51.2, 10.5], zoom: 6 },
  { code: "DK", name: "Denmark", center: [56.3, 9.5], zoom: 7 },
  { code: "ES", name: "Spain", center: [40.5, -3.7], zoom: 6 },
  { code: "FI", name: "Finland", center: [64.0, 26.0], zoom: 5 },
  { code: "FR", name: "France", center: [46.6, 2.3], zoom: 6 },
  { code: "GR", name: "Greece", center: [39.1, 21.8], zoom: 6 },
  { code: "HR", name: "Croatia", center: [45.1, 15.2], zoom: 7 },
  { code: "HU", name: "Hungary", center: [47.2, 19.5], zoom: 7 },
  { code: "IT", name: "Italy", center: [42.5, 12.6], zoom: 6 },
  { code: "JP", name: "Japan", center: [35.2, 135.5], zoom: 6 },
  { code: "NL", name: "Netherlands", center: [52.1, 5.3], zoom: 8 },
  { code: "NO", name: "Norway", center: [60.5, 8.5], zoom: 5 },
  { code: "PL", name: "Poland", center: [52.0, 19.0], zoom: 6 },
  { code: "PT", name: "Portugal", center: [39.4, -8.2], zoom: 6 },
  { code: "RO", name: "Romania", center: [45.9, 25.0], zoom: 6 },
  { code: "RS", name: "Serbia", center: [44.0, 21.0], zoom: 7 },
  { code: "SE", name: "Sweden", center: [62.0, 15.0], zoom: 5 },
  { code: "TH", name: "Thailand", center: [13.5, 100.8], zoom: 6 },
  { code: "SI", name: "Slovenia", center: [46.1, 14.8], zoom: 8 },
  { code: "SK", name: "Slovakia", center: [48.7, 19.7], zoom: 7 },
  { code: "UA", name: "Ukraine", center: [49.0, 32.0], zoom: 5 },

  // North America
  { code: "US", name: "United States", center: [39.8, -98.6], zoom: 4 },
  { code: "CA", name: "Canada", center: [56.1, -106.3], zoom: 3 },
];

// Get country by code
export function getCountryByCode(code) {
  return COUNTRIES.find((c) => c.code === code?.toUpperCase());
}

// Convert country code to flag emoji
export function getFlagEmoji(countryCode) {
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map((char) => 127397 + char.charCodeAt());
  return String.fromCodePoint(...codePoints);
}
