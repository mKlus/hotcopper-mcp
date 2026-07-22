/**
 * High-level HotCopper operations used by MCP tools.
 */
import {
  authInfo,
  getHtml,
  hcFetch,
  resolveHotCopperUrl,
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
  const raw = String(threadRef).trim();
  if (/^\d+$/.test(raw)) {
    throw new Error(
      "Pass a full thread URL or path like /threads/subject.12345/ (not bare id alone)"
    );
  }
  let absolute = resolveHotCopperUrl(raw);
  if (page != null && !/\/page-\d+/.test(absolute)) {
    const u = new URL(absolute);
    u.pathname = u.pathname.replace(/\/?$/, `/page-${page}`);
    absolute = u.toString();
  }
  const res = await getHtml(absolute);
  const parsed = parseThread(res.text, { limit });
  // Never return live CSRF tokens to the model/logs
  if (parsed.reply) {
    parsed.reply = {
      can_reply: parsed.reply.can_reply,
      thread_id: parsed.reply.thread_id,
      // omit xfToken / attachment_hash from tool output
    };
  }
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

  const absolute = resolveHotCopperUrl(thread_url);
  const page = await getHtml(absolute);
  const parsed = parseThread(page.text, { limit: 1 });
  if (!parsed.reply?.can_reply || !parsed.reply.action) {
    return {
      ok: false,
      error:
        "Reply form not found — not logged in, thread locked, or layout changed",
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

  const action = resolveHotCopperUrl(reply.action);

  if (dry_run) {
    return {
      ok: true,
      dry_run: true,
      would_post_to: action,
      thread_id: reply.thread_id,
      message_preview: message.slice(0, 500),
      // Do not echo CSRF tokens or full form fields into MCP logs
      field_names: [...body.keys()],
    };
  }

  const res = await hcFetch(action, {
    method: "POST",
    body,
    headers: {
      Origin: BASE,
      Referer: page.url,
    },
  });

  // Prefer URL-based success; avoid matching arbitrary HTML containing "message"
  const success =
    res.ok &&
    (res.url.includes("/threads/") ||
      res.url.includes("/posts/") ||
      res.status === 200);

  return {
    ok: success,
    status: res.status,
    final_url: res.url,
    thread_id: reply.thread_id,
    note: success
      ? "Reply submitted. Verify on HotCopper."
      : "Post may have failed — check status and final_url",
    // Avoid dumping HTML that may include tokens/session UI
    response_snippet: res.text.replace(/\s+/g, " ").slice(0, 200),
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
