import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonFromHtml, jsonFromGraphql, listingsFromDocs, saysNoResults } from '../src/fbdata.js';

test('jsonFromHtml ignores non-JSON scripts', () => {
  const html = '<script type="application/json">{"a":1}</script><script>var x=1</script><script type="application/json" data-sjs>[1]</script><script type="application/json">nope</script>';
  assert.deepEqual(jsonFromHtml(html), [{ a: 1 }, [1]]);
});

test('jsonFromGraphql handles for(;;) prefix and multiple docs', () => {
  assert.deepEqual(jsonFromGraphql('for (;;);{"a":1}\n{"b":2}\n{partial'), [{ a: 1 }, { b: 2 }]);
});

test('listings keep feed order, merge split objects, drop untitled fragments', () => {
  const docs = [
    { x: { id: '2', listing_photos: [{ image: { uri: 'p' } }] } },
    { data: { marketplace_search: { feed_units: { edges: [{ node: { listing: { id: '1', marketplace_listing_title: 'A', listing_price: { formatted_amount: '$5', amount: '5.00' } } } }, { node: { listing: { id: '2', marketplace_listing_title: 'B' } } }] } } } },
    { y: { id: '3', is_sold: true } },
  ];
  const ls = listingsFromDocs(docs);
  assert.deepEqual(ls.map((l) => l.id), ['1', '2']);
  assert.equal(ls[0].priceAmount, 5);
  assert.deepEqual(ls[1].photos, ['p']);
});

test('saysNoResults', () => {
  assert.equal(saysNoResults([{ e: [{ node: { __typename: 'MarketplaceSearchFeedNoResults' } }] }]), true);
  assert.equal(saysNoResults([{}]), false);
});
