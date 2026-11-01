#!/usr/bin/env node
// MCP server: lets Claude use Facebook Marketplace like the signed-in user, through a real browser.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { closeContext, openVisibleBrowser, currentUserId, PROFILE_DIR } from './browser.js';
import {
  searchListings,
  getListing,
  getSellerProfile,
  savedListings,
  setSaved,
  yourListings,
  setLocation,
  SORT_OPTIONS,
  CONDITIONS,
} from './marketplace.js';
import { messageSeller, listConversations, readConversation, replyToConversation } from './messaging.js';
import { createListingDraft, publishListing, updateListingStatus } from './selling.js';
import * as browser from './control.js';

const INSTRUCTIONS = `
Facebook Marketplace, driven through a real Chromium browser signed in as the user.
You can do everything they can: search, open listings, view photos, check sellers, save
items, message sellers, read and answer chats, and create or manage their own listings.

How to work:
- Prefer the marketplace_* tools; they return structured data. When one fails or something
  isn't covered, use browser_snapshot to see the page, then browser_click / browser_type with
  the [ref=eN] values. The structured and browser_* tools share one tab, so after
  marketplace_get_listing you can snapshot and act on that same listing.
- Use marketplace_get_listing with photos > 0 to see item photos when condition matters.
- If a tool says login, a checkpoint or a Messenger PIN is needed, call marketplace_login;
  a window opens on the user's computer for them to finish it. Never ask for their password.

Acting for the user:
- Messages, replies, publishing, marking sold and deleting are visible to other people. Do
  them when the user asked for them (e.g. "message the 3 best sellers asking if they can do
  $80"). When intent is unclear, show the draft first and ask.
- Never agree to pay, share the user's phone number, address or payment details, or move to
  another app unless the user explicitly told you to. Flag scam signs (deposits up front,
  gift cards, Zelle to strangers, verification codes, "shipping only" for local bulky items).
- Pace yourself; Facebook limits accounts that act too fast. A send cap is enforced.
`.trim();

const server = new McpServer({ name: 'facebook-marketplace', version: '0.2.0' }, { instructions: INSTRUCTIONS });

const json = (obj) => ({ type: 'text', text: JSON.stringify(obj, null, 2) });
const img = (buf, mimeType = 'image/jpeg') => ({ type: 'image', data: Buffer.from(buf).toString('base64'), mimeType });

function wrap(fn) {
  return async (args) => {
    try {
      return { content: await fn(args ?? {}) };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  };
}

/** Pull a `screenshot` buffer out of a result into an image block. */
function withShot(res) {
  const { screenshot, ...rest } = res;
  return [json(rest), ...(screenshot ? [img(screenshot)] : [])];
}

const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
const tool = (name, title, description, inputSchema, annotations, handler) =>
  server.registerTool(name, { title, description, inputSchema, annotations: { title, ...annotations } }, wrap(handler));

const listingArg = z.string().describe('Listing URL (facebook.com/marketplace/item/...) or numeric listing id.');
const threadArg = z
  .string()
  .describe('Conversation: thread id or URL from marketplace_list_conversations (…/messages/t/<id>), or a listing URL/id you have already messaged about.');

// ── Browsing ────────────────────────────────────────────────────────────────

tool(
  'marketplace_search',
  'Search Marketplace',
  "Search listings, browse a category, or (with neither) browse the Marketplace home feed. Returns title, price, location, seller, photo, status and link for each. Without location, the account's saved Marketplace location is used.",
  {
    query: z.string().optional().describe('Search terms, e.g. "standing desk". Omit to browse a category or the home feed.'),
    location: z.string().optional().describe('Location slug or numeric id from Marketplace URLs, e.g. "nyc", "la", "sanfrancisco", "chicago", "108424279189115". For another city by name, use marketplace_set_location first.'),
    category: z.string().optional().describe('Category slug, e.g. "vehicles", "propertyrentals", "electronics", "furniture", "free", "toys", "instruments", "sports".'),
    min_price: z.number().int().nonnegative().optional(),
    max_price: z.number().int().nonnegative().optional(),
    sort: z.enum(Object.keys(SORT_OPTIONS)).optional(),
    days_since_listed: z.union([z.literal(1), z.literal(7), z.literal(30)]).optional(),
    conditions: z.array(z.enum(CONDITIONS)).optional(),
    delivery: z.enum(['pickup', 'shipping']).optional(),
    radius_km: z.number().int().positive().optional().describe('Search radius in kilometres.'),
    include_sold: z.boolean().optional().describe('Keep listings marked sold (default true; they are flagged isSold).'),
    limit: z.number().int().min(1).max(100).optional().describe('Max listings (default 24). More = more scrolling.'),
  },
  READ,
  async (a) => {
    return [
      json(
        await searchListings({
          query: a.query,
          location: a.location,
          category: a.category,
          minPrice: a.min_price,
          maxPrice: a.max_price,
          sort: a.sort,
          daysSinceListed: a.days_since_listed,
          conditions: a.conditions,
          delivery: a.delivery,
          radiusKm: a.radius_km,
          includeSold: a.include_sold ?? true,
          limit: a.limit,
        })
      ),
    ];
  }
);

tool(
  'marketplace_get_listing',
  'Open a listing',
  'Full details of one listing: title, price, description, condition, location, seller (with profile link), status (available/pending/sold), delivery, whether you already messaged or saved it, photo URLs and page text. photos: N returns the first N photos as images so you can inspect the item.',
  {
    listing: listingArg,
    photos: z.number().int().min(0).max(8).optional().describe('How many listing photos to return as images (default 0).'),
    screenshot: z.boolean().optional().describe('Also return a screenshot of the listing page.'),
  },
  READ,
  async ({ listing, photos, screenshot }) => {
    const res = await getListing(listing, { photos, screenshot });
    return [json(res.listing), ...res.images.map((i) => img(i.data, i.mimeType)), ...(res.screenshot ? [img(res.screenshot)] : [])];
  }
);

tool(
  'marketplace_seller_profile',
  'View a seller',
  "A seller's Marketplace profile: name, rating, join date, badges, and their other listings. Use it to judge trustworthiness.",
  {
    seller: z.string().describe('Seller id or profile URL (facebook.com/marketplace/profile/<id>), e.g. from marketplace_get_listing seller.profileUrl.'),
    limit: z.number().int().min(1).max(100).optional(),
  },
  READ,
  async ({ seller, limit }) => [json(await getSellerProfile(seller, { limit }))]
);

tool('marketplace_saved_listings', 'Saved listings', "The user's saved Marketplace items.", { limit: z.number().int().min(1).max(100).optional() }, READ, async ({ limit }) => [
  json(await savedListings({ limit })),
]);

tool(
  'marketplace_your_listings',
  'Your listings',
  "Items the user is selling, with status (active/sold/pending), clicks and the actions Facebook offers.",
  { limit: z.number().int().min(1).max(100).optional() },
  READ,
  async ({ limit }) => [json(await yourListings({ limit }))]
);

tool(
  'marketplace_list_conversations',
  'Inbox',
  'Marketplace conversations (buying and selling): who, listing, last message preview, unread flag, thread id.',
  {
    tab: z.enum(['buying', 'selling']).optional().describe('Filter to the Buying or Selling tab of the Marketplace inbox.'),
    limit: z.number().int().min(1).max(100).optional(),
  },
  READ,
  async ({ tab, limit }) => [json(await listConversations({ tab, limit }))]
);

tool(
  'marketplace_read_conversation',
  'Read a conversation',
  'Messages in one conversation, oldest first, with sender and time (falls back to the raw chat text).',
  { conversation: threadArg, limit: z.number().int().min(1).max(200).optional() },
  READ,
  async ({ conversation, limit }) => [json(await readConversation(conversation, { limit }))]
);

// ── Acting as the user ──────────────────────────────────────────────────────

tool(
  'marketplace_message_seller',
  'Message a seller',
  'Send a message to the seller of a listing as the user. Starts a new conversation, or sends a follow-up if one exists. Returns sent / probably_sent / rate_limited. If probably_sent, check with marketplace_read_conversation before retrying.',
  { listing: listingArg, message: z.string().min(1).max(2000).describe('Exact text to send. Line breaks are kept.') },
  WRITE,
  async ({ listing, message }) => [json(await messageSeller(listing, message))]
);

tool(
  'marketplace_reply',
  'Reply in a conversation',
  'Send a message in an existing conversation (as buyer or seller).',
  { conversation: threadArg, message: z.string().min(1).max(2000) },
  WRITE,
  async ({ conversation, message }) => [json(await replyToConversation(conversation, message))]
);

tool(
  'marketplace_save_listing',
  'Save / unsave a listing',
  "Add a listing to, or remove it from, the user's saved items.",
  { listing: listingArg, save: z.boolean().optional().describe('true to save (default), false to unsave.') },
  WRITE,
  async ({ listing, save }) => [json(await setSaved(listing, save ?? true))]
);

tool(
  'marketplace_set_location',
  'Set browsing location',
  "Change the account's Marketplace location (city/ZIP) and optionally radius, through the location dialog. Searches without a location slug then use it.",
  {
    location: z.string().describe('City, neighbourhood or ZIP, e.g. "Portland, OR" or "94110".'),
    radius_km: z.number().int().positive().optional(),
  },
  WRITE,
  async ({ location, radius_km }) => withShot(await setLocation(location, { radiusKm: radius_km }))
);

tool(
  'marketplace_create_listing',
  'Draft a listing',
  'Open "Create new listing" and fill it in: photos, title, price, category, condition, description, location. Does NOT publish. Returns a screenshot to show the user; publish with marketplace_publish_listing once they approve.',
  {
    title: z.string().min(1),
    price: z.number().nonnegative(),
    photos: z.array(z.string()).optional().describe("Absolute paths to image files on the user's computer."),
    category: z.string().optional().describe('Category name exactly as Facebook shows it, e.g. "Furniture", "Electronics & computers".'),
    condition: z.enum(['New', 'Used - Like New', 'Used - Good', 'Used - Fair']).optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    hide_from_friends: z.boolean().optional(),
  },
  WRITE,
  async (a) =>
    withShot(
      await createListingDraft({
        title: a.title,
        price: a.price,
        photos: a.photos,
        category: a.category,
        condition: a.condition,
        description: a.description,
        location: a.location,
        hideFromFriends: a.hide_from_friends,
      })
    )
);

tool('marketplace_publish_listing', 'Publish the drafted listing', 'Click Next/Publish on the listing form opened by marketplace_create_listing.', {}, WRITE, async () =>
  withShot(await publishListing())
);

tool(
  'marketplace_update_listing',
  "Change one of your listings",
  "Mark one of the user's own listings sold, available or pending, or delete it.",
  { listing: listingArg, status: z.enum(['sold', 'available', 'pending', 'delete']) },
  DESTRUCTIVE,
  async ({ listing, status }) => withShot(await updateListingStatus(listing, status))
);

// ── Session ─────────────────────────────────────────────────────────────────

tool('marketplace_status', 'Login status', 'Whether the browser profile is signed in to Facebook.', {}, READ, async () => {
  const id = await currentUserId();
  return [json({ loggedIn: Boolean(id), userId: id, profileDir: PROFILE_DIR })];
});

tool(
  'marketplace_login',
  'Open a browser window for the user',
  "Open a visible browser on the user's computer so THEY can sign in, pass a security checkpoint, or enter their Messenger PIN. Waits up to 5 minutes. With url, opens that page and waits until the user closes the window.",
  {
    url: z.string().optional().describe('Page to open instead of the login page, e.g. "https://www.facebook.com/messages/" for the PIN prompt.'),
  },
  WRITE,
  async ({ url }) => [json(await openVisibleBrowser({ url: url && browser.assertAllowedUrl(url), waitForClose: Boolean(url) }))]
);

// ── General browser control ─────────────────────────────────────────────────

const refArg = z.string().optional().describe('Element ref from browser_snapshot, e.g. "e42".');
const textArg = z.string().optional().describe('Alternative to ref: visible text / accessible name to match.');
const roleArg = z.string().optional().describe('With text: ARIA role to match, e.g. "button", "link", "textbox", "tab".');

tool('browser_navigate', 'Go to a Facebook page', 'Open a facebook.com / messenger.com URL in the shared tab and return a snapshot.', { url: z.string() }, READ, async ({ url }) => [
  json(await browser.browserNavigate(url)),
]);

tool(
  'browser_snapshot',
  'Snapshot the page',
  'Accessibility snapshot of the current page with [ref=eN] for each element. Defaults to the open dialog if any, else the main content.',
  { scope: z.enum(['auto', 'main', 'dialog', 'page']).optional() },
  READ,
  async ({ scope }) => [json(await browser.browserSnapshot(scope ?? 'auto'))]
);

tool('browser_click', 'Click', 'Click an element by ref (or by text).', { ref: refArg, text: textArg, role: roleArg, double: z.boolean().optional() }, WRITE, async (a) => [
  json(await browser.browserClick(a)),
]);

tool(
  'browser_type',
  'Type',
  'Type into a text field or message box by ref (or text). Replaces existing text unless clear=false. submit=true presses Enter, which SENDS in chat boxes.',
  { ref: refArg, text: textArg, role: roleArg, value: z.string(), submit: z.boolean().optional(), clear: z.boolean().optional() },
  WRITE,
  async (a) => [json(await browser.browserType(a))]
);

tool('browser_press_key', 'Press a key', 'Press a key or chord, e.g. "Enter", "Escape", "PageDown", "Control+A".', { key: z.string() }, WRITE, async ({ key }) => [
  json(await browser.browserPressKey(key)),
]);

tool('browser_select_option', 'Select option', 'Choose option(s) in a native <select> by ref.', { ref: z.string(), values: z.array(z.string()) }, WRITE, async (a) => [
  json(await browser.browserSelectOption(a)),
]);

tool('browser_hover', 'Hover', 'Hover over an element (reveals some menus and tooltips).', { ref: refArg, text: textArg }, READ, async (a) => [json(await browser.browserHover(a))]);

tool(
  'browser_scroll',
  'Scroll',
  'Scroll the page to load more results or reveal content.',
  { direction: z.enum(['down', 'up']).optional(), amount: z.number().int().min(1).max(10).optional().describe('Screens to scroll (default 1).') },
  READ,
  async (a) => [json(await browser.browserScroll(a))]
);

tool('browser_back', 'Go back', 'Browser back button.', {}, READ, async () => [json(await browser.browserBack())]);

tool(
  'browser_wait',
  'Wait',
  'Wait for text to appear, or a number of seconds.',
  { text: z.string().optional(), seconds: z.number().min(0).max(60).optional() },
  READ,
  async (a) => [json(await browser.browserWait(a))]
);

tool(
  'browser_screenshot',
  'Screenshot',
  'See the current page (or one element by ref) as an image.',
  { full_page: z.boolean().optional(), ref: refArg },
  READ,
  async ({ full_page, ref }) => {
    const { image, ...info } = await browser.browserScreenshot({ fullPage: full_page, ref });
    return [json(info), img(image)];
  }
);

tool(
  'browser_upload_files',
  'Upload files',
  "Attach files from the user's computer: pass the ref of an \"Add photos\" button (or omit ref to use the page's first file input).",
  { paths: z.array(z.string()).min(1), ref: refArg },
  WRITE,
  async (a) => [json(await browser.browserUploadFiles(a))]
);

const shutdown = async () => {
  await closeContext();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
