import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchUrl, parseCardLines, listingIdFrom, parseListingText } from '../src/marketplace.js';

test('buildSearchUrl with location and filters', () => {
  const u = new URL(
    buildSearchUrl({ query: 'road bike', location: 'NYC', minPrice: 100, maxPrice: 500, sort: 'newest', daysSinceListed: 7, conditions: ['new', 'used_good'], delivery: 'pickup', radiusKm: 20 })
  );
  assert.equal(u.pathname, '/marketplace/nyc/search');
  assert.equal(u.searchParams.get('query'), 'road bike');
  assert.equal(u.searchParams.get('minPrice'), '100');
  assert.equal(u.searchParams.get('maxPrice'), '500');
  assert.equal(u.searchParams.get('sortBy'), 'creation_time_descend');
  assert.equal(u.searchParams.get('daysSinceListed'), '7');
  assert.equal(u.searchParams.get('itemCondition'), 'new,used_good');
  assert.equal(u.searchParams.get('deliveryMethod'), 'local_pick_up');
  assert.equal(u.searchParams.get('radius'), '20');
});

test('buildSearchUrl without location / with category', () => {
  assert.equal(buildSearchUrl({ query: 'desk' }), 'https://www.facebook.com/marketplace/search?query=desk&exact=false');
  assert.equal(buildSearchUrl({ category: 'free', location: 'la' }), 'https://www.facebook.com/marketplace/la/free');
});

test('parseCardLines handles discounts and badges', () => {
  assert.deepEqual(parseCardLines(['Just listed', '$150', '$200', 'Trek FX 2', 'Brooklyn, NY', '']), {
    price: '$150', originalPrice: '$200', title: 'Trek FX 2', location: 'Brooklyn, NY', extra: null,
  });
  assert.deepEqual(parseCardLines(['$12,500', '2015 Honda Civic', 'Austin, TX', '98K miles']), {
    price: '$12,500', originalPrice: null, title: '2015 Honda Civic', location: 'Austin, TX', extra: '98K miles',
  });
  assert.equal(parseCardLines(['Free', 'Couch', 'Oakland, CA']).price, 'Free');
  assert.equal(parseCardLines(['CA$40', 'Lamp', 'Toronto, ON']).price, 'CA$40');
  assert.equal(parseCardLines(['1.200 €', 'Sofa', 'Berlin']).price, '1.200 €');
});

test('listingIdFrom', () => {
  assert.equal(listingIdFrom('123456'), '123456');
  assert.equal(listingIdFrom('https://www.facebook.com/marketplace/item/987654321/?ref=search'), '987654321');
  assert.throws(() => listingIdFrom('https://example.com'));
});

test('parseListingText', () => {
  const text = [
    'Marketplace', 'Trek FX 2 Hybrid Bike', '$350', 'Listed 3 days ago in Brooklyn, NY', 'Send seller a message',
    'Details', 'Condition', 'Used - Good', 'Medium frame, new tires.', 'Pickup only.', 'See less',
    'Seller information', 'Seller details', 'Jane Doe', 'Joined Facebook in 2012',
  ].join('\n');
  const r = parseListingText(text, 'Trek FX 2 Hybrid Bike');
  assert.equal(r.price, '$350');
  assert.equal(r.listed, 'Listed 3 days ago in Brooklyn, NY');
  assert.equal(r.condition, 'Used - Good');
  assert.equal(r.description, 'Medium frame, new tires.\nPickup only.');
  assert.deepEqual(r.seller, { name: 'Jane Doe', joined: 'Joined Facebook in 2012' });
});
