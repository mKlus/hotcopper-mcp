#!/usr/bin/env node
/**
 * HotCopper MCP server (stdio).
 * Unofficial — uses saved browser session cookies + HTML parsing.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as api from "./api.js";

function text(data) {
  return {
    content: [
      {
        type: "text",
        text:
          typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function err(e) {
  return {
    content: [
      {
        type: "text",
        text: `Error: ${e?.message || String(e)}`,
      },
    ],
    isError: true,
  };
}

const server = new McpServer({
  name: "hotcopper",
  version: "0.1.0",
});

server.tool(
  "auth_status",
  "Check whether a HotCopper session is loaded (cookies from npm run capture). Returns user_id if logged in.",
  {},
  async () => {
    try {
      return text(api.getAuthStatus());
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "latest_posts",
  "List latest posts from the HotCopper live feed (/postview/).",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max posts to return (default 30)"),
    page: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Feed page number (default 1)"),
  },
  async ({ limit, page }) => {
    try {
      return text(await api.latestPosts({ limit, page }));
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "stock_threads",
  "List discussion threads for an ASX ticker on HotCopper (e.g. PLS, BHP, CU6).",
  {
    ticker: z
      .string()
      .min(1)
      .max(10)
      .describe("ASX ticker code, e.g. PLS"),
    limit: z.number().int().min(1).max(100).optional(),
  },
  async ({ ticker, limit }) => {
    try {
      return text(await api.stockThreads(ticker, { limit }));
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "get_thread",
  "Read posts from a HotCopper thread. Pass a full URL or path like /threads/subject.12345/ or .../page-3.",
  {
    thread_url: z
      .string()
      .describe(
        "Thread URL or path, e.g. https://hotcopper.com.au/threads/foo.12345/"
      ),
    limit: z.number().int().min(1).max(100).optional(),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Optional page number if not in URL"),
  },
  async ({ thread_url, limit, page }) => {
    try {
      return text(await api.getThread(thread_url, { limit, page }));
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "search",
  "Search HotCopper for keywords or ASX codes (uses the site search form).",
  {
    keywords: z.string().min(1).describe("Search query"),
    limit: z.number().int().min(1).max(100).optional(),
    title_only: z
      .boolean()
      .optional()
      .describe("If true, search titles only"),
  },
  async ({ keywords, limit, title_only }) => {
    try {
      return text(await api.search(keywords, { limit, title_only }));
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "get_news",
  "List recent HotCopper news / opinion articles from the homepage.",
  {
    limit: z.number().int().min(1).max(40).optional(),
  },
  async ({ limit }) => {
    try {
      return text(await api.getNews({ limit }));
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "watchlist_summary",
  "Fetch account page as the logged-in user and summarize visible tickers / auth.",
  {},
  async () => {
    try {
      return text(await api.watchlistSummary());
    } catch (e) {
      return err(e);
    }
  }
);

server.tool(
  "reply_to_thread",
  "Post a reply on a HotCopper thread as the logged-in user. DESTRUCTIVE: requires confirm=true. Use dry_run=true first to preview.",
  {
    thread_url: z
      .string()
      .describe("Thread URL or path to reply to"),
    message: z.string().min(1).describe("Reply body (plain text)"),
    confirm: z
      .boolean()
      .optional()
      .describe("Must be true to actually post"),
    dry_run: z
      .boolean()
      .optional()
      .describe("If true, build payload but do not submit"),
    sentiment: z
      .string()
      .optional()
      .describe("Optional sentiment field if the form expects it"),
  },
  async (args) => {
    try {
      return text(await api.replyToThread(args));
    } catch (e) {
      return err(e);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
