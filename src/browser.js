// Owns the single persistent Chromium profile (the user's Facebook login) and the one tab
// Claude drives. Every tool runs through `run()`, which serialises work and paces navigation.
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const DATA_DIR = process.env.FB_MCP_DATA_DIR || path.join(os.homedir(), '.facebook-marketplace-mcp');
export const PROFILE_DIR = process.env.FB_MCP_PROFILE_DIR || path.join(DATA_DIR, 'profile');

const HEADLESS = (process.env.FB_MCP_HEADLESS ?? 'true') !== 'false';
// Minimum gap between page loads so browsing looks like a person, not a scraper.
const MIN_INTERVAL_MS = Number(process.env.FB_MCP_MIN_INTERVAL_MS ?? 2500);

let contextPromise = null;
let activePage = null;
let lastNav = 0;
let queue = Promise.resolve();
const responseLog = []; // recent Facebook GraphQL response bodies seen by the tab

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jitter = (min, max) => sleep(min + Math.random() * (max - min));

function launchOptions(headless) {
  // Playwright's default headless build (chromium-headless-shell) can't reliably reuse a
  // profile created by headed Chromium, so use the full build ("chromium" channel) for both.
  const channel = process.env.FB_MCP_CHROME_CHANNEL || (process.env.FB_MCP_CHROME_PATH ? undefined : 'chromium');
  return {
    headless,
    channel,
    executablePath: process.env.FB_MCP_CHROME_PATH || undefined,
    viewport: { width: 1280, height: 900 },
    locale: process.env.FB_MCP_LOCALE || 'en-US',
    timezoneId: process.env.FB_MCP_TIMEZONE || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  };
}

export async function getContext({ headless = HEADLESS } = {}) {
  if (!contextPromise) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    contextPromise = chromium
      .launchPersistentContext(PROFILE_DIR, launchOptions(headless))
      .then((ctx) => {
        ctx.on('close', () => {
          contextPromise = null;
          activePage = null;
        });
        return ctx;
      })
      .catch((err) => {
        contextPromise = null;
        if (/Executable doesn't exist|browserType\.launch/i.test(err.message)) {
          err.message = `Could not start Chromium. Run \`npm run setup\` in the facebook-marketplace-mcp folder.\n${err.message}`;
        }
        throw err;
      });
  }
  return contextPromise;
}

export async function closeContext() {
  if (contextPromise) {
    const ctx = await contextPromise.catch(() => null);
    contextPromise = null;
    activePage = null;
    await ctx?.close().catch(() => {});
  }
}

function attachResponseCapture(page) {
  page.on('response', async (res) => {
    const url = res.url();
    if (!/facebook\.com\/api\/graphql/.test(url)) return;
    try {
      const body = await res.text();
      responseLog.push({ at: Date.now(), body });
      if (responseLog.length > 60) responseLog.shift();
    } catch {
      /* response body unavailable (navigation, redirect) */
    }
  });
}

/** The single tab Claude works in. Re-created if closed. */
export async function getPage() {
  const ctx = await getContext();
  if (activePage && !activePage.isClosed()) return activePage;
  activePage = ctx.pages().find((p) => !p.isClosed()) || (await ctx.newPage());
  attachResponseCapture(activePage);
  activePage.setDefaultTimeout(15000);
  return activePage;
}

/** GraphQL bodies captured since `since` (ms timestamp). */
export function graphqlSince(since) {
  return responseLog.filter((r) => r.at >= since).map((r) => r.body);
}

/** Serialise all browser work: one tool at a time, like one person with one browser. */
export function run(fn) {
  const task = async () => fn(await getPage());
  const result = queue.then(task, task);
  queue = result.catch(() => {});
  return result;
}

/** Navigate the tab with pacing and login-wall detection. */
export async function navigate(page, url, { waitUntil = 'domcontentloaded' } = {}) {
  const wait = lastNav + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait + Math.random() * 600);
  lastNav = Date.now();
  await page.goto(url, { waitUntil, timeout: 45000 });
  await checkBlocked(page);
}

export async function checkBlocked(page) {
  const url = page.url();
  if (/facebook\.com\/(login|checkpoint)/.test(url)) {
    throw new NotLoggedInError(/checkpoint/.test(url));
  }
}

export class NotLoggedInError extends Error {
  constructor(checkpoint = false) {
    super(
      checkpoint
        ? 'Facebook wants a security check (checkpoint) before continuing. Call marketplace_login so the user can complete it in a visible browser window.'
        : 'Facebook is asking for a login. Call marketplace_login (opens a browser window for the user to sign in), or have the user run `npm run login` in the facebook-marketplace-mcp folder.'
    );
    this.name = 'NotLoggedInError';
  }
}

export async function currentUserId() {
  const ctx = await getContext();
  const cookies = await ctx.cookies('https://www.facebook.com');
  return cookies.find((c) => c.name === 'c_user' && c.value)?.value ?? null;
}

/**
 * Open a visible browser window for the user to do something only a person should do:
 * sign in, pass a checkpoint, or enter their Messenger PIN. Resolves when signed in and
 * (if `waitForClose`) when the user closes the window, or on timeout.
 */
export async function openVisibleBrowser({ url, timeoutMs = 5 * 60 * 1000, waitForClose = false } = {}) {
  await closeContext();
  const ctx = await getContext({ headless: false });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    const signedIn = async () => Boolean(await currentUserId().catch(() => null));
    const already = await signedIn();
    await page.goto(url || (already ? 'https://www.facebook.com/marketplace/' : 'https://www.facebook.com/login/?next=%2Fmarketplace%2F'));
    const deadline = Date.now() + timeoutMs;
    let closed = false;
    let lastKnown = already;
    ctx.on('close', () => (closed = true));
    while (Date.now() < deadline && !closed) {
      lastKnown = await signedIn().catch(() => lastKnown);
      if (!waitForClose && lastKnown) {
        if (already && !url) return { loggedIn: true, alreadyLoggedIn: true };
        await sleep(2500); // let Facebook finish writing cookies
        return { loggedIn: true };
      }
      if (waitForClose && ctx.pages().every((p) => p.isClosed())) break;
      await sleep(1000);
    }
    return { loggedIn: lastKnown, ...(Date.now() >= deadline && { reason: 'Timed out waiting for the user.' }) };
  } finally {
    await closeContext(); // next tool call relaunches headless with the saved session
  }
}

/** Wait up to `timeout` ms for a locator to become visible. (locator.isVisible() never waits.) */
export function shown(locator, timeout = 1500) {
  return locator
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
}
