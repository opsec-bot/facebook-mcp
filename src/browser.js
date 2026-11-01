// Manages a single persistent Chromium profile so the user's Facebook login survives restarts.
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const PROFILE_DIR =
  process.env.FB_MCP_PROFILE_DIR || path.join(os.homedir(), '.facebook-marketplace-mcp', 'profile');

const HEADLESS = (process.env.FB_MCP_HEADLESS ?? 'true') !== 'false';
// Minimum delay between page loads, to browse at a human-ish pace.
const MIN_INTERVAL_MS = Number(process.env.FB_MCP_MIN_INTERVAL_MS ?? 2500);

let contextPromise = null;
let lastNav = 0;
let queue = Promise.resolve();

export async function getContext({ headless = HEADLESS } = {}) {
  if (!contextPromise) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    contextPromise = chromium
      .launchPersistentContext(PROFILE_DIR, {
        headless,
        executablePath: process.env.FB_MCP_CHROME_PATH || undefined,
        channel: process.env.FB_MCP_CHROME_CHANNEL || undefined,
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
        args: ['--disable-blink-features=AutomationControlled'],
      })
      .then((ctx) => {
        ctx.on('close', () => {
          contextPromise = null;
        });
        return ctx;
      })
      .catch((err) => {
        contextPromise = null;
        throw err;
      });
  }
  return contextPromise;
}

export async function closeContext() {
  if (contextPromise) {
    const ctx = await contextPromise.catch(() => null);
    contextPromise = null;
    await ctx?.close().catch(() => {});
  }
}

/**
 * Run fn(page) on a fresh tab, one at a time, with rate limiting between navigations.
 */
export function withPage(fn) {
  const run = async () => {
    const wait = lastNav + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    const ctx = await getContext();
    const page = await ctx.newPage();
    try {
      return await fn(page);
    } finally {
      lastNav = Date.now();
      await page.close().catch(() => {});
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

export function isLoginPage(url) {
  return /facebook\.com\/(login|checkpoint)/.test(url);
}

export class NotLoggedInError extends Error {
  constructor() {
    super(
      'Facebook is asking for a login. Run `npm run login` in the facebook-marketplace-mcp folder, ' +
        'sign in in the browser window that opens, then try again (or ask Claude to run the marketplace_login tool).'
    );
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hasSession(ctx) {
  const cookies = await ctx.cookies('https://www.facebook.com');
  return cookies.some((c) => c.name === 'c_user' && c.value);
}

/**
 * Open a visible browser window so the user can sign in to Facebook themselves.
 * Resolves once a session cookie appears (or the window is closed / timeout hits).
 */
export async function interactiveLogin({ timeoutMs = 5 * 60 * 1000 } = {}) {
  await closeContext();
  const ctx = await getContext({ headless: false });
  try {
    if (await hasSession(ctx)) return { loggedIn: true, alreadyLoggedIn: true };
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto('https://www.facebook.com/login/?next=%2Fmarketplace%2F');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!contextPromise) return { loggedIn: false, reason: 'Browser window was closed before login finished.' };
      if (await hasSession(ctx).catch(() => false)) {
        await sleep(2000); // let Facebook finish setting cookies
        return { loggedIn: true };
      }
      await sleep(1000);
    }
    return { loggedIn: false, reason: 'Timed out waiting for login.' };
  } finally {
    await closeContext(); // next use relaunches in headless mode with the saved session
  }
}
