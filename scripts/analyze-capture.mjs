#!/usr/bin/env node
/**
 * Print the latest endpoints-*.json summary, or a specific file.
 * Usage: node scripts/analyze-capture.mjs [path-to-endpoints.json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAPTURE_DIR = path.join(ROOT, "captures");

function latestSummary() {
  if (!fs.existsSync(CAPTURE_DIR)) return null;
  const files = fs
    .readdirSync(CAPTURE_DIR)
    .filter((f) => f.startsWith("endpoints-") && f.endsWith(".json"))
    .map((f) => ({
      f,
      m: fs.statSync(path.join(CAPTURE_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.m - a.m);
  return files[0] ? path.join(CAPTURE_DIR, files[0].f) : null;
}

const target = process.argv[2] || latestSummary();
if (!target || !fs.existsSync(target)) {
  console.error("No endpoints summary found. Run: npm run capture");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(target, "utf8"));
console.log(`File: ${target}`);
console.log(`Captured: ${data.captured_at}`);
console.log(`Entries: ${data.entry_count}`);
console.log(`Unique patterns: ${data.endpoints?.length ?? 0}`);
console.log("");

const xhr = (data.endpoints || []).filter(
  (e) =>
    e.resource_type === "xhr" ||
    e.resource_type === "fetch" ||
    (e.content_types || []).some((c) => c.includes("json")) ||
    e.method !== "GET"
);

console.log("=== Likely API / write endpoints ===");
for (const ep of xhr) {
  console.log(`\n${ep.method} ${ep.url_pattern}  (${ep.count}×)`);
  console.log(`  sample: ${ep.sample_url}`);
  console.log(`  status: ${ep.status_codes?.join(",")}`);
  console.log(`  type:   ${(ep.content_types || []).join(",") || "?"}`);
  if (ep.post_data_sample) {
    console.log(
      `  body:   ${String(ep.post_data_sample).slice(0, 300).replace(/\n/g, " ")}`
    );
  }
  if (ep.response_preview_sample) {
    console.log(
      `  resp:   ${String(ep.response_preview_sample).slice(0, 300).replace(/\n/g, " ")}`
    );
  }
}

console.log("\n=== All patterns (count × method path) ===");
for (const ep of data.endpoints || []) {
  console.log(
    `  ${String(ep.count).padStart(3)}× ${ep.method.padEnd(6)} ${ep.url_pattern}`
  );
}
