// Facebook Marketplace URL building and page parsing.
import { withPage, isLoginPage, NotLoggedInError, sleep, getContext } from './browser.js';

const BASE = 'https://www.facebook.com';

export const SORT_OPTIONS = {
  best_match: 'best_match',
  price_low_to_high: 'price_ascend',
  price_high_to_low: 'price_descend',
  newest: 'creation_time_descend',
  distance: 'distance_ascend',
};

export const CONDITIONS = ['new', 'used_like_new', 'used_good', 'used_fair'];

// Price-looking line: "$1,200", "Free", "CA$50", "€30", "1.200 €", "$12K"
const PRICE_RE = /^(free|[A-Z]{0,3}\p{Sc}\s?[\d.,]+\s?[KkMm]?|[\d.,]+\s?[A-Z]{0,3}\p{Sc})$/iu;
const BADGE_RE = /^(just listed|sponsored|partner listing|pending|sold|shipping available|ships to you)$/i;

export function buildSearchUrl({
  query,
  location,
  category,
  minPrice,
  maxPrice,
  sort,
  daysSinceListed,
  conditions,
  delivery,
  radiusKm,
}) {
  const loc = location ? encodeURIComponent(String(location).trim().toLowerCase()) : null;
  let path;
  if (category) {
    path = `/marketplace/${loc ? loc + '/' : 'category/'}${encodeURIComponent(category)}`;
  } else {
    path = loc ? `/marketplace/${loc}/search` : '/marketplace/search';
  }
  const params = new URLSearchParams();
  if (query) params.set('query', query);
  if (minPrice != null) params.set('minPrice', String(minPrice));
  if (maxPrice != null) params.set('maxPrice', String(maxPrice));
  if (sort && SORT_OPTIONS[sort]) params.set('sortBy', SORT_OPTIONS[sort]);
  if (daysSinceListed) params.set('daysSinceListed', String(daysSinceListed));
  if (conditions?.length) params.set('itemCondition', conditions.join(','));
  if (delivery === 'pickup') params.set('deliveryMethod', 'local_pick_up');
  if (delivery === 'shipping') params.set('deliveryMethod', 'shipping');
  if (radiusKm) params.set('radius', String(radiusKm));
  if (query) params.set('exact', 'false');
  const qs = params.toString();
  return BASE + path + (qs ? `?${qs}` : '');
}

export function listingIdFrom(input) {
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/marketplace\/item\/(\d+)/);
  if (!m) throw new Error(`Not a Marketplace listing URL or id: ${input}`);
  return m[1];
}

export const listingUrl = (id) => `${BASE}/marketplace/item/${id}/`;

/** Turn the text lines of a search-result card into structured fields. */
export function parseCardLines(lines) {
  const clean = lines.map((l) => l.trim()).filter((l) => l && !BADGE_RE.test(l));
  const prices = [];
  let i = 0;
  while (i < clean.length && PRICE_RE.test(clean[i])) prices.push(clean[i++]);
  const rest = clean.slice(i);
  return {
    price: prices[0] ?? null,
    originalPrice: prices[1] ?? null,
    title: rest[0] ?? null,
    location: rest[1] ?? null,
    extra: rest.slice(2).join(' · ') || null,
  };
}

async function gotoMarketplace(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (isLoginPage(page.url())) throw new NotLoggedInError();
}

async function dismissPopups(page) {
  // Cookie banners / "see more on Facebook" login modals can cover the page.
  for (const label of ['Close', 'Decline optional cookies', 'Only allow essential cookies']) {
    const btn = page.getByRole('button', { name: label, exact: true }).first();
    if (await btn.isVisible({ timeout: 300 }).catch(() => false)) await btn.click().catch(() => {});
  }
}

async function collectCards(page) {
  return page.$$eval('a[href*="/marketplace/item/"]', (anchors) =>
    anchors.map((a) => {
      const img = a.querySelector('img');
      return {
        href: a.getAttribute('href'),
        lines: (a.innerText || '').split('\n'),
        image: img?.getAttribute('src') || null,
        imageAlt: img?.getAttribute('alt') || null,
      };
    })
  );
}

export async function searchListings(opts) {
  const limit = Math.min(Math.max(opts.limit ?? 24, 1), 100);
  const url = buildSearchUrl(opts);
  return withPage(async (page) => {
    await gotoMarketplace(page, url);
    await page
      .waitForSelector('a[href*="/marketplace/item/"]', { timeout: 15000 })
      .catch(() => {});
    await dismissPopups(page);

    const byId = new Map();
    let stagnant = 0;
    while (byId.size < limit && stagnant < 3) {
      const before = byId.size;
      for (const c of await collectCards(page)) {
        const m = c.href?.match(/marketplace\/item\/(\d+)/);
        if (!m || byId.has(m[1])) continue;
        const fields = parseCardLines(c.lines);
        if (!fields.title && c.imageAlt) fields.title = c.imageAlt;
        byId.set(m[1], { id: m[1], url: listingUrl(m[1]), ...fields, image: c.image });
      }
      if (byId.size >= limit) break;
      stagnant = byId.size === before ? stagnant + 1 : 0;
      await page.mouse.wheel(0, 2500);
      await sleep(1200 + Math.random() * 800);
    }

    const listings = [...byId.values()].slice(0, limit);
    let note;
    if (listings.length === 0) {
      const text = await page.locator('body').innerText().catch(() => '');
      note = /no listings found|no results/i.test(text)
        ? 'Facebook reported no results for this search.'
        : 'No listings were found on the page. Facebook may have changed its layout, or the location slug may be invalid. Try marketplace_page_text on the search URL to inspect it.';
    }
    return { searchUrl: url, count: listings.length, listings, ...(note && { note }) };
  });
}

export async function getListing(idOrUrl, { screenshot = false } = {}) {
  const id = listingIdFrom(idOrUrl);
  const url = listingUrl(id);
  return withPage(async (page) => {
    await gotoMarketplace(page, url);
    await page.waitForSelector('h1, [role="main"]', { timeout: 15000 }).catch(() => {});
    await dismissPopups(page);
    // Expand truncated descriptions.
    const seeMore = page.getByRole('button', { name: /^see more$/i }).first();
    if (await seeMore.isVisible({ timeout: 500 }).catch(() => false)) {
      await seeMore.click().catch(() => {});
      await sleep(400);
    }

    const data = await page.evaluate(() => {
      const meta = (p) => document.querySelector(`meta[property="${p}"]`)?.getAttribute('content') || null;
      // The listing panel is the main region; fall back to the body.
      const main = document.querySelector('[role="main"]') || document.body;
      const h1 = main.querySelector('h1') || document.querySelector('h1');
      const images = [];
      for (const img of document.querySelectorAll('img')) {
        const src = img.currentSrc || img.src;
        if (!src || !/scontent|fbcdn/.test(src)) continue;
        const w = img.naturalWidth || img.width;
        if (w && w < 200) continue; // skip avatars/icons
        if (!images.includes(src)) images.push(src);
      }
      return {
        title: h1?.innerText?.trim() || null,
        text: main.innerText || '',
        ogTitle: meta('og:title'),
        ogDescription: meta('og:description'),
        ogImage: meta('og:image'),
        images: images.slice(0, 12),
      };
    });

    const listing = parseListingText(data.text, data.title);
    const result = {
      id,
      url,
      title: listing.title || data.ogTitle,
      price: listing.price,
      listed: listing.listed,
      condition: listing.condition,
      description: listing.description || data.ogDescription,
      seller: listing.seller,
      images: data.images.length ? data.images : data.ogImage ? [data.ogImage] : [],
      // Raw panel text so the model can read anything the parser missed.
      pageText: data.text.replace(/\n{3,}/g, '\n\n').slice(0, 6000),
    };
    const shot = screenshot ? await page.screenshot({ type: 'jpeg', quality: 70 }) : null;
    return { listing: result, screenshot: shot };
  });
}

export function parseListingText(text, h1Title) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const titleIdx = h1Title ? lines.indexOf(h1Title) : -1;
  const after = titleIdx >= 0 ? lines.slice(titleIdx + 1) : lines;
  const price = after.find((l) => PRICE_RE.test(l)) ?? null;
  const listed = after.find((l) => /^listed\b/i.test(l)) ?? null;

  let condition = null;
  const condIdx = lines.findIndex((l) => /^condition$/i.test(l));
  if (condIdx >= 0 && lines[condIdx + 1]) condition = lines[condIdx + 1];
  else condition = lines.find((l) => /^condition\s*[:·]?\s*\S/i.test(l))?.replace(/^condition\s*[:·]?\s*/i, '') ?? null;

  // Description: text between "Details"/"Description" and the seller section.
  let description = null;
  const startIdx = lines.findIndex((l) => /^(details|description|seller's description)$/i.test(l));
  if (startIdx >= 0) {
    const endIdx = lines.findIndex(
      (l, i) => i > startIdx && /^(seller information|seller details|meet the seller|location is approximate|today's picks|related listings|send seller a message)/i.test(l)
    );
    description = lines
      .slice(startIdx + 1, endIdx > 0 ? endIdx : startIdx + 40)
      .filter((l) => !/^(condition|see less|see more|see translation)$/i.test(l) && l !== condition)
      .join('\n') || null;
  }

  let seller = null;
  const sellerIdx = lines.findIndex((l) => /^(seller information|seller details|meet the seller)$/i.test(l));
  if (sellerIdx >= 0) {
    const name = lines.slice(sellerIdx + 1).find((l) => !/^seller details$/i.test(l));
    const joined = lines.slice(sellerIdx + 1, sellerIdx + 8).find((l) => /joined facebook/i.test(l));
    seller = { name: name ?? null, joined: joined ?? null };
  }

  return { title: h1Title || null, price, listed, condition, description, seller };
}

/** Return visible text from any facebook.com/marketplace page (fallback when parsing fails). */
export async function getPageText(url, { screenshot = false } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (!/(^|\.)facebook\.com$/.test(parsed.hostname) || !parsed.pathname.startsWith('/marketplace')) {
    throw new Error('Only facebook.com/marketplace URLs are allowed.');
  }
  return withPage(async (page) => {
    await gotoMarketplace(page, parsed.toString());
    await sleep(2500);
    await dismissPopups(page);
    const text = await page.locator('body').innerText();
    const shot = screenshot ? await page.screenshot({ type: 'jpeg', quality: 70 }) : null;
    return { url: page.url(), text: text.replace(/\n{3,}/g, '\n\n').slice(0, 12000), screenshot: shot };
  });
}

export async function loginStatus() {
  const ctx = await getContext();
  const cookies = await ctx.cookies('https://www.facebook.com');
  return { loggedIn: cookies.some((c) => c.name === 'c_user' && c.value) };
}
