# HotCopper MCP

Unofficial [Model Context Protocol](https://modelcontextprotocol.io) server for [HotCopper](https://hotcopper.com.au/) — Australia’s largest ASX share-trading forum.

HotCopper has **no public API**. This server reverse-engineers the site’s session cookies and HTML pages so agents can search, read threads, and (optionally) reply as a logged-in user.

> **Not affiliated with HotCopper / Gumtree Australia Markets.** Personal use only. Respect HotCopper’s terms of service and rate limits. Never commit session cookies.

## Features

| Tool | Description |
|------|-------------|
| `auth_status` | Whether a session is loaded (`xf_user` / `xf_session`) |
| `latest_posts` | Live feed (`/postview/`) |
| `stock_threads` | Discussion threads for an ASX ticker |
| `get_thread` | Read posts in a thread |
| `search` | Site search |
| `get_news` | Homepage news / opinion |
| `watchlist_summary` | Account page + auth summary |
| `reply_to_thread` | Post a reply (`confirm=true` required; supports `dry_run`) |

## Requirements

- Node.js 20+
- A HotCopper account
- Playwright Chromium (for the one-time login capture)

## Install

```bash
git clone https://github.com/mKlus/hotcopper-mcp.git
cd hotcopper-mcp
npm install
npx playwright install chromium
```

## Authenticate (once)

```bash
npm run capture
# or use your installed Google Chrome:
npm run capture:chrome
```

1. A browser window opens on HotCopper.
2. Log in.
3. Optionally browse search / a stock / a thread so capture notes the flows.
4. Press **Enter** in the terminal (or `touch auth/DONE`).

This writes (gitignored):

- `auth/storage-state.json` — Playwright storage state (cookies)
- `auth/cookies.json` — cookie jar dump
- `captures/*` — optional network HAR / endpoint summary

Re-run capture when the session expires.

## Run the MCP server

```bash
npm start
```

### Grok

```toml
[mcp_servers.hotcopper]
command = "node"
args = ["/absolute/path/to/hotcopper-mcp/src/server.js"]
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 120
```

```bash
grok mcp add hotcopper -- node /absolute/path/to/hotcopper-mcp/src/server.js
```

### Claude Desktop / Cursor

Add a stdio MCP server pointing at `node` + `src/server.js` (same as above).

## Smoke test

With a valid `auth/storage-state.json`:

```bash
npm run smoke
```

## Architecture

```
capture (Playwright, headed)
    → auth/storage-state.json
         ↓
MCP tools → HTTP + Cheerio HTML parse
    → latest posts / stock threads / thread body / search / reply
```

### Reverse-engineered surface

- **Auth**: XenForo-style cookies `xf_user`, `xf_session`
- **Search**: `POST /search/search/` with `keywords`, `visitorXfToken`, `user_id`
- **Reply**: `POST /threads/{slug}.{id}/add-reply` with `message_html`, `_xfToken`, `thread_id`
- **Reads**: server-rendered HTML (`/postview/`, `/asx/{ticker}/`, `/threads/…`)

There is no stable official JSON API for forum content; parsers may need updates if HotCopper changes markup.

## Safety

- `auth/` and `captures/` are gitignored — **do not commit them**.
- `reply_to_thread` refuses to post unless `confirm=true`. Prefer `dry_run=true` first.
- Use your own account; do not mass-scrape or spam.

## Development

```bash
npm run capture      # headed login + network sniff
npm run analyze     # summarize latest captures/endpoints-*.json
npm run smoke       # exercise read tools
npm start           # stdio MCP server
```

## License

MIT — see [LICENSE](LICENSE).
