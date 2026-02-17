// Test script to get Nightjet departures at a station
const { createClient } = require("hafas-client");
const { profile: oebbProfile } = require("hafas-client/p/oebb");

const client = createClient(oebbProfile, "train-map-test");

async function testStationDepartures() {
  try {
    console.log("Testing Nightjet departures at Vienna...\n");
    
    // Search for Vienna Hauptbahnhof
    const viennaResults = await client.locations("Wien Hauptbahnhof", { results: 5 });
    console.log("\nFound stations:");
    viennaResults.forEach((s, i) => console.log(`  ${i}: ${s.name} (${s.id})`));
    
    // Use the first one that has "Hauptbahnhof" in the name
    const hauptbahnhof = viennaResults.find(s => s.name.includes("Hauptbahnhof")) || viennaResults[0];
    console.log("\nUsing station:", hauptbahnhof.name, "-", hauptbahnhof.id);
    const stationId = hauptbahnhof.id;
    
    // Get departures - check multiple time windows to find all Nightjets
    console.log("\nSearching for Nightjet departures...");
    
    const allNightjets = [];
    
    // Check departures over 24 hours (in 6-hour chunks)
    for (let hour = 0; hour < 24; hour += 6) {
      const when = new Date();
      when.setHours(hour, 0, 0, 0);
      
      const result = await client.departures(stationId, {
        when,
        duration: 360 // 6 hours
      });
      
      const departures = result.departures || result;
      
      // Debug: show first few departures
      if (hour === 18) {
        console.log(`\n  Debug - First 10 departures at ${hour}:00:`);
        departures.slice(0, 10).forEach(dep => {
          console.log(`    ${dep.line?.name || 'No name'} (${dep.line?.product || 'No product'}) to ${dep.direction}`);
        });
      }
      
      // Filter for Nightjet trains (line name contains NJ)
      const nightjets = departures.filter(dep => 
        dep.line && dep.line.name && /NJ\s*\d+/i.test(dep.line.name)
      );
      
      nightjets.forEach(nj => {
        // Check if we already have this train
        const exists = allNightjets.find(existing => 
          existing.line.name === nj.line.name && 
          existing.tripId === nj.tripId
        );
        if (!exists) {
          allNightjets.push(nj);
        }
      });
      
      console.log(`  Checked ${hour}:00 - found ${nightjets.length} Nightjets`);
    }
    
    console.log(`\n⭐ Total unique Nightjets found: ${allNightjets.length}\n`);
    
    // Fetch trip details for each Nightjet
    for (const dep of allNightjets) {
      console.log(`\n--- ${dep.line.name} ---`);
      console.log(`Trip ID: ${dep.tripId}`);
      console.log(`Direction: ${dep.direction}`);
      console.log(`Departure: ${dep.when}`);
      console.log(`Platform: ${dep.platform || "N/A"}`);
      
      // Fetch trip details to get stopovers
      try {
        console.log("Fetching trip details...");
        const trip = await client.trip(dep.tripId, { stopovers: true });
        
        if (trip.stopovers && trip.stopovers.length > 0) {
          console.log(`Stops: ${trip.stopovers.length}`);
          console.log("First 5 stops:");
          trip.stopovers.slice(0, 5).forEach(stop => {
            const time = stop.departure || stop.arrival;
            const location = stop.stop.location;
            console.log(`  - ${stop.stop.name} [${location.latitude}, ${location.longitude}] at ${time}`);
          });
        }
      } catch (tripError) {
        console.error(`  Error fetching trip details: ${tripError.message}`);
      }
    }
    
  } catch (error) {
    console.error("Error:", error);
  }
}

testStationDepartures();
