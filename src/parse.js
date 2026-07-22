/**
 * HTML parsers for HotCopper pages.
 */
import * as cheerio from "cheerio";
import { absoluteUrl, BASE } from "./client.js";

function clean(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function threadIdFromHref(href) {
  if (!href) return null;
  const m = href.match(/\/threads\/[^/]*\.(\d+)/);
  return m ? m[1] : null;
}

function postIdFromHref(href) {
  if (!href) return null;
  const m =
    href.match(/[?&]post_id=(\d+)/) ||
    href.match(/#post-(\d+)/) ||
    href.match(/\/posts\/(\d+)/);
  return m ? m[1] : null;
}

/** Extract visitorXfToken / _xfToken from any page. */
export function extractTokens(html) {
  const $ = cheerio.load(html);
  const visitorXfToken =
    $('input[name="visitorXfToken"]').attr("value") || null;
  const xfToken = $('input[name="_xfToken"]').attr("value") || null;
  const userId =
    $('input[name="user_id"]').attr("value") ||
    (visitorXfToken ? visitorXfToken.split(",")[0] : null);
  return { visitorXfToken, xfToken, userId };
}

/**
 * Parse latest posts / postview / similar table listings.
 */
export function parsePostList(html, { limit = 40 } = {}) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $("table tr").each((_, tr) => {
    const $tr = $(tr);
    const subjectA = $tr
      .find('a[href*="/threads/"]')
      .filter((_, a) => {
        const t = clean($(a).text());
        return t && t !== "Thread" && !/^page/i.test(t) && !/^\d+$/.test(t);
      })
      .first();
    if (!subjectA.length) return;

    const href = subjectA.attr("href");
    if (!href || href.includes("javascript")) return;
    const key = href.split("#")[0];
    if (seen.has(key)) return;
    seen.add(key);

    const cells = $tr
      .find("td")
      .map((__, td) => clean($(td).text()))
      .get();

    const forum = cells[0] || null;
    const stockA = $tr.find('a[href*="/asx/"]').first();
    const stock = clean(stockA.text()) || null;
    const stock_url = stockA.attr("href")
      ? absoluteUrl(stockA.attr("href"))
      : null;

    let poster = null;
    $tr.find("a").each((__, a) => {
      const h = $(a).attr("href") || "";
      if (
        h.includes("users=") ||
        h.includes("/members/") ||
        h.includes("/search/search")
      ) {
        const t = clean($(a).text());
        if (t && t !== stock && t !== "Thread") poster = t;
      }
    });

    // Typical cells: forum, stock, subject, Thread, poster, replies, views, likes?, time
    const time =
      cells.find((c) => /^\d{1,2}:\d{2}$/.test(c) || /\d+[hm]$/i.test(c)) ||
      cells[cells.length - 1] ||
      null;

    items.push({
      subject: clean(subjectA.text()),
      url: absoluteUrl(href),
      thread_id: threadIdFromHref(href),
      post_id: postIdFromHref(href),
      forum,
      stock,
      stock_url,
      poster,
      replies: cells[5] || null,
      views: cells[6] || null,
      time,
    });
  });

  return items.slice(0, limit);
}

/**
 * Parse stock discussion thread list from /asx/{ticker}/
 */
export function parseStockPage(html, { limit = 40 } = {}) {
  const $ = cheerio.load(html);
  const title = clean($("title").text());
  const h1 = clean($("h1").first().text());

  // Company blurb
  let market_cap = null;
  const bodyText = clean($("body").text());
  const mcap = bodyText.match(/Market Cap\s*\$?([\d.,]+[BMKbmK]?)/);
  if (mcap) market_cap = mcap[1];

  const threads = [];
  const seen = new Set();

  // Prefer subject links in discussion tables
  $("table tr, .thread-list tr, .structItem").each((_, el) => {
    const $el = $(el);
    const links = $el.find('a[href*="/threads/"]');
    let subjectA = null;
    links.each((__, a) => {
      const t = clean($(a).text());
      const href = $(a).attr("href") || "";
      if (
        t &&
        t !== "Thread" &&
        !/^\d+$/.test(t) &&
        !href.includes("page-") &&
        !href.includes("post_id")
      ) {
        subjectA = $(a);
        return false;
      }
    });
    // fallback: first thread link without page-
    if (!subjectA) {
      const cand = links
        .toArray()
        .map((a) => $(a))
        .find((a) => {
          const href = a.attr("href") || "";
          return (
            href.includes("/threads/") &&
            !href.includes("page-") &&
            !/^\d+$/.test(clean(a.text()))
          );
        });
      if (cand) subjectA = cand;
    }
    if (!subjectA) return;

    const href = subjectA.attr("href");
    const tid = threadIdFromHref(href);
    if (!tid || seen.has(tid)) return;
    // skip if text empty and only pagination-ish
    const subject = clean(subjectA.text());
    // Try title attribute or nearby text
    let finalSubject = subject;
    if (!finalSubject) {
      finalSubject =
        clean(subjectA.attr("title")) ||
        clean($el.find("a[title]").first().attr("title")) ||
        `Thread ${tid}`;
    }
    // Prefer non-page base URL
    const baseHref = href.replace(/\/page-\d+.*/, "/").replace(/\?.*$/, "");
    seen.add(tid);
    threads.push({
      subject: finalSubject,
      url: absoluteUrl(baseHref.endsWith("/") ? baseHref : baseHref + "/"),
      thread_id: tid,
    });
  });

  // Fallback: unique thread base URLs from page
  if (threads.length < 3) {
    $('a[href*="/threads/"]').each((_, a) => {
      const href = $(a).attr("href") || "";
      const tid = threadIdFromHref(href);
      if (!tid || seen.has(tid)) return;
      if (href.includes("page-") || href.includes("post_id")) return;
      const subject = clean($(a).text());
      if (!subject || subject === "Thread" || /^\d+$/.test(subject)) return;
      seen.add(tid);
      threads.push({
        subject,
        url: absoluteUrl(href.split("?")[0]),
        thread_id: tid,
      });
    });
  }

  return {
    title,
    heading: h1 || null,
    market_cap,
    threads: threads.slice(0, limit),
  };
}

/**
 * Parse a thread page into posts.
 */
export function parseThread(html, { limit = 50 } = {}) {
  const $ = cheerio.load(html);
  const title = clean($("title").text());
  const threadTitle =
    clean($(".thread-content h1, h1").first().text()) || title;

  const posts = [];
  $(".post-message").each((_, el) => {
    const $el = $(el);
    const idAttr = $el.attr("id") || "";
    const postId = (idAttr.match(/post-(\d+)/) || [])[1] || null;
    const author =
      clean($el.attr("data-author")) ||
      clean($el.find(".user-username").first().text()) ||
      clean($el.find("a.username").first().text()) ||
      null;
    const userIdMatch = ($el.attr("class") || "").match(
      /post-user-id-(\d+)/
    );
    const date = clean($el.find(".post-metadata-date").first().text());
    const time = clean($el.find(".post-metadata-time").first().text());
    const text = clean($el.find(".message-text").first().text());
    const htmlBody = $el.find(".message-text").first().html() || null;

    if (!text && !author) return;
    posts.push({
      post_id: postId,
      author,
      user_id: userIdMatch ? userIdMatch[1] : null,
      date: date || null,
      time: time || null,
      text,
      html: htmlBody ? htmlBody.slice(0, 8000) : null,
      url: postId ? `${BASE}/posts/${postId}/` : null,
    });
  });

  // Reply form meta
  const replyForm = $('form[action*="add-reply"]').first();
  const reply = {
    can_reply: replyForm.length > 0,
    action: replyForm.attr("action")
      ? absoluteUrl(replyForm.attr("action"))
      : null,
    thread_id: replyForm.find('input[name="thread_id"]').attr("value") || null,
    xfToken: replyForm.find('input[name="_xfToken"]').attr("value") || null,
    attachment_hash:
      replyForm.find('input[name="attachment_hash"]').attr("value") || null,
    last_date: replyForm.find('input[name="last_date"]').attr("value") || null,
    tags: replyForm
      .find('input[name="tinhte_xentag_tags[]"]')
      .map((__, i) => $(i).attr("value"))
      .get(),
  };

  return {
    title: threadTitle,
    page_title: title,
    post_count: posts.length,
    posts: posts.slice(0, limit),
    reply,
  };
}

export function parseSearchResults(html, { limit = 40 } = {}) {
  // Search results often look like post lists
  const list = parsePostList(html, { limit });
  if (list.length) return { results: list, mode: "post_list" };

  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();
  $('a[href*="/threads/"]').each((_, a) => {
    const href = $(a).attr("href") || "";
    const tid = threadIdFromHref(href);
    const subject = clean($(a).text());
    if (!tid || !subject || subject === "Thread" || /^\d+$/.test(subject))
      return;
    if (seen.has(tid + subject)) return;
    seen.add(tid + subject);
    results.push({
      subject,
      url: absoluteUrl(href),
      thread_id: tid,
      post_id: postIdFromHref(href),
    });
  });
  return { results: results.slice(0, limit), mode: "links" };
}

export function parseNewsList(html, { limit = 20 } = {}) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();
  $('a[href*="/news/"], a[href*="/opinion/"]').each((_, a) => {
    const href = $(a).attr("href") || "";
    const title = clean($(a).text());
    if (!title || title.length < 12) return;
    if (!/\/(news|opinion)\/[^/]+\/\d+\//.test(href) && !/\/\d+\//.test(href))
      return;
    const url = absoluteUrl(href);
    if (seen.has(url)) return;
    seen.add(url);
    items.push({ title, url });
  });
  return items.slice(0, limit);
}
