// Selling: fill in a new listing (draft, never auto-published), publish it, and change the
// status of your own listings. Form labels follow public Marketplace bots
// ("Title", "Price", "Category", "Condition", "Description", "Location", Next → Publish).
import fs from 'node:fs';
import path from 'node:path';
import { run, navigate, sleep, jitter, shown } from './browser.js';
import { BASE, listingIdFrom, listingUrl, dumpDebug } from './marketplace.js';
import { logAction } from './messaging.js';

async function pickOption(page, fieldLabel, value) {
  const field = page.getByLabel(fieldLabel, { exact: true }).or(page.getByRole('combobox', { name: fieldLabel })).first();
  if (!(await shown(field, 3000))) return false;
  await field.click();
  await sleep(800);
  const option = page
    .getByRole('option', { name: value, exact: true })
    .or(page.getByRole('menuitemradio', { name: value, exact: true }))
    .or(page.getByRole('button', { name: value, exact: true }))
    .or(page.getByRole('listbox').getByText(value, { exact: true }))
    .first();
  if (await shown(option, 3000)) {
    await option.click();
    await sleep(500);
    return true;
  }
  await page.keyboard.press('Escape');
  return false;
}

async function fillField(page, label, value) {
  const el = page.getByLabel(label, { exact: true }).first();
  if (!(await shown(el, 3000))) return false;
  await el.click();
  await el.fill(String(value));
  await jitter(300, 700);
  return true;
}

export function createListingDraft({ title, price, category, condition, description, location, photos = [], hideFromFriends }) {
  const files = photos.map((p) => path.resolve(p.replace(/^~(?=$|\/)/, process.env.HOME || '')));
  for (const f of files) if (!fs.existsSync(f)) throw new Error(`Photo not found: ${f}`);
  return run(async (page) => {
    await navigate(page, `${BASE}/marketplace/create/item/`);
    await page.waitForSelector('[role="main"], form', { timeout: 15000 }).catch(() => {});
    await jitter(2000, 3000);
    const filled = {};
    if (files.length) {
      const input = page.locator('input[type="file"][accept*="image"], input[type="file"]').first();
      filled.photos = (await input.count()) ? (await input.setInputFiles(files), true) : false;
      await jitter(2000, 3000);
    }
    filled.title = await fillField(page, 'Title', title);
    filled.price = await fillField(page, 'Price', price);
    if (category) filled.category = await pickOption(page, 'Category', category);
    if (condition) filled.condition = await pickOption(page, 'Condition', condition);
    if (description) filled.description = await fillField(page, 'Description', description);
    if (location) {
      filled.location = await fillField(page, 'Location', location);
      if (filled.location) {
        const opt = page.getByRole('option').first();
        if (await shown(opt, 3000)) await opt.click();
      }
    }
    if (hideFromFriends != null) {
      const sw = page.getByRole('switch', { name: /hide from friends/i }).or(page.getByLabel(/hide from friends/i)).first();
      if (await shown(sw, 1500)) {
        const on = (await sw.getAttribute('aria-checked')) === 'true' || (await sw.isChecked().catch(() => false));
        if (on !== hideFromFriends) await sw.click();
        filled.hideFromFriends = true;
      } else filled.hideFromFriends = false;
    }
    const failed = Object.entries(filled).filter(([, ok]) => !ok).map(([k]) => k);
    if (failed.length) await dumpDebug(page, 'create_listing');
    logAction({ action: 'create_listing_draft', title, price, failed });
    return {
      status: 'draft_filled_not_published',
      filled,
      ...(failed.length && { failed, note: 'Some fields could not be filled automatically. Use browser_snapshot/browser_click/browser_type to finish them.' }),
      next: 'Show the user the screenshot. Only after they approve, call marketplace_publish_listing.',
      screenshot: await page.screenshot({ type: 'jpeg', quality: 65, fullPage: true }),
    };
  });
}

export function publishListing() {
  return run(async (page) => {
    if (!/\/marketplace\/create/.test(page.url())) throw new Error('No listing form is open. Call marketplace_create_listing first.');
    for (let i = 0; i < 4; i++) {
      const publish = page.getByRole('button', { name: /^publish$/i }).first();
      if (await shown(publish, 1500)) {
        if ((await publish.getAttribute('aria-disabled')) === 'true') throw new Error('Publish is disabled: a required field is missing. Use browser_snapshot to see which.');
        await publish.click();
        await sleep(5000);
        logAction({ action: 'publish_listing', url: page.url() });
        return { status: 'published', pageUrl: page.url(), screenshot: await page.screenshot({ type: 'jpeg', quality: 60 }) };
      }
      const next = page.getByRole('button', { name: /^next$/i }).first();
      if (!(await shown(next, 1500))) break;
      if ((await next.getAttribute('aria-disabled')) === 'true') throw new Error('Next is disabled: a required field is missing. Use browser_snapshot to see which.');
      await next.click();
      await jitter(2000, 3000);
    }
    await dumpDebug(page, 'publish_listing');
    throw new Error('Could not find the Publish button. Use browser_snapshot to finish publishing.');
  });
}

const STATUS_BUTTONS = {
  sold: /^mark (as )?(sold|out of stock)$/i,
  available: /^mark (as )?(available|in stock)$/i,
  pending: /^mark (as )?pending$/i,
};

export function updateListingStatus(idOrUrl, status) {
  const id = listingIdFrom(idOrUrl);
  return run(async (page) => {
    await navigate(page, listingUrl(id));
    await page.waitForSelector('[role="main"]', { timeout: 15000 }).catch(() => {});
    await jitter(1500, 2500);
    const main = page.locator('[role="main"]');
    const more = main.getByRole('button', { name: /^(more|more options|options|see more options)$/i }).first();

    async function clickAction(re) {
      let btn = main.getByRole('button', { name: re }).first();
      if (await shown(btn, 2000)) return btn.click().then(() => true);
      if (await shown(more, 1500)) {
        await more.click();
        await sleep(800);
        btn = page.getByRole('menuitem', { name: re }).or(page.getByRole('button', { name: re })).first();
        if (await shown(btn, 2000)) return btn.click().then(() => true);
        await page.keyboard.press('Escape');
      }
      return false;
    }

    let ok;
    if (status === 'delete') {
      ok = await clickAction(/^delete( listing)?$/i);
      if (ok) {
        await sleep(1000);
        const confirm = page.getByRole('dialog').last().getByRole('button', { name: /^delete$/i }).first();
        ok = await shown(confirm, 3000);
        if (ok) await confirm.click();
        // Facebook may ask "Did you sell it on Facebook?"; skip that survey.
        await sleep(1500);
        const skip = page.getByRole('dialog').last().getByRole('button', { name: /^(skip|not now|no)$/i }).first();
        if (await shown(skip, 1500)) await skip.click();
      }
    } else {
      ok = await clickAction(STATUS_BUTTONS[status]);
      if (ok && status === 'sold') {
        // "Who bought it?" prompt: skip naming a buyer.
        await sleep(1500);
        const skip = page.getByRole('dialog').last().getByRole('button', { name: /^(skip|not now|someone else|no one)$/i }).first();
        if (await shown(skip, 1500)) await skip.click();
      }
    }
    if (!ok) {
      await dumpDebug(page, `listing_${status}`);
      throw new Error(`Couldn't find the "${status}" control on this listing (is it yours?). Use browser_snapshot to do it manually.`);
    }
    await sleep(2000);
    logAction({ action: 'update_listing_status', id, status });
    return { id, status, done: true, screenshot: await page.screenshot({ type: 'jpeg', quality: 60 }) };
  });
}
