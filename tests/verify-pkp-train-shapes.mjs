#!/usr/bin/env node
/**
 * Validates public/data/gtfs/pkpTrainShapes.json (no server).
 * Run: node tests/verify-pkp-train-shapes.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const p = path.join(root, "public", "data", "gtfs", "pkpTrainShapes.json");

const raw = fs.readFileSync(p, "utf8");
const data = JSON.parse(raw);
const k16170 = data.byTrainKey?.["16170"]?.positions;
if (!Array.isArray(k16170) || k16170.length < 50) {
  console.error("Expected byTrainKey[16170].positions with 50+ points");
  process.exit(1);
}
console.log("pkpTrainShapes.json OK —", Object.keys(data.byTrainKey || {}).length, "train keys");
