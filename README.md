# Facebook Marketplace MCP

Lets Claude Code browse Facebook Marketplace for you. It searches listings, opens them, reads descriptions and looks at photos, all through a real Chromium browser signed in with **your own** Facebook account.

It only reads. It never messages sellers, makes offers or buys anything.

## Setup (on your own computer)

Needs Node.js 20+.

```bash
git clone <this repo> facebook-marketplace-mcp
cd facebook-marketplace-mcp
npm install
npm run setup      # downloads Chromium for Playwright
npm run login      # a browser window opens: sign in to Facebook, the window closes itself when done
```

Your session is saved in `~/.facebook-marketplace-mcp/profile` and is never stored in this repo.

### Add it to Claude Code

To use it from any folder:

```bash
claude mcp add facebook-marketplace --scope user -- node "$(pwd)/src/server.js"
```

Or just run `claude` inside this folder: the bundled `.mcp.json` registers the server for this project, and the `marketplace-shopping` skill teaches Claude a good search-then-shortlist workflow.

Check it's connected with `/mcp` inside Claude Code.

## Try it

> Find me a standing desk under $200 near Austin, posted in the last week, and shortlist the best 5.

> Is this a good price? https://www.facebook.com/marketplace/item/1234567890/

> Browse free furniture in Chicago and show me anything mid-century.

## Tools

| Tool | What it does |
| --- | --- |
| `marketplace_search` | Search by query and/or category, with location, price range, sort, days since listed, condition, pickup/shipping, radius and limit. Returns title, price, original price, location, link and thumbnail. |
| `marketplace_get_listing` | Open a listing: title, price, condition, description, seller, "listed X ago", photo URLs and raw page text. `screenshot: true` returns an image of the page. |
| `marketplace_page_text` | Fallback: visible text (and an optional screenshot) of any `facebook.com/marketplace` URL. |
| `marketplace_status` | Shows whether the saved browser profile is signed in. |
| `marketplace_login` | Opens a visible browser window so you can sign in. |

**Locations** use the slug from Marketplace URLs (`nyc`, `la`, `sanfrancisco`, `chicago`, ...) or a numeric location id. To find yours, open Marketplace, set your location, and copy the part after `/marketplace/` in the URL. If you leave it out, your account's saved Marketplace location is used.

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `FB_MCP_PROFILE_DIR` | `~/.facebook-marketplace-mcp/profile` | Where the browser profile and login live |
| `FB_MCP_HEADLESS` | `true` | Set `false` to watch the browser work |
| `FB_MCP_MIN_INTERVAL_MS` | `2500` | Minimum gap between page loads |
| `FB_MCP_CHROME_CHANNEL` | (none) | Use an installed browser instead, e.g. `chrome` or `msedge` |
| `FB_MCP_CHROME_PATH` | (none) | Path to a Chromium/Chrome executable |

Pass them with `claude mcp add ... -e FB_MCP_HEADLESS=false -- node ...`.

## Notes

- **Facebook's terms** don't allow automated access. This tool browses slowly, one page at a time, as you, for your own personal shopping. Keep it that way: heavy use could get your account rate-limited or flagged. Use it at your own risk.
- **Facebook changes its page layout often.** The parser relies on stable signals (listing links, headings, page text) and always returns the raw page text too, so Claude can still read a listing when a field comes back empty. If search starts returning nothing, open an issue or adjust `src/marketplace.js`.
- Facebook may occasionally show a checkpoint or ask you to log in again. Run `npm run login`, or ask Claude to use `marketplace_login`.

## Development

```bash
npm test   # parser unit tests + browser tests against mocked Marketplace pages (no account needed)
```
