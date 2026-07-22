#!/usr/bin/env node
/** Quick smoke test of read APIs with saved session. */
import * as api from "../src/api.js";

console.log("auth:", api.getAuthStatus());

const latest = await api.latestPosts({ limit: 5 });
console.log("\nlatest_posts:", latest.posts.length);
console.log(latest.posts.slice(0, 3));

const stock = await api.stockThreads("PLS", { limit: 8 });
console.log("\nstock_threads PLS:", stock.threads?.length, stock.heading);
console.log(stock.threads?.slice(0, 5));

if (stock.threads?.[0]?.url) {
  const thr = await api.getThread(stock.threads[0].url, { limit: 3 });
  console.log("\nget_thread posts:", thr.post_count, thr.title);
  console.log(thr.posts?.slice(0, 2));
  console.log("can_reply:", thr.reply?.can_reply);
}

const search = await api.search("PLS", { limit: 5 });
console.log("\nsearch:", search.results?.length, search.url);
console.log(search.results?.slice(0, 3));

const news = await api.getNews({ limit: 5 });
console.log("\nnews:", news.articles?.length);
console.log(news.articles?.slice(0, 3));

console.log("\nOK");
