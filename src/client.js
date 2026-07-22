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
    storage_state: AUTH_STATE,
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
 * @param {string} url
 * @param {{ method?: string, body?: URLSearchParams|string|null, headers?: Record<string,string>, redirect?: RequestRedirect }} [opts]
 */
export async function hcFetch(url, opts = {}) {
  const method = opts.method || "GET";
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

  const res = await fetch(absoluteUrl(url) || url, {
    method,
    headers,
    body: opts.body ?? undefined,
    redirect: opts.redirect || "follow",
  });

  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    url: res.url,
    headers: Object.fromEntries(res.headers.entries()),
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
