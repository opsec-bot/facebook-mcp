// General browser control so Claude can do anything a person can on Facebook, even when the
// structured tools don't cover it or Facebook changed its layout. Uses Playwright's AI aria
// snapshot: every element gets a [ref=eN] that browser_click / browser_type accept.
import fs from 'node:fs';
import path from 'node:path';
import { run, navigate, checkBlocked, sleep } from './browser.js';

const ALLOWED_HOSTS = /(^|\.)(facebook\.com|messenger\.com|fb\.com)$/i;
const MAX_SNAPSHOT = Number(process.env.FB_MCP_MAX_SNAPSHOT_CHARS ?? 40000);

export function assertAllowedUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.test(u.hostname)) {
    throw new Error('Only https://facebook.com, messenger.com and fb.com pages can be opened.');
  }
  return u.toString();
}

async function pageInfo(page) {
  return { url: page.url(), title: await page.title().catch(() => '') };
}

/** Pick what to snapshot: an open dialog if any (it blocks the page), else main, else body. */
async function snapshotRoot(page, scope) {
  if (scope === 'page') return { locator: page.locator('body'), scope: 'page' };
  const dialog = page.locator('[role="dialog"]:visible').last();
  if ((scope === 'auto' || scope === 'dialog') && (await dialog.count())) return { locator: dialog, scope: 'dialog' };
  const main = page.locator('[role="main"]').first();
  if (scope !== 'dialog' && (await main.count())) return { locator: main, scope: 'main' };
  return { locator: page.locator('body'), scope: 'page' };
}

export async function takeSnapshot(page, scope = 'auto') {
  const root = await snapshotRoot(page, scope);
  let snap = await root.locator.ariaSnapshot({ mode: 'ai', timeout: 10000 });
  let truncated = false;
  if (snap.length > MAX_SNAPSHOT) {
    snap = snap.slice(0, MAX_SNAPSHOT);
    truncated = true;
  }
  return {
    ...(await pageInfo(page)),
    scope: root.scope,
    ...(truncated && { note: `Snapshot cut at ${MAX_SNAPSHOT} characters. Scroll, or use scope "dialog"/"main", to see the rest.` }),
    snapshot: snap,
  };
}

function refLocator(page, ref) {
  const r = String(ref).replace(/^\[?ref=/, '').replace(/\]$/, '');
  if (!/^[a-z0-9]+$/i.test(r)) throw new Error(`Bad ref "${ref}". Use a ref like e12 or f3e7 from browser_snapshot.`);
  return page.locator(`aria-ref=${r}`);
}

/** Resolve a target: a snapshot ref, or visible text / accessible name as a fallback. */
function target(page, { ref, text, role }) {
  if (ref) return refLocator(page, ref);
  if (text && role) return page.getByRole(role, { name: text }).first();
  if (text) return page.getByRole('button', { name: text }).or(page.getByRole('link', { name: text })).or(page.getByText(text, { exact: true })).first();
  throw new Error('Give a ref from browser_snapshot (or text to match).');
}

async function act(page, fn) {
  try {
    await fn();
  } catch (err) {
    if (/Timeout .* exceeded/i.test(err.message)) {
      throw new Error('That element is gone or not clickable (the page probably changed). Call browser_snapshot for fresh refs.');
    }
    throw err;
  }
  await sleep(1200);
  await checkBlocked(page);
  return pageInfo(page);
}

export const browserNavigate = (url) =>
  run(async (page) => {
    await navigate(page, assertAllowedUrl(url));
    await sleep(2000);
    return takeSnapshot(page);
  });

export const browserSnapshot = (scope) => run((page) => takeSnapshot(page, scope));

export const browserClick = (t) =>
  run((page) => act(page, () => target(page, t).click({ timeout: 8000, ...(t.double && { clickCount: 2 }) })));

export const browserType = ({ ref, text, role, value, submit, clear = true }) =>
  run((page) =>
    act(page, async () => {
      const el = target(page, { ref, text, role });
      await el.click({ timeout: 8000 });
      const editable = await el.evaluate((e) => e.isContentEditable).catch(() => false);
      if (editable) {
        if (clear) {
          await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
          await page.keyboard.press('Backspace');
        }
        const lines = value.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (i) await page.keyboard.press('Shift+Enter');
          if (lines[i]) await page.keyboard.insertText(lines[i]);
        }
      } else if (clear) await el.fill(value, { timeout: 8000 });
      else await el.pressSequentially(value, { delay: 30 });
      if (submit) await page.keyboard.press('Enter');
    })
  );

export const browserPressKey = (key) => run((page) => act(page, () => page.keyboard.press(key)));

export const browserSelectOption = ({ ref, values }) =>
  run((page) => act(page, () => refLocator(page, ref).selectOption(values, { timeout: 8000 })));

export const browserHover = ({ ref, text }) => run((page) => act(page, () => target(page, { ref, text }).hover({ timeout: 8000 })));

export const browserScroll = ({ direction = 'down', amount = 1 }) =>
  run(async (page) => {
    const dy = { down: 800, up: -800 }[direction] ?? 800;
    for (let i = 0; i < Math.min(amount, 10); i++) {
      await page.mouse.wheel(0, dy);
      await sleep(600);
    }
    await sleep(800);
    return pageInfo(page);
  });

export const browserBack = () =>
  run(async (page) => {
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(1500);
    return pageInfo(page);
  });

export const browserWait = ({ text, seconds }) =>
  run(async (page) => {
    if (text) await page.getByText(text).first().waitFor({ timeout: Math.min((seconds ?? 15) * 1000, 60000) });
    else await sleep(Math.min((seconds ?? 2) * 1000, 30000));
    return pageInfo(page);
  });

export const browserScreenshot = ({ fullPage = false, ref } = {}) =>
  run(async (page) => {
    const opts = { type: 'jpeg', quality: 70 };
    const buf = ref ? await refLocator(page, ref).screenshot({ ...opts, timeout: 8000 }) : await page.screenshot({ ...opts, fullPage });
    return { ...(await pageInfo(page)), image: buf };
  });

export const browserUploadFiles = ({ paths, ref }) =>
  run((page) =>
    act(page, async () => {
      const files = paths.map((p) => path.resolve(p.replace(/^~(?=$|\/)/, process.env.HOME || '')));
      for (const f of files) if (!fs.existsSync(f)) throw new Error(`File not found: ${f}`);
      if (ref) {
        // ref is usually an "Add photos" button: click it and answer the file chooser.
        const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 8000 }), refLocator(page, ref).click({ timeout: 8000 })]);
        await chooser.setFiles(files);
      } else {
        await page.locator('input[type="file"]').first().setInputFiles(files, { timeout: 8000 });
      }
    })
  );
