// Function to normalize station names to handle inconsistencies between stops and routes data
// Export this function so it can be used in other components
export const normalizeStationNameForLookup = (stationName) => {
  if (!stationName) return stationName;

  // Step 1: Remove French bilingual parts (e.g., " / Anvers-Central", " / Bruxelles-Midi", " / Luik-*")
  let normalized = stationName
    .replace(/\s*\/\s*Anvers-[^/]+$/g, "") // Remove French Antwerp names
    .replace(/\s*\/\s*Bruxelles-[^/]+$/g, "") // Remove French Brussels names
    .replace(/\s*\/\s*Luik-[^/]+$/g, ""); // Remove Dutch Liège names (Luik = Liège in Dutch)

  // Step 2: Replace hyphens with spaces for Belgian stations
  normalized = normalized
    .replace(/Bruxelles-Midi/g, "Bruxelles Midi")
    .replace(/Bruxelles-Nord/g, "Bruxelles Nord")
    .replace(/Bruxelles-Ouest/g, "Bruxelles Ouest")
    .replace(/Bruxelles-Central/g, "Bruxelles Central")
    .replace(/Bruxelles-Chapelle/g, "Bruxelles Chapelle")
    .replace(/Bruxelles-Congrès/g, "Bruxelles Congrès")
    .replace(/Bruxelles-Luxembourg/g, "Bruxelles Luxembourg")
    .replace(/Bruxelles-Schuman/g, "Bruxelles Schuman")
    .replace(/Antwerpen-Berchem/g, "Antwerpen Berchem")
    .replace(/Antwerpen-Centraal/g, "Antwerpen Centraal")
    .replace(/Antwerpen-D.S./g, "Antwerpen D.S.")
    .replace(/Antwerpen-Damiaan/g, "Antwerpen Damiaan")
    .replace(/Antwerpen-Kiel/g, "Antwerpen Kiel")
    .replace(/Antwerpen-Luchtbal/g, "Antwerpen Luchtbal")
    .replace(/Antwerpen-Noord/g, "Antwerpen Noord")
    .replace(/Antwerpen-Noorderdokken/g, "Antwerpen Noorderdokken")
    .replace(/Antwerpen-Oost/g, "Antwerpen Oost")
    .replace(/Antwerpen-Schijnpoort/g, "Antwerpen Schijnpoort")
    .replace(/Antwerpen-Waaslandhaven/g, "Antwerpen Waaslandhaven")
    .replace(/Antwerpen-Zuid/g, "Antwerpen Zuid")
    .replace(/Liège-Guillemins/g, "Liège Guillemins")
    .replace(/Liège-Carré/g, "Liège Carré")
    .replace(/Liège-Palais/g, "Liège Palais")
    .replace(/Liège-Jonfosse/g, "Liège Jonfosse")
    .replace(/Liège-Longdoz/g, "Liège Longdoz")
    .replace(/Liège-Saint-Lambert/g, "Liège Saint Lambert");

  // Step 3: Strip Czech/Slovak GTFS station-type suffixes so raw GTFS names
  // resolve to the same key as canonical BoT names.
  normalized = normalized
    .replace(/,\s*žst\.\s*$/i, "")           // "Košice, žst."      → "Košice"
    .replace(/,\s*žel\.\s*st\.\s*$/i, "")    // "Margecany, žel. st." → "Margecany"
    .replace(/,\s*hl\.n\.\s*$/i, " hl.n.")   // "Ostrava, hl.n."    → "Ostrava hl.n."
    .replace(/,\s+/g, " ")                   // "Poprad, Tatry"     → "Poprad Tatry"
    .replace(/\s+hlavní\s+nádraží\s*$/i, " hl.n.")  // "Pardubice hlavní nádraží" → "Pardubice hl.n."
    .replace(/\s+hlavni\s+nadrazi\s*$/i, " hl.n.")   // ASCII diacritic-free variant
    .trim();

  return normalized;
};
