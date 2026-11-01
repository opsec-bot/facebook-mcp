// Pulls structured Marketplace data out of the JSON Facebook ships with every page:
// <script type="application/json"> blobs in the HTML, and GraphQL responses fetched while
// scrolling. Field names follow what public scrapers rely on (marketplace_search.feed_units,
// marketplace_listing_title, listing_price, redacted_description, listing_photos, ...).
// Facebook renames things without notice, so every field is optional and we walk the whole
// tree instead of trusting exact paths.

const SCRIPT_JSON_RE = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;

/** Parse every JSON payload embedded in a page's HTML. */
export function jsonFromHtml(html) {
  const out = [];
  for (const m of html.matchAll(SCRIPT_JSON_RE)) {
    const body = m[1].trim();
    if (!body || (body[0] !== '{' && body[0] !== '[')) continue;
    try {
      out.push(JSON.parse(body));
    } catch {
      /* not JSON */
    }
  }
  return out;
}

/** GraphQL bodies may start with `for (;;);` and may hold several JSON docs, one per line. */
export function jsonFromGraphql(body) {
  const out = [];
  const text = body.replace(/^for \(;;\);/, '');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* partial chunk */
    }
  }
  return out;
}

/** Depth-first walk over every object in a JSON tree. */
export function walk(root, visit) {
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== 'object' || seen.has(v)) continue;
    seen.add(v);
    if (!Array.isArray(v)) visit(v);
    for (const k in v) {
      const c = v[k];
      if (c && typeof c === 'object') stack.push(c);
    }
  }
}

const LISTING_KEYS = [
  'marketplace_listing_title',
  'listing_price',
  'redacted_description',
  'listing_photos',
  'primary_listing_photo',
  'marketplace_listing_seller',
  'location_text',
  'is_sold',
  'is_pending',
];

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);

function mergeInto(target, src, depth = 0) {
  for (const [k, v] of Object.entries(src)) {
    if (v == null) continue;
    const cur = target[k];
    if (cur == null) target[k] = isPlain(v) ? mergeInto({}, v, depth + 1) : v;
    else if (isPlain(cur) && isPlain(v) && depth < 4) mergeInto(cur, v, depth + 1);
    else if (Array.isArray(v) && Array.isArray(cur) && v.length > cur.length) target[k] = v;
  }
  return target;
}

/**
 * Collect raw listing objects keyed by id. Facebook often splits one listing across several
 * objects with the same id (title in one, description in another), so they're merged.
 */
export function collectRawListings(docs) {
  const byId = new Map();
  const order = []; // ids in feed order, from marketplace_search.feed_units
  for (const doc of docs) {
    walk(doc, (o) => {
      if (o.feed_units?.edges && Array.isArray(o.feed_units.edges)) {
        for (const e of o.feed_units.edges) {
          const id = e?.node?.listing?.id;
          if (id && !order.includes(id)) order.push(id);
        }
      }
      if (typeof o.id !== 'string' || !/^\d+$/.test(o.id)) return;
      if (!LISTING_KEYS.some((k) => k in o)) return;
      if (!byId.has(o.id)) byId.set(o.id, {});
      mergeInto(byId.get(o.id), o);
    });
  }
  return { byId, order };
}

const text = (v) => (typeof v === 'string' ? v : v?.text ?? null) || null;

export function normalizeListing(raw) {
  if (!raw) return null;
  const geo = raw.location?.reverse_geocode_detailed ?? raw.location?.reverse_geocode;
  const city = geo?.city_page?.display_name || [geo?.city, geo?.state].filter(Boolean).join(', ') || null;
  const photos = (raw.listing_photos ?? [])
    .map((p) => p?.image?.uri ?? p?.uri)
    .filter(Boolean);
  const primary = raw.primary_listing_photo?.image?.uri ?? raw.primary_listing_photo?.listing_image?.uri ?? photos[0] ?? null;
  const subtitles = (raw.custom_sub_titles_with_rendering_flags ?? [])
    .map((s) => s?.subtitle)
    .filter(Boolean);
  const attributes = Object.fromEntries(
    (raw.attribute_data ?? [])
      .filter((a) => a?.attribute_name || a?.attribute_type)
      .map((a) => [a.attribute_name || a.attribute_type, a.label || a.value])
  );
  const condition =
    attributes.Condition ||
    attributes.condition ||
    (typeof raw.condition === 'string' ? raw.condition : null) ||
    (typeof raw.marketplace_listing_condition === 'string' ? raw.marketplace_listing_condition : null);
  const seller = raw.marketplace_listing_seller;
  const lat = raw.location?.latitude;
  const lng = raw.location?.longitude;
  return clean({
    id: raw.id,
    url: `https://www.facebook.com/marketplace/item/${raw.id}/`,
    title: raw.marketplace_listing_title || raw.custom_title || text(raw.base_marketplace_listing_title) || null,
    price: raw.listing_price?.formatted_amount ?? text(raw.formatted_price) ?? null,
    priceAmount: raw.listing_price?.amount != null ? Number(raw.listing_price.amount) : null,
    currency: raw.listing_price?.currency ?? null,
    originalPrice: raw.strikethrough_price?.formatted_amount ?? null,
    location: city || text(raw.location_text) || null,
    coordinates: typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null,
    subtitles: subtitles.length ? subtitles : null,
    condition: condition ? String(condition).replace(/^PC_/, '').replace(/_/g, ' ').toLowerCase() : null,
    description: text(raw.redacted_description) ?? text(raw.description) ?? null,
    attributes: Object.keys(attributes).length ? attributes : null,
    seller: seller ? clean({ id: seller.id ?? null, name: seller.name ?? null, type: seller.__typename ?? null }) : null,
    image: primary,
    photos: photos.length ? photos : null,
    createdAt: raw.creation_time ? new Date(raw.creation_time * 1000).toISOString() : null,
    isSold: raw.is_sold ?? null,
    isPending: raw.is_pending ?? null,
    isLive: raw.is_live ?? null,
    deliveryTypes: raw.delivery_types ?? null,
    shippingOffered: raw.is_shipping_offered ?? null,
    categoryId: raw.marketplace_listing_category_id ?? null,
    category: raw.marketplace_listing_category?.name ?? null,
  });
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null && v !== ''));
}

/** Listings in feed order (when known) followed by any others found. */
export function listingsFromDocs(docs) {
  const { byId, order } = collectRawListings(docs);
  const ids = [...order.filter((id) => byId.has(id)), ...[...byId.keys()].filter((id) => !order.includes(id))];
  return ids
    .map((id) => normalizeListing({ id, ...byId.get(id) }))
    .filter((l) => l && l.title); // drop fragments that never got a title
}

export function listingFromDocs(docs, id) {
  const { byId } = collectRawListings(docs);
  return byId.has(id) ? normalizeListing({ id, ...byId.get(id) }) : null;
}

/** True when the search payload explicitly says "no results". */
export function saysNoResults(docs) {
  let found = false;
  for (const d of docs) walk(d, (o) => {
    if (o.__typename === 'MarketplaceSearchFeedNoResults') found = true;
  });
  return found;
}
