# Facebook Marketplace MCP

Lets Claude Code use Facebook Marketplace the way you do: search, browse, look at photos, check sellers, save items, message sellers, keep chats going, and list or manage your own items. It runs a real Chromium browser on **your** computer, signed in with **your** Facebook account. Claude drives it through MCP tools.

> **Status:** built and tested against a mock Facebook. Some reads are also checked against the real logged-out site: home feed listings, and the JSON and page-text parsing. Everything that needs your login (listing pages, sellers, saved items, messages, selling) **has not run against your real account yet**. Run `npm run smoke` after setup to check it all, read-only.

## What Claude can do

| Area | Tools |
| --- | --- |
| Find | `marketplace_search` (query, category or home feed; location, price, sort, days listed, condition, pickup/shipping, radius), `marketplace_set_location` |
| Inspect | `marketplace_get_listing` (description, condition, seller, status, delivery, photos **as images**), `marketplace_seller_profile` (rating, join date, other listings) |
| Save | `marketplace_save_listing`, `marketplace_saved_listings` |
| Talk | `marketplace_message_seller` (first message or follow-up), `marketplace_list_conversations`, `marketplace_read_conversation`, `marketplace_reply` |
| Sell | `marketplace_your_listings`, `marketplace_create_listing` (fills the form, doesn't publish), `marketplace_publish_listing`, `marketplace_update_listing` (sold, available, pending, delete) |
| Anything else | `browser_snapshot`, `browser_click`, `browser_type`, `browser_press_key`, `browser_scroll`, `browser_navigate`, `browser_screenshot`, `browser_select_option`, `browser_hover`, `browser_upload_files`, `browser_back`, `browser_wait` |
| Session | `marketplace_status`, `marketplace_login` (opens a window so **you** can sign in, pass a checkpoint or enter your Messenger PIN) |

The structured `marketplace_*` tools return clean data. The `browser_*` tools let Claude see the page (as a list of elements with refs) and click or type anywhere, so it can still do a job when Facebook changes its layout or a feature has no dedicated tool. Both share one tab: Claude can open a listing with `marketplace_get_listing`, then snapshot and act on that same page.

## How it works

- **Data:** Facebook ships each page with embedded JSON and loads more through GraphQL as you scroll (`marketplace_search.feed_units`, `marketplace_listing_title`, `listing_price`, `redacted_description`, `listing_photos`, ...). The server captures both and walks the JSON, so it doesn't depend on exact CSS. Visible page text is the fallback. Field names and UI labels come from public projects that do the same: [kyleronayne/marketplace-api](https://github.com/kyleronayne/marketplace-api), [jlsookiki/secondhand-mcp](https://github.com/jlsookiki/secondhand-mcp), [nikhilweee/opentabs-plugin-facebook-marketplace](https://github.com/nikhilweee/opentabs-plugin-facebook-marketplace), [matthewmiglio/openclaw-facebook-marketplace](https://github.com/matthewmiglio/openclaw-facebook-marketplace), [jackwener/OpenCLI](https://github.com/jackwener/OpenCLI), [GeorgiKeranov/facebook-marketplace-bot](https://github.com/GeorgiKeranov/facebook-marketplace-bot).
- **Actions:** clicks and typing go through accessible names Facebook exposes ("Send seller a message", "Message again", "Write to <seller> · <title>", "Save", "Publish", ...).
- **Browser:** Playwright with a persistent profile at `~/.facebook-marketplace-mcp/profile`. It uses the full Chromium build in headless mode, because the slimmed-down headless build can't reuse a profile you logged into with a visible window.

## Setup (on your computer)

Needs Node.js 20+.

```bash
git clone -b claude/marketplace-mcp https://github.com/opsec-bot/facebook-mcp facebook-marketplace-mcp
cd facebook-marketplace-mcp
npm install
npm run setup     # downloads Chromium for Playwright
npm run login     # a browser window opens: sign in to Facebook; it closes itself when done
npm run pin       # optional: opens Messenger so you can enter your chat PIN, then close the window
npm run smoke     # read-only check of every feature against your account
```

Add it to Claude Code for all your projects:

```bash
claude mcp add facebook-marketplace --scope user -- node "$(pwd)/src/server.js"
```

Or just run `claude` in this folder: `.mcp.json` registers the server, and the `marketplace-shopping` skill teaches Claude the buy and sell workflows. Check it's connected with `/mcp`.

### Let Claude browse without asking every time

Claude Code asks before each MCP tool call by default. To let it browse freely while still asking before anything other people can see, add this to `.claude/settings.json` (this project) or `~/.claude/settings.json` (everywhere):

```json
{
  "permissions": {
    "allow": [
      "mcp__facebook-marketplace__marketplace_search",
      "mcp__facebook-marketplace__marketplace_get_listing",
      "mcp__facebook-marketplace__marketplace_seller_profile",
      "mcp__facebook-marketplace__marketplace_saved_listings",
      "mcp__facebook-marketplace__marketplace_your_listings",
      "mcp__facebook-marketplace__marketplace_list_conversations",
      "mcp__facebook-marketplace__marketplace_read_conversation",
      "mcp__facebook-marketplace__marketplace_status",
      "mcp__facebook-marketplace__browser_snapshot",
      "mcp__facebook-marketplace__browser_screenshot",
      "mcp__facebook-marketplace__browser_scroll",
      "mcp__facebook-marketplace__browser_navigate",
      "mcp__facebook-marketplace__browser_back",
      "mcp__facebook-marketplace__browser_wait",
      "mcp__facebook-marketplace__browser_hover"
    ]
  }
}
```

To let it do *everything* without asking, including messaging and publishing, allow `"mcp__facebook-marketplace"` instead.

## Try it

> Find me a standing desk under $200 near Austin, posted this week. Shortlist the best 5 with photos.

> Message the top 3 asking if they'd take $150 and can do pickup Saturday.

> Check my Marketplace inbox and summarise any replies.

> Is this a good price? https://www.facebook.com/marketplace/item/1234567890/

> List my oak desk for $120. Photos are in ~/Pictures/desk/. Show me the draft before publishing.

## Safety

- **Sent as you.** Messages, replies, published listings and deletions are real. Claude Code asks before each of these tool calls unless you allow them, and the server tells Claude to ask you when your intent is unclear.
- **Drafts aren't published.** `marketplace_create_listing` stops before Publish; `marketplace_publish_listing` is a separate step.
- **Send cap:** at most 20 messages per hour by default (`FB_MCP_MAX_MESSAGES_PER_HOUR`). Facebook's "messaging limit" popup is also detected, and sending stops.
- **Audit log:** every action that changes something is written to `~/.facebook-marketplace-mcp/actions.log`.
- **Your login stays local.** Navigation is limited to facebook.com, messenger.com and fb.com. Claude never sees your password: you sign in yourself in a visible window.
- **Pacing:** one tab, one action at a time, at least 2.5 s between page loads, with small random delays.
- **Facebook's terms** don't allow automated access, and heavy use can get an account rate-limited or restricted. Use it like a person would, for your own buying and selling.

## Troubleshooting

- **Login, checkpoint or PIN messages:** run `npm run login` / `npm run pin`, or let Claude call `marketplace_login`.
- **A tool returns empty fields or errors:** Facebook probably changed something. The page HTML is saved to `~/.facebook-marketplace-mcp/debug/`. Claude can still finish the job with the `browser_*` tools, and the saved HTML shows which selector to fix.
- **"Could not start Chromium":** run `npm run setup`.
- **Watch it work:** `claude mcp add facebook-marketplace -e FB_MCP_HEADLESS=false -- node .../src/server.js`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FB_MCP_DATA_DIR` | `~/.facebook-marketplace-mcp` | Profile, action log, debug dumps |
| `FB_MCP_PROFILE_DIR` | `$FB_MCP_DATA_DIR/profile` | Browser profile (your login) |
| `FB_MCP_HEADLESS` | `true` | `false` to watch the browser |
| `FB_MCP_MIN_INTERVAL_MS` | `2500` | Minimum gap between page loads |
| `FB_MCP_MAX_MESSAGES_PER_HOUR` | `20` | Send cap for messages and replies |
| `FB_MCP_DEBUG_DUMPS` | `true` | Save page HTML when parsing fails |
| `FB_MCP_MAX_SNAPSHOT_CHARS` | `40000` | Cap on `browser_snapshot` size |
| `FB_MCP_LOCALE` / `FB_MCP_TIMEZONE` | `en-US` / system | Browser locale and time zone. Keep `en-US`: button names are matched in English |
| `FB_MCP_CHROME_CHANNEL` / `FB_MCP_CHROME_PATH` | `chromium` / none | Use installed Chrome (`chrome`) or a specific binary |

## Development

```bash
npm test   # 21 tests: parsers, every tool against a mock Facebook in a real browser, and the MCP server over stdio
```

`test/mockfb.js` is the fake Facebook. When the real site changes, put the new structure in the mock first, then fix `src/`.
