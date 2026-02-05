// Test script to explore oebb API
const oebb = require("oebb");

async function testOebb() {
  try {
    console.log("Testing ÖBB API...\n");
    
    // Test 1: Search for Vienna station
    console.log("1. Searching for Vienna station...");
    const viennaResults = await oebb.stations.search("Wien Hauptbahnhof", { results: 1 });
    console.log("Vienna station:", JSON.stringify(viennaResults[0], null, 2));
    
    // Test 2: Search for journeys from Vienna
    console.log("\n2. Searching for journeys from Vienna...");
    const journeys = await oebb.journeys(
      "8100002", // Wien Hauptbahnhof (ÖBB station ID)
      "8000261", // München Hbf
      {
        departure: new Date(),
        results: 5
      }
    );
    
    console.log(`Found ${journeys.length} journeys`);
    
    // Look for Nightjet trains
    journeys.forEach((journey, idx) => {
      console.log(`\nJourney ${idx + 1}:`);
      journey.legs.forEach(leg => {
        if (leg.line) {
          console.log(`  Line: ${leg.line.name} (${leg.line.product})`);
          console.log(`  From: ${leg.origin.name} at ${leg.departure}`);
          console.log(`  To: ${leg.destination.name} at ${leg.arrival}`);
          
          // Check if it's a Nightjet
          if (leg.line.name && (leg.line.name.includes("NJ") || leg.line.product === "nationalExpress")) {
            console.log("  ⭐ This might be a Nightjet!");
            console.log("  Full leg data:", JSON.stringify(leg, null, 2));
          }
        }
      });
    });
    
  } catch (error) {
    console.error("Error testing ÖBB API:", error);
  }
}

testOebb();
