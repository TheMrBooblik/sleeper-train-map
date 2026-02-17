// Test script to explore HAFAS ÖBB API
const { createClient } = require("hafas-client");
const { profile: oebbProfile } = require("hafas-client/p/oebb");

const client = createClient(oebbProfile, "train-map-test");

async function testOebb() {
  try {
    console.log("Testing ÖBB HAFAS API...\n");
    
    // Test 1: Search for Vienna station
    console.log("1. Searching for Vienna station...");
    const viennaResults = await client.locations("Wien Hauptbahnhof", { results: 1 });
    console.log("Vienna station:", JSON.stringify(viennaResults[0], null, 2));
    const viennaId = viennaResults[0].id;
    
    // Test 2: Search for Munich station
    console.log("\n2. Searching for Munich station...");
    const munichResults = await client.locations("München Hbf", { results: 1 });
    console.log("Munich station:", JSON.stringify(munichResults[0], null, 2));
    const munichId = munichResults[0].id;
    
    // Test 3: Search for journeys from Vienna to Munich (to find Nightjets)
    console.log("\n3. Searching for journeys from Vienna to Munich...");
    const when = new Date();
    when.setHours(20, 0, 0, 0); // Evening time when Nightjets usually depart
    
    const journeys = await client.journeys(viennaId, munichId, {
      departure: when,
      results: 10,
      stopovers: true // Get all intermediate stops
    });
    
    console.log(`\nFound ${journeys.journeys.length} journeys`);
    
    // Look for Nightjet trains
    journeys.journeys.forEach((journey, idx) => {
      console.log(`\n--- Journey ${idx + 1} ---`);
      journey.legs.forEach((leg, legIdx) => {
        if (leg.line) {
          const isNightjet = leg.line.name && leg.line.name.includes("NJ");
          console.log(`  Leg ${legIdx + 1}: ${leg.line.name || "Unknown"} (${leg.line.product || "Unknown"})`);
          console.log(`  From: ${leg.origin.name} at ${leg.departure}`);
          console.log(`  To: ${leg.destination.name} at ${leg.arrival}`);
          
          if (isNightjet) {
            console.log(`  ⭐ NIGHTJET FOUND: ${leg.line.name}`);
            console.log(`  Operator: ${leg.operator?.name || "Unknown"}`);
            
            if (leg.stopovers && leg.stopovers.length > 0) {
              console.log(`  Stopovers: ${leg.stopovers.length}`);
              leg.stopovers.slice(0, 5).forEach(stop => {
                console.log(`    - ${stop.stop.name} (${stop.arrival || stop.departure})`);
              });
              if (leg.stopovers.length > 5) {
                console.log(`    ... and ${leg.stopovers.length - 5} more`);
              }
            }
            
            // Save full data for all NightJet trains
            console.log("\n  📝 Full NightJet data:");
            console.log(JSON.stringify(leg, null, 2));
          }
        }
      });
    });
    
  } catch (error) {
    console.error("Error testing ÖBB API:", error);
    if (error.isHafasError) {
      console.error("HAFAS Error Details:", {
        code: error.code,
        message: error.message
      });
    }
  }
}

testOebb();