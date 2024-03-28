/**
 * Converts station names with "French / Dutch" format to "French (Dutch)" format.
 * Specifically designed to handle Belgian station names like "Bruxelles-Midi / Brussel-Zuid".
 *
 * @param {string} stationName - The station name to format (e.g., "Bruxelles-Midi / Brussel-Zuid")
 * @returns {string} - The formatted station name (e.g., "Bruxelles-Midi (Zuid)")
 */
export function formatStationName(stationName) {
  // Return the original string if it doesn't contain a slash
  if (!stationName.includes('/')) {
    return stationName;
  }

  // Split the string by the slash
  const parts = stationName.split('/').map(part => part.trim());

  // Extract the French name (first part)
  const frenchName = parts[0];

  // Extract the Dutch name (second part)
  const dutchName = parts[1];

  // Extract the Dutch suffix (assuming the Dutch name is in "Brussel-Zuid" format)
  const dutchSuffix = dutchName.includes('-') ? dutchName.split('-')[1] : dutchName;

  // Return the formatted name
  return `${frenchName} (${dutchSuffix})`;
}

// Example usage:
// formatBelgianStationName("Bruxelles-Midi / Brussel-Zuid") returns "Bruxelles-Midi (Zuid)"