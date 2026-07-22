/**
 * High-level HotCopper operations used by MCP tools.
 */
import {
  authInfo,
  getHtml,
  hcFetch,
  absoluteUrl,
  BASE,
} from "./client.js";
import {
  extractTokens,
  parsePostList,
  parseStockPage,
  parseThread,
  parseSearchResults,
  parseNewsList,
} from "./parse.js";

export function getAuthStatus() {
  return authInfo();
}

export async function latestPosts({ limit = 30, page = 1 } = {}) {
  const path =
    page > 1 ? `/postview/page-${page}` : "/postview/";
  const res = await getHtml(path);
  return {
    url: res.url,
    page,
    posts: parsePostList(res.text, { limit }),
  };
}

export async function stockThreads(ticker, { limit = 30 } = {}) {
  const code = String(ticker).trim().toUpperCase();
  const res = await getHtml(`/asx/${code.toLowerCase()}/`);
  const parsed = parseStockPage(res.text, { limit });
  return {
    ticker: code,
    url: res.url,
    ...parsed,
  };
}

export async function getThread(threadRef, { limit = 40, page } = {}) {
  let path = String(threadRef).trim();
  if (/^\d+$/.test(path)) {
    // bare id — need slug; try common pattern fails. Require full url/slug.
    throw new Error(
      "Pass a full thread URL or path like /threads/subject.12345/ (not bare id alone)"
    );
  }
  if (path.startsWith("http")) {
    path = path.replace(BASE, "");
  }
  if (!path.startsWith("/")) path = `/${path}`;
  // normalize
  if (page && !/\/page-\d+/.test(path)) {
    path = path.replace(/\/?$/, `/page-${page}`);
  }
  const res = await getHtml(path);
  const parsed = parseThread(res.text, { limit });
  return {
    url: res.url,
    ...parsed,
  };
}

export async function search(keywords, { limit = 30, title_only = false } = {}) {
  // Need a page for visitorXfToken
  const home = await getHtml("/");
  const tokens = extractTokens(home.text);
  if (!tokens.visitorXfToken) {
    throw new Error(
      "Could not find visitorXfToken — session may be expired. Run: npm run capture"
    );
  }

  const body = new URLSearchParams();
  body.set("keywords", keywords);
  body.set("visitorXfToken", tokens.visitorXfToken);
  body.set("title_only", title_only ? "1" : "0");
  body.set("exchange_code", "");
  if (tokens.userId) body.set("user_id", String(tokens.userId));

  const res = await hcFetch("/search/search/", {
    method: "POST",
    body,
    headers: {
      Origin: BASE,
      Referer: `${BASE}/`,
    },
  });

  const parsed = parseSearchResults(res.text, { limit });
  return {
    keywords,
    status: res.status,
    url: res.url,
    ...parsed,
  };
}

export async function getNews({ limit = 15 } = {}) {
  const res = await getHtml("/");
  return {
    url: res.url,
    articles: parseNewsList(res.text, { limit }),
  };
}

/**
 * Reply to a thread. Requires confirm: true.
 * message is plain text (wrapped as HTML paragraphs).
 */
export async function replyToThread({
  thread_url,
  message,
  confirm = false,
  dry_run = false,
  sentiment = "",
  is_held = "",
} = {}) {
  if (!confirm && !dry_run) {
    return {
      ok: false,
      error:
        "Refusing to post without confirm=true. Set dry_run=true to preview the form payload.",
    };
  }
  if (!thread_url || !message?.trim()) {
    return { ok: false, error: "thread_url and message are required" };
  }

  let path = thread_url;
  if (path.startsWith("http")) path = path.replace(BASE, "");
  if (!path.startsWith("/")) path = `/${path}`;

  const page = await getHtml(path);
  const parsed = parseThread(page.text, { limit: 1 });
  if (!parsed.reply?.can_reply || !parsed.reply.action) {
    return {
      ok: false,
      error: "Reply form not found — not logged in, thread locked, or layout changed",
      auth: authInfo(),
    };
  }

  const { reply } = parsed;
  // XenForo-style HTML message
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n\n+/g, "</p><p>")
    .replace(/\n/g, "<br />");
  const message_html = `<p>${escaped}</p>`;

  const body = new URLSearchParams();
  body.set("message_html", message_html);
  body.set("_xfRelativeResolver", page.url);
  if (reply.attachment_hash)
    body.set("attachment_hash", reply.attachment_hash);
  body.set("maxfilesize", "6291456");
  body.set("extensions", "txt,pdf,png,jpg,jpeg,jpe,gif,mp4");
  for (const tag of reply.tags || []) {
    body.append("tinhte_xentag_tags[]", tag);
  }
  body.append("sentiment[]", sentiment);
  body.append("is_held[]", is_held);
  if (reply.last_date) body.set("last_date", reply.last_date);
  body.set("_xfToken", reply.xfToken);
  body.set("content_type", "post");
  body.set("thread_id", reply.thread_id);

  if (dry_run) {
    return {
      ok: true,
      dry_run: true,
      would_post_to: reply.action,
      thread_id: reply.thread_id,
      message_html,
      fields: Object.fromEntries(body.entries()),
    };
  }

  const res = await hcFetch(reply.action, {
    method: "POST",
    body,
    headers: {
      Origin: BASE,
      Referer: page.url,
    },
  });

  // Success usually redirects back to thread with new post
  const success =
    res.ok &&
    (res.url.includes("/threads/") ||
      res.text.includes("message") ||
      res.status === 303 ||
      res.status === 302);

  return {
    ok: success,
    status: res.status,
    final_url: res.url,
    thread_id: reply.thread_id,
    note: success
      ? "Reply submitted. Verify on HotCopper."
      : "Post may have failed — check status and final_url",
    preview: res.text.slice(0, 500),
  };
}

export async function watchlistSummary() {
  const res = await getHtml("/account/");
  // Account page lists watchlist tickers in ticker bar sometimes
  const $ = (await import("cheerio")).load(res.text);
  const tickers = [];
  $('a[href*="/asx/"]').each((_, a) => {
    const m = ($(a).attr("href") || "").match(/\/asx\/([a-z0-9]+)/i);
    const code = m?.[1]?.toUpperCase();
    const text = ($(a).text() || "").trim();
    if (code && text && text.length <= 6) {
      tickers.push(code);
    }
  });
  return {
    url: res.url,
    auth: authInfo(),
    tickers_seen: [...new Set(tickers)].slice(0, 50),
  };
}
