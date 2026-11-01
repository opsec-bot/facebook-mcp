// Drives the real tool code in a real browser against the mock Facebook in mockfb.js.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fbmcp-'));
process.env.FB_MCP_DATA_DIR = tmp;
process.env.FB_MCP_MIN_INTERVAL_MS = '0';
const { getContext, closeContext } = await import('../src/browser.js');
const mp = await import('../src/marketplace.js');
const msg = await import('../src/messaging.js');
const sell = await import('../src/selling.js');
const ctl = await import('../src/control.js');
const { installMockFacebook, startImageServer } = await import('./mockfb.js');

let state, images;
before(async () => {
  images = await startImageServer();
  state = await installMockFacebook(await getContext(), { imageBase: images.base });
});
after(async () => {
  await closeContext();
  images.close();
});

test('search: JSON + DOM merge, scroll loads GraphQL page 2, sold filter', async () => {
  const res = await mp.searchListings({ query: 'bike', location: 'nyc', limit: 10, includeSold: false });
  assert.deepEqual(res.listings.map((l) => l.id), ['111', '222', '333']);
  const [trek, kids, bmx] = res.listings;
  assert.equal(trek.title, 'Trek FX 2');
  assert.equal(trek.price, '$150');
  assert.equal(trek.originalPrice, '$200');
  assert.equal(trek.priceAmount, 150);
  assert.equal(trek.location, 'Brooklyn, NY');
  assert.deepEqual(trek.seller, { id: '9111', name: 'Seller 111', type: 'User' });
  assert.equal(trek.createdAt, '2025-11-01T00:00:00.000Z');
  assert.equal(kids.price, 'Free');
  assert.equal(bmx.isPending, true);
  const withSold = await mp.searchListings({ query: 'bike', limit: 10 });
  assert.ok(withSold.listings.some((l) => l.id === '444' && l.isSold));
});

test('listing details from split JSON objects, with photos as images', async () => {
  const { listing, images: pics, screenshot } = await mp.getListing('https://www.facebook.com/marketplace/item/111/?x=1', { photos: 2, screenshot: true });
  assert.equal(listing.title, 'Trek FX 2 Hybrid Bike');
  assert.equal(listing.price, '$350');
  assert.equal(listing.description, 'Medium frame, new tires.\nPickup only.');
  assert.equal(listing.condition, 'used - good');
  assert.equal(listing.listed, 'Listed 3 days ago in Brooklyn, NY');
  assert.deepEqual(listing.coordinates, { lat: 40.67, lng: -73.94 });
  assert.equal(listing.seller.id, '9111');
  assert.equal(listing.seller.profileUrl, 'https://www.facebook.com/marketplace/profile/9111/');
  assert.equal(listing.status, 'available');
  assert.equal(listing.alreadyMessaged, false);
  assert.equal(listing.photos.length, 2);
  assert.equal(pics.length, 2);
  assert.equal(pics[0].mimeType, 'image/png');
  assert.ok(screenshot.length > 1000);
});

test('seller profile', async () => {
  const p = await mp.getSellerProfile('https://www.facebook.com/marketplace/profile/9111/');
  assert.equal(p.name, 'Jane Doe');
  assert.equal(p.rating, '4.8 (25)');
  assert.equal(p.joined, 'Joined Facebook in 2012');
  assert.deepEqual(p.badges, ['Highly rated']);
  assert.deepEqual(p.listings.map((l) => l.id), ['111', '555']);
});

test('save and unsave', async () => {
  assert.deepEqual(await mp.setSaved('111', true), { id: '111', saved: true, changed: true });
  assert.equal(state.saved, true);
  assert.deepEqual(await mp.setSaved('111', true), { id: '111', saved: true, changed: false });
  assert.deepEqual(await mp.setSaved('111', false), { id: '111', saved: false, changed: true });
  const saved = await mp.savedListings();
  assert.equal(saved.listings[0].id, '111');
});

test('message seller: first message replaces prefilled text, then follow-up via Message again', async () => {
  const first = await msg.messageSeller('111', 'Hi! Would you take $300?');
  assert.equal(first.status, 'sent');
  assert.equal(first.mode, 'first_message');
  assert.deepEqual(state.sent, ['Hi! Would you take $300?']);

  const second = await msg.messageSeller('111', 'I can pick up today.\nWhat time works?');
  assert.equal(second.mode, 'follow_up');
  assert.equal(second.status, 'sent');
  assert.equal(state.sent[1], 'I can pick up today.\nWhat time works?');

  const conv = await msg.readConversation('111');
  assert.deepEqual(conv.messages.map((m) => m.sender), ['Jane Doe', 'You', 'You']);
  assert.equal(conv.messages[0].text, 'Hi! Yes it is.');
  const log = fs.readFileSync(path.join(tmp, 'actions.log'), 'utf8').trim().split('\n');
  assert.equal(log.length, 2);
});

test('inbox, read thread, reply', async () => {
  const inbox = await msg.listConversations({ tab: 'buying' });
  assert.equal(inbox.count, 2);
  assert.deepEqual(inbox.conversations[0], {
    threadId: '777', url: 'https://www.facebook.com/messages/t/777/', name: 'Jane Doe',
    preview: 'Trek FX 2 Hybrid Bike · Sure, come by at 5 · 2h', unread: true,
  });
  const conv = await msg.readConversation('777');
  assert.equal(conv.listing, 'https://www.facebook.com/marketplace/item/111/');
  assert.ok(conv.messages.length >= 1);
  const r = await msg.replyToConversation('https://www.facebook.com/messages/t/777/', 'See you at 5!');
  assert.equal(r.status, 'sent');
  assert.equal(state.sent.at(-1), 'See you at 5!');
});

test('create listing draft, then publish', async () => {
  const photo = path.join(tmp, 'desk.png');
  fs.writeFileSync(photo, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const d = await sell.createListingDraft({ title: 'Oak desk', price: 120, category: 'Furniture', condition: 'Used - Good', description: 'Solid oak.', photos: [photo] });
  assert.equal(d.status, 'draft_filled_not_published');
  assert.deepEqual(d.filled, { photos: true, title: true, price: true, category: true, condition: true, description: true });
  assert.equal(state.published, false);
  const p = await sell.publishListing();
  assert.equal(p.status, 'published');
  assert.equal(state.published, true);
  const mine = await mp.yourListings();
  assert.deepEqual(mine.rows[0], { title: 'Oak desk', price: '$120', status: 'Active', listed: 'Listed on 10/28', clicks: '34', actions: ['Mark as sold', 'Share'] });
  assert.equal(mine.rows[1].status, 'Sold');
});

test('generic browser control: navigate, snapshot refs, click, type', async () => {
  const snap = await ctl.browserNavigate('https://www.facebook.com/marketplace/item/111/');
  assert.equal(snap.scope, 'main');
  assert.match(snap.snapshot, /heading "Trek FX 2 Hybrid Bike"/);
  assert.match(snap.snapshot, /Message again/, snap.snapshot);
  const m = snap.snapshot.match(/button "Message again"[^\n]*?\[ref=(\w+)\]/);
  assert.ok(m, snap.snapshot.split("\n").filter((l) => /Message again/.test(l)).join("\n"));
  const ref = m[1];
  await ctl.browserClick({ ref });
  const page = await ctl.browserSnapshot('page');
  assert.match(page.snapshot, /textbox "Write/, page.snapshot);
  const box = page.snapshot.match(/textbox "Write to Jane Doe · Trek FX 2 Hybrid Bike"[^\n]*?\[ref=(\w+)\]/)[1];
  const before = state.sent.length;
  await ctl.browserType({ ref: box, value: 'Typed via browser tools', submit: true });
  assert.equal(state.sent.length, before + 1);
  assert.equal(state.sent.at(-1), 'Typed via browser tools');
  await assert.rejects(ctl.browserClick({ ref: 'e99999' }), /browser_snapshot for fresh refs/);
  await assert.rejects(ctl.browserNavigate('https://evil.example/'), /Only https:\/\/facebook.com/);
  const shot = await ctl.browserScreenshot({});
  assert.ok(shot.image.length > 1000);
});

test('login wall surfaces a helpful error', async () => {
  await assert.rejects(ctl.browserNavigate('https://www.facebook.com/marketplace/blocked'), /marketplace_login/);
});
