// Drives the real browser code against mocked Marketplace pages (no Facebook account needed).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FB_MCP_PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbmcp-'));
process.env.FB_MCP_MIN_INTERVAL_MS = '0';
const { getContext, closeContext } = await import('../src/browser.js');
const { searchListings, getListing } = await import('../src/marketplace.js');
const fixture = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

const ctx = await getContext();
await ctx.route('https://www.facebook.com/**', (route) => {
  const url = route.request().url();
  if (url.includes('/marketplace/item/')) return route.fulfill({ contentType: 'text/html', body: fixture('item.html') });
  if (url.includes('/marketplace/blocked')) return route.fulfill({ status: 302, headers: { location: 'https://www.facebook.com/login/' } });
  if (url.includes('/login')) return route.fulfill({ contentType: 'text/html', body: '<h1>Log in</h1>' });
  return route.fulfill({ contentType: 'text/html', body: fixture('search.html') });
});
after(closeContext);

test('search collects cards, dedupes, scrolls for more', async () => {
  const res = await searchListings({ query: 'bike', location: 'nyc', limit: 3 });
  assert.equal(res.count, 3);
  assert.deepEqual(res.listings.map((l) => l.id), ['111', '222', '333']);
  assert.deepEqual(res.listings[0], {
    id: '111', url: 'https://www.facebook.com/marketplace/item/111/', price: '$150', originalPrice: '$200',
    title: 'Trek FX 2', location: 'Brooklyn, NY', extra: null, image: 'https://scontent.example/1.jpg',
  });
  assert.equal(res.listings[1].price, 'Free');
});

test('listing details with see-more expansion and screenshot', async () => {
  const { listing, screenshot } = await getListing('https://www.facebook.com/marketplace/item/111/?x=1', { screenshot: true });
  assert.equal(listing.title, 'Trek FX 2 Hybrid Bike');
  assert.equal(listing.price, '$350');
  assert.equal(listing.condition, 'Used - Good');
  assert.match(listing.description, /new tires\.\nPickup only\./);
  assert.equal(listing.seller.name, 'Jane Doe');
  assert.deepEqual(listing.images, ['https://scontent.example/og.jpg']);
  assert.ok(screenshot.length > 1000);
});

test('login wall surfaces a helpful error', async () => {
  const { getPageText } = await import('../src/marketplace.js');
  await assert.rejects(getPageText('https://www.facebook.com/marketplace/blocked'), /npm run login/);
  await assert.rejects(getPageText('https://example.com/marketplace'), /Only facebook.com/);
});
