// Marketplace browsing: search, listing details, seller profiles, saved items, your selling
// listings, location. Structured JSON from Facebook first, page text/DOM as fallback.
import fs from 'node:fs';
import path from 'node:path';
import { run, navigate, graphqlSince, getContext, currentUserId, sleep, jitter, shown, DATA_DIR } from './browser.js';
import { jsonFromHtml, jsonFromGraphql, listingsFromDocs, listingFromDocs, saysNoResults } from './fbdata.js';

export const BASE = 'https://www.facebook.com';

export const SORT_OPTIONS = {
  best_match: 'best_match',
  price_low_to_high: 'price_ascend',
  price_high_to_low: 'price_descend',
  newest: 'creation_time_descend',
  distance: 'distance_ascend',
};

export const CONDITIONS = ['new', 'used_like_new', 'used_good', 'used_fair'];

// Price-looking line: "$1,200", "Free", "CA$50", "€30", "1.200 €", "$12K"
export const PRICE_RE = /^(free|[A-Z]{0,3}\p{Sc}\s?[\d.,]+\s?[KkMm]?|[\d.,]+\s?[A-Z]{0,3}\p{Sc})$/iu;
const BADGE_RE = /^(just listed|sponsored|partner listing|pending|sold|shipping available|ships to you)$/i;

export function buildSearchUrl({ query, location, category, minPrice, maxPrice, sort, daysSinceListed, conditions, delivery, radiusKm, availability }) {
  const loc = location ? encodeURIComponent(String(location).trim().toLowerCase().replace(/\s+/g, '')) : null;
  let p;
  if (category) p = `/marketplace/${loc ? loc + '/' : 'category/'}${encodeURIComponent(category)}`;
  else if (!query) p = loc ? `/marketplace/${loc}/` : '/marketplace/'; // home feed ("Today's picks")
  else p = loc ? `/marketplace/${loc}/search` : '/marketplace/search';
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
  if (availability === 'sold') params.set('availability', 'out of stock');
  if (query) params.set('exact', 'false');
  const qs = params.toString();
  return BASE + p + (qs ? `?${qs}` : '');
}

export function listingIdFrom(input) {
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/marketplace\/item\/(\d+)/);
  if (!m) throw new Error(`Not a Marketplace listing URL or id: ${input}`);
  return m[1];
}

export const listingUrl = (id) => `${BASE}/marketplace/item/${id}/`;

/** Turn the text lines of a search-result card into structured fields (DOM fallback). */
export function parseCardLines(lines) {
  const c = lines.map((l) => l.trim()).filter((l) => l && !BADGE_RE.test(l));
  const prices = [];
  let i = 0;
  while (i < c.length && PRICE_RE.test(c[i])) prices.push(c[i++]);
  const rest = c.slice(i);
  return {
    price: prices[0] ?? null,
    originalPrice: prices[1] ?? null,
    title: rest[0] ?? null,
    location: rest[1] ?? null,
    extra: rest.slice(2).join(' · ') || null,
  };
}

/** Every JSON document the current page has: embedded scripts + GraphQL seen since `since`. */
export async function pageDocs(page, since) {
  const html = await page.content().catch(() => '');
  return [...jsonFromHtml(html), ...graphqlSince(since).flatMap(jsonFromGraphql)];
}

export async function dismissPopups(page) {
  for (const name of ['Close', 'Decline optional cookies', 'Only allow essential cookies', 'Not now']) {
    const btn = page.getByRole('button', { name, exact: true }).first();
    if (await shown(btn, 250)) await btn.click().catch(() => {});
  }
}

export async function bodyText(page, max = 12000) {
  const t = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return t.replace(/\n{3,}/g, '\n\n').slice(0, max);
}

export async function mainText(page, max = 8000) {
  const main = page.locator('[role="main"]').first();
  const t = (await main.count()) ? await main.innerText({ timeout: 5000 }).catch(() => '') : await bodyText(page, max);
  return t.replace(/\n{3,}/g, '\n\n').slice(0, max);
}

/** Save page HTML locally so broken selectors can be fixed later. */
export async function dumpDebug(page, name) {
  if (process.env.FB_MCP_DEBUG_DUMPS === 'false') return null;
  try {
    const dir = path.join(DATA_DIR, 'debug');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.html`);
    fs.writeFileSync(file, `<!-- ${page.url()} -->\n` + (await page.content()));
    return file;
  } catch {
    return null;
  }
}

async function domCards(page) {
  return page.$$eval('a[href*="/marketplace/item/"]', (anchors) =>
    anchors.map((a) => {
      const img = a.querySelector('img');
      return { href: a.getAttribute('href'), lines: (a.innerText || '').split('\n'), image: img?.getAttribute('src') || null, imageAlt: img?.getAttribute('alt') || null };
    })
  );
}

function domListings(cards) {
  const out = new Map();
  for (const c of cards) {
    const m = c.href?.match(/marketplace\/item\/(\d+)/);
    if (!m || out.has(m[1])) continue;
    const f = parseCardLines(c.lines);
    if (!f.title && c.imageAlt) f.title = c.imageAlt;
    out.set(m[1], Object.fromEntries(Object.entries({ id: m[1], url: listingUrl(m[1]), ...f, image: c.image }).filter(([, v]) => v != null)));
  }
  return out;
}

/** Scroll a listing grid, merging JSON + DOM listings, until `limit` or no growth. */
async function collectListings(page, since, limit, { includeSold = true } = {}) {
  let merged = [];
  let stagnant = 0;
  for (let round = 0; round < 30; round++) {
    const json = listingsFromDocs(await pageDocs(page, since));
    const dom = domListings(await domCards(page));
    const byId = new Map(json.map((l) => [l.id, l]));
    // DOM order reflects what's on screen; JSON fills in the details.
    const ids = [...dom.keys(), ...json.map((l) => l.id).filter((id) => !dom.has(id))];
    const prev = merged.length;
    merged = ids.map((id) => ({ ...dom.get(id), ...byId.get(id) })).filter((l) => l.title);
    if (!includeSold) merged = merged.filter((l) => !l.isSold);
    if (merged.length >= limit) break;
    stagnant = merged.length === prev ? stagnant + 1 : 0;
    if (stagnant >= 3) break;
    await page.mouse.wheel(0, 2500).catch(() => {});
    await jitter(1200, 2200);
  }
  return merged.slice(0, limit);
}

export function searchListings(opts) {
  const limit = Math.min(Math.max(opts.limit ?? 24, 1), 100);
  const url = buildSearchUrl(opts);
  return run(async (page) => {
    const since = Date.now();
    await navigate(page, url);
    await page.waitForSelector('a[href*="/marketplace/item/"]', { timeout: 15000 }).catch(() => {});
    await dismissPopups(page);
    const listings = await collectListings(page, since, limit, { includeSold: opts.includeSold });
    const res = { searchUrl: url, count: listings.length, listings };
    if (!listings.length) {
      const docs = await pageDocs(page, since);
      const text = await bodyText(page, 3000);
      if (saysNoResults(docs) || /no listings found|no results/i.test(text)) res.note = 'Facebook reported no results for this search.';
      else {
        const dump = await dumpDebug(page, 'search_empty');
        res.note =
          'No listings found. The location slug may be invalid, or Facebook changed its layout. ' +
          'Use browser_snapshot to look at the page and continue manually.' + (dump ? ` (HTML saved to ${dump})` : '');
        res.pageTextPreview = text.slice(0, 1500);
      }
    }
    return res;
  });
}

/** Parse a listing page's visible text (fallback when JSON is missing fields). */
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

  let description = null;
  const startIdx = lines.findIndex((l) => /^(details|description|seller's description)$/i.test(l));
  if (startIdx >= 0) {
    const endIdx = lines.findIndex(
      (l, i) => i > startIdx && /^(seller information|seller details|meet the seller|location is approximate|today's picks|related listings|send seller a message)/i.test(l)
    );
    description =
      lines
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

async function fetchImages(urls, max) {
  const ctx = await getContext();
  const out = [];
  for (const url of urls.slice(0, max)) {
    try {
      const res = await ctx.request.get(url, { timeout: 15000 });
      if (!res.ok()) continue;
      const buf = await res.body();
      if (buf.length > 4_500_000) continue;
      const mimeType = (res.headers()['content-type'] || 'image/jpeg').split(';')[0];
      if (!mimeType.startsWith('image/')) continue;
      out.push({ data: buf, mimeType });
    } catch {
      /* skip unreachable photo */
    }
  }
  return out;
}

export function getListing(idOrUrl, { photos = 0, screenshot = false } = {}) {
  const id = listingIdFrom(idOrUrl);
  const url = listingUrl(id);
  return run(async (page) => {
    const since = Date.now();
    await navigate(page, url);
    await page.waitForSelector('h1, [role="main"]', { timeout: 15000 }).catch(() => {});
    await sleep(1200);
    await dismissPopups(page);
    const seeMore = page.locator('[role="main"]').getByRole('button', { name: /^see more$/i }).first();
    if (await shown(seeMore, 500)) {
      await seeMore.click().catch(() => {});
      await sleep(400);
    }

    const dom = await page.evaluate(() => {
      const meta = (p) => document.querySelector(`meta[property="${p}"]`)?.getAttribute('content') || null;
      const main = document.querySelector('[role="main"]') || document.body;
      const h1 = main.querySelector('h1') || document.querySelector('h1');
      const images = [];
      for (const img of main.querySelectorAll('img')) {
        const src = img.currentSrc || img.src;
        if (!src || !/scontent|fbcdn/.test(src)) continue;
        const w = img.naturalWidth || img.width;
        if (w && w < 200) continue;
        if (!images.includes(src)) images.push(src);
      }
      const visible = (sel) => [...main.querySelectorAll(sel)].some((e) => e.offsetParent !== null);
      const sellerLink = main.querySelector('a[href*="/marketplace/profile/"]');
      return {
        title: h1?.innerText?.trim() || null,
        text: main.innerText || '',
        ogTitle: meta('og:title'),
        ogDescription: meta('og:description'),
        ogImage: meta('og:image'),
        images: images.slice(0, 20),
        alreadyMessaged: visible('[aria-label="Message again"]'),
        saved: visible('[aria-label="Unsave"], [aria-label="Saved"], [aria-label="Remove from saved"]'),
        sellerProfile: sellerLink ? sellerLink.href : null,
      };
    });

    const json = listingFromDocs(await pageDocs(page, since), id) || {};
    const fromText = parseListingText(dom.text, dom.title);
    const sellerId = json.seller?.id || dom.sellerProfile?.match(/profile\/(\d+)/)?.[1] || null;
    const listing = {
      id,
      url,
      title: json.title || fromText.title || dom.ogTitle,
      price: json.price || fromText.price,
      originalPrice: json.originalPrice,
      priceAmount: json.priceAmount,
      currency: json.currency,
      listed: fromText.listed || json.createdAt,
      createdAt: json.createdAt,
      location: json.location,
      coordinates: json.coordinates,
      condition: json.condition || fromText.condition,
      description: json.description || fromText.description || dom.ogDescription,
      attributes: json.attributes,
      subtitles: json.subtitles,
      seller: {
        ...(fromText.seller || {}),
        ...(json.seller || {}),
        ...(sellerId && { id: sellerId, profileUrl: `${BASE}/marketplace/profile/${sellerId}/` }),
      },
      status: json.isSold || /^sold$/im.test(dom.text) ? 'sold' : json.isPending ? 'pending' : 'available',
      deliveryTypes: json.deliveryTypes,
      shippingOffered: json.shippingOffered,
      alreadyMessaged: dom.alreadyMessaged,
      saved: dom.saved,
      photos: json.photos?.length ? json.photos : dom.images.length ? dom.images : dom.ogImage ? [dom.ogImage] : [],
      pageText: dom.text.replace(/\n{3,}/g, '\n\n').slice(0, 6000),
    };
    for (const k of Object.keys(listing)) if (listing[k] == null) delete listing[k];
    const images = photos > 0 ? await fetchImages(listing.photos, Math.min(photos, 8)) : [];
    const shot = screenshot ? await page.screenshot({ type: 'jpeg', quality: 70 }) : null;
    return { listing, images, screenshot: shot };
  });
}

export function sellerIdFrom(input) {
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/marketplace\/profile\/(\d+)/) || s.match(/[?&]id=(\d+)/);
  if (!m) throw new Error(`Not a Marketplace seller profile URL or id: ${input}`);
  return m[1];
}

export function getSellerProfile(idOrUrl, { limit = 24 } = {}) {
  const id = sellerIdFrom(idOrUrl);
  const url = `${BASE}/marketplace/profile/${id}/`;
  return run(async (page) => {
    const since = Date.now();
    await navigate(page, url);
    await page.waitForSelector('[role="main"], [role="dialog"]', { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    const text = await bodyText(page, 8000);
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const name = await page.locator('[role="dialog"] h2, [role="main"] h1, [role="dialog"] h1').first().innerText({ timeout: 2000 }).catch(() => null);
    const rating = lines.find((l) => /^\d(\.\d)?\s*\(\d+\)$/.test(l) || /ratings?$/i.test(l)) ?? null;
    const joined = lines.find((l) => /joined facebook/i.test(l)) ?? null;
    const badges = lines.filter((l) => /highly rated|responsive|good communication|fast shipping|top seller/i.test(l)).slice(0, 8);
    const listings = await collectListings(page, since, limit);
    return { id, url, name, rating, joined, badges, listings, pageText: text.slice(0, 4000) };
  });
}

/** Try a list of URLs; for each, optionally click through menu links; stop when `ok(page)` holds. */
async function reachPage(page, candidates, ok) {
  for (const c of candidates) {
    try {
      await navigate(page, c.url);
      await sleep(2000);
      for (const linkName of c.click || []) {
        const link = page.getByRole('link', { name: linkName }).or(page.getByRole('tab', { name: linkName })).first();
        if (await shown(link, 3000)) {
          await link.click();
          await sleep(2000);
        }
      }
      if (await ok(page)) return true;
    } catch (err) {
      if (err.name === 'NotLoggedInError') throw err;
    }
  }
  return false;
}

export function savedListings({ limit = 50 } = {}) {
  return run(async (page) => {
    const since = Date.now();
    const hasItems = async (p) => (await p.locator('a[href*="/marketplace/item/"]').count()) > 0;
    await reachPage(
      page,
      [
        { url: `${BASE}/marketplace/you/saved/` },
        { url: `${BASE}/marketplace/you/buying/`, click: [/^saved$/i] },
        { url: `${BASE}/saved/`, click: [/^marketplace$/i] },
      ],
      hasItems
    );
    const listings = await collectListings(page, since, limit);
    return { pageUrl: page.url(), count: listings.length, listings, ...(!listings.length && { pageTextPreview: await bodyText(page, 2000) }) };
  });
}

export function setSaved(idOrUrl, save) {
  const id = listingIdFrom(idOrUrl);
  return run(async (page) => {
    await navigate(page, listingUrl(id));
    await page.waitForSelector('[role="main"]', { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    const main = page.locator('[role="main"]');
    const savedBtn = main.locator('[aria-label="Unsave"], [aria-label="Saved"], [aria-label="Remove from saved"]').first();
    const saveBtn = main.locator('[aria-label="Save"]').first();
    const isSaved = await shown(savedBtn, 1500);
    if (isSaved === save) return { id, saved: save, changed: false };
    const target = save ? saveBtn : savedBtn;
    if (!(await shown(target, 1500))) {
      throw new Error(`Couldn't find the ${save ? 'Save' : 'Unsave'} button on the listing. Use browser_snapshot to find it.`);
    }
    await target.click();
    await sleep(1500);
    // Some layouts open a "Save to collection" dialog; pick the default entry and confirm.
    const dialog = page.getByRole('dialog').last();
    if (save && (await shown(dialog, 800))) {
      const done = dialog.getByRole('button', { name: /^(done|save)$/i }).first();
      if (await shown(done, 800)) await done.click().catch(() => {});
      await sleep(800);
    }
    const nowSaved = await shown(savedBtn, 2000);
    return { id, saved: nowSaved, changed: nowSaved === save };
  });
}

/** Parse "your listings" page text into rows (DOM fallback used by public tools). */
export function parseSellingText(text) {
  const lines = text.split(/\n+/).map((l) => l.replace(/ /g, ' ').trim()).filter(Boolean);
  const rows = [];
  const seen = new Set();
  for (let i = 1; i < lines.length; i++) {
    if (!PRICE_RE.test(lines[i])) continue;
    const title = lines[i - 1];
    if (!title || PRICE_RE.test(title) || /^(hide|all listings|needs attention|marketplace|selling|your listings)$/i.test(title) || seen.has(title)) continue;
    seen.add(title);
    // The row ends where the next row's title (the line before its price) begins.
    let end = i + 1;
    while (end < lines.length && end < i + 14 && !PRICE_RE.test(lines[end + 1] ?? '')) end++;
    const win = lines.slice(i, end);
    rows.push({
      title,
      price: lines[i],
      status: win.find((l) => /^(active|sold|pending|draft|in stock|out of stock)$/i.test(l)) || null,
      listed: win.find((l) => /listed on\b/i.test(l))?.replace(/^·\s*/, '') || null,
      clicks: win.find((l) => /clicks? on listing/i.test(l))?.match(/([\d,.]+)\s+clicks?/i)?.[1] || null,
      actions: win.filter((l) => /^(mark as sold|mark as available|mark as pending|relist this item|share|boost listing|renew listing)$/i.test(l)),
    });
  }
  return rows;
}

export function yourListings({ limit = 50 } = {}) {
  return run(async (page) => {
    const since = Date.now();
    await navigate(page, `${BASE}/marketplace/you/selling/`);
    await sleep(3000);
    const me = await currentUserId();
    const json = listingsFromDocs(await pageDocs(page, since)).filter((l) => !me || !l.seller?.id || l.seller.id === me);
    const text = await bodyText(page, 20000);
    const rows = parseSellingText(text);
    return { pageUrl: page.url(), listings: json.slice(0, limit), rows: rows.slice(0, limit), ...(!json.length && !rows.length && { pageTextPreview: text.slice(0, 2000) }) };
  });
}

/**
 * Change the Marketplace browsing location through the location dialog, as a person would.
 * Best-effort: the dialog's layout varies, so returns what it managed plus a screenshot.
 */
export function setLocation(locationText, { radiusKm } = {}) {
  return run(async (page) => {
    await navigate(page, `${BASE}/marketplace/`);
    await sleep(2500);
    const opener = page
      .getByRole('button', { name: /within \d+|location/i })
      .or(page.getByText(/within \d+\s*(mi|km|miles|kilometres|kilometers)/i))
      .first();
    if (!(await shown(opener, 4000))) throw new Error("Couldn't find the location button. Use browser_snapshot and set it manually.");
    await opener.click();
    const dialog = page.getByRole('dialog').last();
    await dialog.waitFor({ timeout: 8000 });
    const input = dialog.getByRole('combobox').or(dialog.getByRole('textbox')).or(dialog.locator('input[type="text"], input[type="search"]')).first();
    await input.click();
    await input.fill('');
    await page.keyboard.type(locationText, { delay: 60 });
    await sleep(2000);
    const option = page.getByRole('option').first();
    if (!(await shown(option, 4000))) throw new Error(`No location suggestions appeared for "${locationText}".`);
    const chosen = await option.innerText().catch(() => null);
    await option.click();
    await sleep(800);
    if (radiusKm) {
      const radius = dialog.getByRole('combobox', { name: /radius/i }).or(dialog.getByLabel(/radius/i)).first();
      if (await shown(radius, 1000)) {
        await radius.click();
        const opt = page.getByRole('option', { name: new RegExp(`^${radiusKm}\\b`) }).first();
        if (await shown(opt, 1500)) await opt.click();
        else await page.keyboard.press('Escape');
      }
    }
    const apply = dialog.getByRole('button', { name: /^apply$/i }).first();
    if (await shown(apply, 2000)) await apply.click();
    await sleep(2500);
    return { chosen: chosen?.split('\n')[0] ?? null, pageUrl: page.url(), screenshot: await page.screenshot({ type: 'jpeg', quality: 60 }) };
  });
}
