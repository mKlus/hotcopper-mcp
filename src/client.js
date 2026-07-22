/**
 * Cookie-authenticated HTTP client for HotCopper (XenForo-based).
 * Loads Playwright storage-state cookies from auth/storage-state.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
export const AUTH_STATE = path.join(ROOT, "auth", "storage-state.json");
export const BASE = "https://hotcopper.com.au";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function loadCookies() {
  if (!fs.existsSync(AUTH_STATE)) {
    throw new Error(
      `No auth state at ${AUTH_STATE}. Run: npm run capture`
    );
  }
  const state = JSON.parse(fs.readFileSync(AUTH_STATE, "utf8"));
  return state.cookies || [];
}

export function cookieHeader(cookies = loadCookies()) {
  return cookies
    .filter((c) => {
      const d = (c.domain || "").replace(/^\./, "");
      return d === "hotcopper.com.au" || d.endsWith("hotcopper.com.au");
    })
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

export function authInfo(cookies = loadCookies()) {
  const xfUser = cookies.find((c) => c.name === "xf_user");
  const xfSession = cookies.find((c) => c.name === "xf_session");
  let userId = null;
  if (xfUser?.value) {
    const raw = decodeURIComponent(xfUser.value);
    userId = parseInt(raw.split(",")[0], 10) || null;
  }
  return {
    logged_in: Boolean(xfUser && xfSession),
    user_id: userId,
    has_session: Boolean(xfSession),
    cookie_count: cookies.filter((c) =>
      (c.domain || "").includes("hotcopper")
    ).length,
    // Path only (no cookie values). Useful for debugging session files.
    storage_state_path: AUTH_STATE,
  };
}

export function absoluteUrl(href) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `${BASE}${href}`;
  return `${BASE}/${href}`;
}

/**
 * Resolve a path or absolute HotCopper URL to a same-origin absolute URL.
 * Rejects off-site hosts so session cookies are never sent elsewhere.
 * @param {string} pathOrUrl
 * @returns {string}
 */
export function resolveHotCopperUrl(pathOrUrl) {
  const raw = String(pathOrUrl || "").trim();
  if (!raw) {
    throw new Error("URL or path is required");
  }
  let absolute;
  if (/^https?:\/\//i.test(raw) || raw.startsWith("//")) {
    absolute = raw.startsWith("//") ? `https:${raw}` : raw;
  } else if (raw.startsWith("/")) {
    absolute = `${BASE}${raw}`;
  } else {
    absolute = `${BASE}/${raw}`;
  }

  let u;
  try {
    u = new URL(absolute);
  } catch {
    throw new Error(`Invalid URL: ${pathOrUrl}`);
  }
  if (u.protocol !== "https:") {
    throw new Error("Only https://hotcopper.com.au URLs are allowed");
  }
  if (u.hostname !== "hotcopper.com.au" && u.hostname !== "www.hotcopper.com.au") {
    throw new Error(
      `Refusing non-HotCopper host: ${u.hostname} (session cookies must not leave the site)`
    );
  }
  // Normalize host so cookie domain matches
  u.hostname = "hotcopper.com.au";
  return u.toString();
}

/**
 * @param {string} url
 * @param {{ method?: string, body?: URLSearchParams|string|null, headers?: Record<string,string>, redirect?: RequestRedirect }} [opts]
 */
export async function hcFetch(url, opts = {}) {
  const method = opts.method || "GET";
  const resolved = resolveHotCopperUrl(url);
  const headers = {
    "User-Agent": UA,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-AU,en;q=0.9",
    Cookie: cookieHeader(),
    ...(opts.headers || {}),
  };
  if (opts.body && method !== "GET") {
    headers["Content-Type"] =
      headers["Content-Type"] || "application/x-www-form-urlencoded";
  }

  // Manual redirect follow so we can reject off-site Location (cookie safety)
  let currentUrl = resolved;
  let currentMethod = method;
  let currentBody = opts.body ?? undefined;
  let finalRes = null;
  for (let hop = 0; hop < 6; hop++) {
    finalRes = await fetch(currentUrl, {
      method: currentMethod,
      headers,
      body: currentMethod === "GET" || currentMethod === "HEAD" ? undefined : currentBody,
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(finalRes.status)) break;
    const loc = finalRes.headers.get("location");
    if (!loc) {
      throw new Error(`Redirect ${finalRes.status} without Location`);
    }
    currentUrl = resolveHotCopperUrl(new URL(loc, currentUrl).toString());
    // Browser-like: 303 and often 302 after POST become GET
    if (
      finalRes.status === 303 ||
      (currentMethod === "POST" && (finalRes.status === 301 || finalRes.status === 302))
    ) {
      currentMethod = "GET";
      currentBody = undefined;
    }
  }

  if (!finalRes || [301, 302, 303, 307, 308].includes(finalRes.status)) {
    throw new Error(
      `Too many redirects or unresolved redirect (status ${finalRes?.status})`
    );
  }

  const text = await finalRes.text();
  return {
    ok: finalRes.ok,
    status: finalRes.status,
    url: finalRes.url || currentUrl,
    headers: Object.fromEntries(finalRes.headers.entries()),
    text,
  };
}

export async function getHtml(pathOrUrl) {
  const res = await hcFetch(pathOrUrl);
  if (!res.ok) {
    throw new Error(`GET ${pathOrUrl} failed: HTTP ${res.status}`);
  }
  return res;
}
