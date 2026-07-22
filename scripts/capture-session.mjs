#!/usr/bin/env node
/**
 * HotCopper auth + network capture session
 *
 * 1. Opens a headed Chromium window on hotcopper.com.au
 * 2. Reuses saved cookies if present (auth/storage-state.json)
 * 3. Records XHR/fetch/document traffic to captures/
 * 4. You log in and click around (search, open threads, etc.)
 * 5. Press Enter in this terminal when done — cookies + HAR + endpoint summary are saved
 *
 * Usage:
 *   node scripts/capture-session.mjs
 *   node scripts/capture-session.mjs --system-chrome   # use installed Google Chrome
 *   node scripts/capture-session.mjs --url https://hotcopper.com.au/asx/pls/
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const AUTH_DIR = path.join(ROOT, "auth");
const CAPTURE_DIR = path.join(ROOT, "captures");
const STORAGE_STATE = path.join(AUTH_DIR, "storage-state.json");
const COOKIES_JSON = path.join(AUTH_DIR, "cookies.json");

const NOISE =
  /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|css|map)(\?|$)/i;
const NOISE_HOST =
  /(google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|segment\.|sentry\.|cloudflareinsights|newrelic|nr-data|clarity\.ms|adservice)/i;

function parseArgs(argv) {
  const args = { systemChrome: false, url: "https://hotcopper.com.au/" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--system-chrome") args.systemChrome = true;
    if (argv[i] === "--url" && argv[i + 1]) args.url = argv[++i];
  }
  return args;
}

function ensureDirs() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function shouldLog(url) {
  try {
    const u = new URL(url);
    if (NOISE.test(u.pathname)) return false;
    if (NOISE_HOST.test(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function isInterestingApi(url, resourceType, method) {
  if (!shouldLog(url)) return false;
  if (["xhr", "fetch"].includes(resourceType)) return true;
  if (method !== "GET" && method !== "OPTIONS") return true;
  // JSON-ish or API-ish paths even if document
  if (/\/(api|ajax|json|graphql|search|threads|posts|forums|members)/i.test(url))
    return true;
  if (url.includes("hotcopper.com.au") && resourceType === "document") return true;
  return false;
}

async function bodyPreview(response, max = 4000) {
  try {
    const ct = (response.headers()["content-type"] || "").toLowerCase();
    if (
      ct.includes("json") ||
      ct.includes("text") ||
      ct.includes("javascript") ||
      ct.includes("xml") ||
      ct.includes("html")
    ) {
      const text = await response.text();
      return text.slice(0, max);
    }
    return `[binary ${ct || "unknown"}]`;
  } catch (e) {
    return `[unreadable: ${e.message}]`;
  }
}

function summarizeEndpoints(entries) {
  /** @type {Map<string, object>} */
  const map = new Map();
  for (const e of entries) {
    let pathKey = e.url;
    try {
      const u = new URL(e.url);
      // Normalize numeric IDs
      pathKey = `${u.origin}${u.pathname}`
        .replace(/\/\d{4,}/g, "/{id}")
        .replace(/\/page-\d+/g, "/page-{n}");
      const key = `${e.method} ${pathKey}`;
      if (!map.has(key)) {
        map.set(key, {
          method: e.method,
          url_pattern: pathKey,
          sample_url: e.url,
          resource_type: e.resource_type,
          status_codes: new Set(),
          content_types: new Set(),
          request_headers_sample: e.request_headers,
          post_data_sample: e.post_data,
          response_preview_sample: e.response_preview,
          count: 0,
        });
      }
      const row = map.get(key);
      row.count += 1;
      if (e.status != null) row.status_codes.add(e.status);
      if (e.content_type) row.content_types.add(e.content_type);
      if (!row.post_data_sample && e.post_data) row.post_data_sample = e.post_data;
      if (
        (!row.response_preview_sample ||
          row.response_preview_sample.startsWith("[")) &&
        e.response_preview
      ) {
        row.response_preview_sample = e.response_preview;
      }
    } catch {
      /* ignore */
    }
  }

  return [...map.values()]
    .map((r) => ({
      ...r,
      status_codes: [...r.status_codes].sort(),
      content_types: [...r.content_types],
    }))
    .sort((a, b) => b.count - a.count);
}

function waitForEnter(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

/** Wait until Enter (if TTY) or auth/DONE appears, or maxMs elapses. */
function waitForDone({ prompt, doneFile, maxMs = 45 * 60 * 1000 }) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (reason) => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(timer);
      try {
        rl?.close();
      } catch {
        /* ignore */
      }
      resolve(reason);
    };

    if (fs.existsSync(doneFile)) {
      try {
        fs.unlinkSync(doneFile);
      } catch {
        /* ignore */
      }
    }

    const poll = setInterval(() => {
      if (fs.existsSync(doneFile)) finish("done-file");
    }, 500);

    const timer = setTimeout(() => finish("timeout"), maxMs);

    let rl = null;
    if (process.stdin.isTTY) {
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(prompt, () => finish("enter"));
    } else {
      console.log(
        `(no TTY) Waiting for done signal: touch ${doneFile}\n` +
          `Or tell the agent: "I'm logged in and done browsing"`
      );
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureDirs();
  const runId = stamp();
  const jsonlPath = path.join(CAPTURE_DIR, `network-${runId}.jsonl`);
  const harPath = path.join(CAPTURE_DIR, `session-${runId}.har`);
  const summaryPath = path.join(CAPTURE_DIR, `endpoints-${runId}.json`);
  const logStream = fs.createWriteStream(jsonlPath, { flags: "a" });

  /** @type {object[]} */
  const entries = [];

  console.log("=== HotCopper capture session ===");
  console.log(`Start URL:     ${args.url}`);
  console.log(`Storage state: ${STORAGE_STATE}`);
  console.log(`Network log:   ${jsonlPath}`);
  console.log(`HAR:           ${harPath}`);
  console.log("");

  const launchOpts = {
    headless: false,
    viewport: { width: 1400, height: 900 },
    recordHar: { path: harPath, mode: "minimal", content: "embed" },
  };
  if (args.systemChrome) {
    launchOpts.channel = "chrome";
  }

  const contextOptions = {
    viewport: { width: 1400, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-AU",
    timezoneId: "Australia/Sydney",
  };
  if (fs.existsSync(STORAGE_STATE)) {
    contextOptions.storageState = STORAGE_STATE;
    console.log("Loaded existing auth/storage-state.json");
  }

  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // Capture request start
  page.on("request", (request) => {
    const url = request.url();
    const method = request.method();
    const resourceType = request.resourceType();
    if (!isInterestingApi(url, resourceType, method)) return;
    // store pending keyed by request object via weak map not needed — attach on response
    request._hc_meta = {
      ts: new Date().toISOString(),
      method,
      url,
      resource_type: resourceType,
      post_data: request.postData() || null,
      request_headers: request.headers(),
    };
  });

  page.on("response", async (response) => {
    const request = response.request();
    const url = request.url();
    const method = request.method();
    const resourceType = request.resourceType();
    if (!isInterestingApi(url, resourceType, method)) return;

    const meta = request._hc_meta || {
      ts: new Date().toISOString(),
      method,
      url,
      resource_type: resourceType,
      post_data: request.postData() || null,
      request_headers: request.headers(),
    };

    let response_preview = null;
    // Prefer JSON bodies for API reverse-engineering
    const ct = (response.headers()["content-type"] || "").toLowerCase();
    const looksApi =
      ["xhr", "fetch"].includes(resourceType) ||
      ct.includes("json") ||
      method !== "GET";
    if (looksApi) {
      response_preview = await bodyPreview(response);
    }

    const entry = {
      ...meta,
      status: response.status(),
      content_type: ct || null,
      response_headers: response.headers(),
      response_preview,
    };

    entries.push(entry);
    logStream.write(JSON.stringify(entry) + "\n");

    const short = `${method} ${response.status()} ${url.slice(0, 120)}`;
    if (looksApi) console.log(`  [api] ${short}`);
  });

  await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 60000 });

  const doneFile = path.join(AUTH_DIR, "DONE");

  console.log("");
  console.log("Browser is open. Please:");
  console.log("  1. Log in to HotCopper (if not already)");
  console.log("  2. Browse: search, open a stock thread, view news, try posting UI");
  console.log("  3. When finished either:");
  console.log("       • press ENTER in this terminal, or");
  console.log(`       • touch ${doneFile}`);
  console.log("       • tell the agent you're done (it will signal for you)");
  console.log("");
  console.log("Tip: do the actions you want as MCP tools (search, read thread, reply).");
  console.log("");

  // Periodically snapshot cookies so a crash still leaves partial auth
  const persistInterval = setInterval(async () => {
    try {
      await context.storageState({ path: STORAGE_STATE });
    } catch {
      /* browser may be closing */
    }
  }, 15000);

  const reason = await waitForDone({
    prompt: ">>> Press ENTER (or touch auth/DONE) to save and quit… ",
    doneFile,
  });
  clearInterval(persistInterval);
  console.log(`Finishing (signal: ${reason})…`);
  try {
    if (fs.existsSync(doneFile)) fs.unlinkSync(doneFile);
  } catch {
    /* ignore */
  }

  // Persist auth
  await context.storageState({ path: STORAGE_STATE });
  const cookies = await context.cookies();
  fs.writeFileSync(COOKIES_JSON, JSON.stringify(cookies, null, 2));

  // Endpoint summary
  const summary = {
    captured_at: new Date().toISOString(),
    run_id: runId,
    entry_count: entries.length,
    storage_state: STORAGE_STATE,
    cookies_file: COOKIES_JSON,
    har: harPath,
    network_jsonl: jsonlPath,
    endpoints: summarizeEndpoints(entries),
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  logStream.end();
  await context.close();
  await browser.close();

  console.log("");
  console.log("=== Capture complete ===");
  console.log(`Entries:   ${entries.length}`);
  console.log(`Endpoints: ${summary.endpoints.length} unique patterns`);
  console.log(`Summary:   ${summaryPath}`);
  console.log(`Cookies:   ${COOKIES_JSON}`);
  console.log(`Storage:   ${STORAGE_STATE}`);
  console.log("");
  console.log("Top endpoint patterns:");
  for (const ep of summary.endpoints.slice(0, 40)) {
    console.log(
      `  ${ep.count.toString().padStart(3)}× ${ep.method.padEnd(6)} ${ep.url_pattern}`
    );
  }
  if (summary.endpoints.length > 40) {
    console.log(`  … and ${summary.endpoints.length - 40} more (see summary JSON)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
