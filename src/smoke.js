#!/usr/bin/env node
// `npm run smoke` — after `npm run login`, checks every READ-ONLY feature against your real
// account and prints PASS/FAIL per feature. Sends nothing, saves nothing, publishes nothing.
// Usage: npm run smoke -- [search terms] [--location nyc]
import { closeContext, currentUserId, DATA_DIR } from './browser.js';
import { searchListings, getListing, getSellerProfile, savedListings, yourListings } from './marketplace.js';
import { listConversations, readConversation } from './messaging.js';
import { browserSnapshot } from './control.js';

const args = process.argv.slice(2);
const locIdx = args.indexOf('--location');
const location = locIdx >= 0 ? args.splice(locIdx, 2)[1] : undefined;
const query = args.join(' ') || 'desk';

const results = [];
async function check(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)  ${detail ?? ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`FAIL  ${name}  ${err.message.split('\n')[0]}`);
  }
}
const need = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const me = await currentUserId();
if (!me) {
  console.log('Not logged in. Run `npm run login` first.');
  process.exit(1);
}
console.log(`Logged in as user ${me}. Running read-only checks (query "${query}"${location ? `, location ${location}` : ''})...\n`);

let listing, sellerId, threadId;

await check('home feed', async () => {
  const r = await searchListings({ location, limit: 10 });
  need(r.count > 0, r.note || 'no listings');
  return `${r.count} listings`;
});

await check('search', async () => {
  const r = await searchListings({ query, location, limit: 15, sort: 'newest' });
  need(r.count > 0, r.note || 'no listings');
  const withJson = r.listings.filter((l) => l.seller || l.createdAt).length;
  listing = r.listings.find((l) => !l.isSold) || r.listings[0];
  return `${r.count} listings, ${withJson} with full JSON data; first: "${listing.title}" ${listing.price}`;
});

await check('search filters (price + pickup)', async () => {
  const r = await searchListings({ query, location, maxPrice: 100, delivery: 'pickup', limit: 8 });
  const over = r.listings.filter((l) => l.priceAmount > 100);
  need(r.count > 0, r.note || 'no listings');
  return `${r.count} listings${over.length ? `, WARNING ${over.length} above max price` : ''}`;
});

await check('listing details + photos', async () => {
  need(listing, 'no listing from search to open');
  const r = await getListing(listing.id, { photos: 2 });
  const l = r.listing;
  need(l.title, 'no title');
  need(l.price, 'no price');
  sellerId = l.seller?.id;
  const missing = ['description', 'condition', 'location'].filter((k) => !l[k]);
  if (!l.seller?.id) missing.push('seller id');
  return `"${l.title}" ${l.price}, ${l.photos?.length ?? 0} photo URLs, ${r.images.length} images fetched${missing.length ? `; missing: ${missing.join(', ')}` : ''}`;
});

await check('seller profile', async () => {
  need(sellerId, 'no seller id from listing');
  const r = await getSellerProfile(sellerId, { limit: 5 });
  need(r.name || r.listings.length, 'no name or listings found');
  return `${r.name ?? '(no name)'} · ${r.rating ?? 'no rating'} · ${r.listings.length} listings`;
});

await check('saved listings', async () => {
  const r = await savedListings({ limit: 10 });
  return `${r.count} saved (${r.pageUrl})${r.count ? '' : ' (0 is fine if you have none saved)'}`;
});

await check('your selling listings', async () => {
  const r = await yourListings({ limit: 10 });
  return `${r.listings.length} from JSON, ${r.rows.length} rows from page text (0 is fine if you sell nothing)`;
});

await check('inbox', async () => {
  const r = await listConversations({ limit: 10 });
  threadId = r.conversations[0]?.threadId;
  return `${r.count} conversations (${r.pageUrl})${r.count ? `; latest: ${r.conversations[0].name}` : ''}`;
});

await check('read a conversation', async () => {
  need(threadId, 'no conversation to open (fine if your inbox is empty)');
  const r = await readConversation(threadId, { limit: 10 });
  need(r.messages.length || r.conversationText, 'no messages or text');
  return r.messages.length ? `${r.messages.length} messages parsed` : 'bubbles not parsed; fell back to raw text';
});

await check('browser snapshot', async () => {
  const r = await browserSnapshot('auto');
  need(/\[ref=/.test(r.snapshot), 'no refs in snapshot');
  return `${r.snapshot.length} chars, scope ${r.scope}`;
});

await closeContext();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed.`);
if (failed.length) console.log(`Page HTML for failures is saved in ${DATA_DIR}/debug/. Share those files to get selectors fixed.`);
process.exit(failed.length ? 1 : 0);
