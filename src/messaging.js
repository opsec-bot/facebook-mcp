// Messaging sellers and buyers: first message from a listing, follow-ups, inbox, reading
// and replying to conversations. Selectors follow public Marketplace automation projects
// ("Send seller a message" box, "Message again" button, chat textboxes labelled
// "Write to <name> · <listing title>", bubbles labelled "Message sent <time> by <name>: <text>").
import fs from 'node:fs';
import path from 'node:path';
import { run, navigate, sleep, jitter, shown, DATA_DIR } from './browser.js';
import { BASE, listingIdFrom, listingUrl, bodyText, mainText, dumpDebug, dismissPopups } from './marketplace.js';

const MAX_PER_HOUR = Number(process.env.FB_MCP_MAX_MESSAGES_PER_HOUR ?? 20);
const sentTimes = [];

const RATE_LIMIT_RE = /reached the messaging limit|can['’]t send messages right now|temporarily blocked|you['’]re sending messages too fast/i;
const PIN_RE = /enter your pin|restore (your )?chat history|enter (the )?pin to|create a pin|secure storage/i;

export function logAction(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, 'actions.log'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* logging is best-effort */
  }
}

function checkSendBudget() {
  const hourAgo = Date.now() - 3600_000;
  while (sentTimes.length && sentTimes[0] < hourAgo) sentTimes.shift();
  if (sentTimes.length >= MAX_PER_HOUR) {
    throw new Error(
      `Paused: ${sentTimes.length} messages sent in the last hour (limit FB_MCP_MAX_MESSAGES_PER_HOUR=${MAX_PER_HOUR}). ` +
        'Sending more quickly risks Facebook restricting the account.'
    );
  }
}

/** Type text into a textarea or rich (contenteditable) composer, keeping line breaks. */
export async function typeMessage(page, box, message) {
  await box.click();
  const tag = await box.evaluate((el) => el.tagName).catch(() => '');
  if (tag === 'TEXTAREA' || tag === 'INPUT') {
    await box.fill(message);
    return;
  }
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  const lines = message.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i) await page.keyboard.press('Shift+Enter');
    if (lines[i]) await page.keyboard.insertText(lines[i]);
  }
}

async function detectProblems(page) {
  const text = await bodyText(page, 20000);
  if (RATE_LIMIT_RE.test(text)) return 'rate_limited';
  if (PIN_RE.test(text)) return 'pin_required';
  return null;
}

function pinError() {
  return new Error(
    'Messenger is asking for the end-to-end encryption PIN to show chat history. ' +
      'Call marketplace_login with url "https://www.facebook.com/messages/" so the user can enter their PIN once in a visible window, then retry.'
  );
}

/** Parse chat bubbles from aria-labels like "Message sent 4:01 PM by Lucas: Is it available?". */
export function parseBubbleLabels(labels) {
  const out = [];
  const seen = new Set();
  for (const label of labels) {
    if (!label || seen.has(label)) continue;
    const m = label.match(/Message sent (.+?) by ([^:]+?)(?::\s([\s\S]*))?$/);
    if (!m) continue;
    seen.add(label);
    out.push({ time: m[1].replace(/ /g, ' ').trim(), sender: m[2].trim(), text: m[3] ?? '[attachment]' });
  }
  return out;
}

async function bubblesIn(scope) {
  const labels = await scope
    .locator('[aria-label*="Message sent "]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    .catch(() => []);
  return parseBubbleLabels(labels);
}

/** The composer of a docked chat for this listing ("Write to <seller> · <title>"), else the last visible one. */
async function chatComposer(page, title) {
  if (title) {
    const exact = page.locator(`div[role="textbox"][contenteditable="true"][aria-label$=${JSON.stringify(' · ' + title)}]`).last();
    if (await shown(exact, 6000)) return exact;
  }
  const any = page.locator('div[role="textbox"][contenteditable="true"]:visible').last();
  return (await shown(any, 6000)) ? any : null;
}

export function messageSeller(listing, message) {
  const id = listingIdFrom(listing);
  if (!message?.trim()) throw new Error('Message text is empty.');
  return run(async (page) => {
    checkSendBudget();
    await navigate(page, listingUrl(id));
    await page.waitForSelector('[role="main"]', { timeout: 15000 }).catch(() => {});
    await jitter(1500, 2500);
    await dismissPopups(page);
    const main = page.locator('[role="main"]');
    const title = (await main.locator('h1').first().innerText({ timeout: 3000 }).catch(() => '')).trim();
    if (/^sold$/im.test(await mainText(page, 4000))) {
      return { id, status: 'not_sent', reason: 'Listing is marked sold.' };
    }

    let mode;
    const again = main.locator('[aria-label="Message again"]:visible').first();
    if (await shown(again, 4000)) {
      mode = 'follow_up';
      await again.click();
      const box = await chatComposer(page, title);
      if (!box) throw new Error('Opened the existing chat but could not find its message box. Use browser_snapshot to continue.');
      await jitter(1500, 2500); // let history load
      await typeMessage(page, box, message);
      await jitter(400, 900);
      await page.keyboard.press('Enter');
    } else {
      mode = 'first_message';
      // Inline "Send seller a message" box on the listing (pre-filled "Is this still available?").
      let box = main.locator('textarea:visible, [role="textbox"][contenteditable="true"]:visible').first();
      let scope = main;
      if (!(await shown(box, 2500))) {
        const opener = main.getByRole('button', { name: /^(message|message seller|send seller a message|send message)$/i }).first();
        if (!(await shown(opener, 2500))) {
          const dump = await dumpDebug(page, 'message_no_button');
          throw new Error(`No message box or Message button found on this listing.${dump ? ` HTML saved to ${dump}.` : ''} Use browser_snapshot to continue.`);
        }
        await opener.click();
        scope = page.getByRole('dialog').last();
        box = scope.locator('textarea:visible, [role="textbox"][contenteditable="true"]:visible').first();
        if (!(await shown(box, 6000))) box = await chatComposer(page, title);
        if (!box) throw new Error('Clicked Message but no message box appeared. Use browser_snapshot to continue.');
      }
      await typeMessage(page, box, message);
      await jitter(500, 1000);
      const send = scope.getByRole('button', { name: /^(send|send message)$/i }).first();
      if (await shown(send, 1500)) await send.click();
      else await page.keyboard.press('Enter');
    }

    await jitter(2500, 3500);
    const problem = await detectProblems(page);
    if (problem === 'rate_limited') {
      logAction({ action: 'message_seller', id, status: 'rate_limited' });
      return { id, status: 'rate_limited', reason: 'Facebook says the messaging limit was reached. Stop sending messages for now.' };
    }
    sentTimes.push(Date.now());
    const snippet = message.trim().split('\n')[0].slice(0, 40);
    const confirmed =
      (await shown(main.locator('[aria-label="Message again"]').first(), 3000)) ||
      (await page.locator(`[aria-label*="Message sent "][aria-label*=${JSON.stringify(snippet)}]`).count()) > 0 ||
      (await shown(page.getByText(/message sent|sent to seller/i).first(), 1000));
    const status = confirmed ? 'sent' : 'probably_sent';
    logAction({ action: 'message_seller', id, mode, status, message });
    if (!confirmed) await dumpDebug(page, 'message_unconfirmed');
    return {
      id,
      url: listingUrl(id),
      mode,
      status,
      ...(!confirmed && { note: 'Could not confirm the message on screen. Check with marketplace_read_conversation before resending, to avoid a duplicate.' }),
    };
  });
}

const THREAD_RE = /\/(?:messages|marketplace)\/t\/(\d+)/;

export function threadUrlFrom(input) {
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return `${BASE}/messages/t/${s}/`;
  const m = s.match(THREAD_RE);
  if (m) return s.startsWith('http') ? s : `${BASE}${s}`;
  return null;
}

export function listConversations({ limit = 30, tab } = {}) {
  return run(async (page) => {
    const candidates = [`${BASE}/marketplace/inbox/`, `${BASE}/messages/`];
    let rows = [];
    for (const url of candidates) {
      await navigate(page, url);
      await jitter(2500, 3500);
      if (tab) {
        const t = page.getByRole('tab', { name: new RegExp(`^${tab}`, 'i') }).or(page.getByRole('link', { name: new RegExp(`^${tab}$`, 'i') })).first();
        if (await shown(t, 2500)) {
          await t.click();
          await jitter(1500, 2500);
        }
      }
      rows = await page.$$eval('a[href*="/t/"]', (as) =>
        as.map((a) => ({
          href: a.getAttribute('href'),
          lines: (a.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean),
          label: a.getAttribute('aria-label') || '',
          unread: /unread/i.test(a.getAttribute('aria-label') || '') || !!a.querySelector('[aria-label*="unread" i], [aria-label="Mark as read"]'),
        }))
      );
      rows = rows.filter((r) => THREAD_RE.test(r.href || ''));
      if (rows.length) break;
      if ((await detectProblems(page)) === 'pin_required') throw pinError();
    }
    const seen = new Set();
    const conversations = [];
    for (const r of rows) {
      const id = r.href.match(THREAD_RE)[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const [name, ...rest] = r.lines;
      conversations.push({
        threadId: id,
        url: `${BASE}/messages/t/${id}/`,
        name: name ?? null,
        preview: rest.join(' · ') || null,
        unread: r.unread,
      });
      if (conversations.length >= limit) break;
    }
    return {
      pageUrl: page.url(),
      count: conversations.length,
      conversations,
      ...(!conversations.length && { pageTextPreview: await bodyText(page, 2000) }),
    };
  });
}

/** Open a conversation from a thread id/URL or a listing (via "Message again"). Returns the composer + scope. */
async function openConversation(page, target) {
  const threadUrl = threadUrlFrom(target);
  if (threadUrl) {
    await navigate(page, threadUrl);
    await jitter(2500, 3500);
    if ((await detectProblems(page)) === 'pin_required') throw pinError();
    const box = page.locator('div[role="textbox"][contenteditable="true"]:visible').last();
    const scope = page.locator('[role="main"]').first();
    return { box: (await shown(box, 8000)) ? box : null, scope, url: page.url() };
  }
  const id = listingIdFrom(target);
  await navigate(page, listingUrl(id));
  await page.waitForSelector('[role="main"]', { timeout: 15000 }).catch(() => {});
  await jitter(1500, 2500);
  const main = page.locator('[role="main"]');
  const again = main.locator('[aria-label="Message again"]:visible').first();
  if (!(await shown(again, 6000))) return { box: null, scope: null, url: page.url(), noConversation: true };
  const title = (await main.locator('h1').first().innerText({ timeout: 3000 }).catch(() => '')).trim();
  await again.click();
  const box = await chatComposer(page, title);
  await jitter(1500, 2500);
  if ((await detectProblems(page)) === 'pin_required') throw pinError();
  const scope = box ? box.locator('xpath=ancestor::div[.//*[contains(@aria-label, "Message sent ")]][1]') : page.locator('body');
  return { box, scope: (await scope.count()) ? scope : page.locator('body'), url: page.url() };
}

export function readConversation(target, { limit = 50 } = {}) {
  return run(async (page) => {
    const conv = await openConversation(page, target);
    if (conv.noConversation) return { messages: [], note: "You haven't messaged this seller about this listing yet." };
    // Scroll up a little to load older messages.
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, -2500).catch(() => {});
      await sleep(700);
    }
    const messages = (await bubblesIn(conv.scope)).slice(-limit);
    const listingLink = await page.locator('a[href*="/marketplace/item/"]').first().getAttribute('href', { timeout: 1500 }).catch(() => null);
    const res = {
      url: conv.url,
      ...(listingLink && { listing: listingUrl(listingLink.match(/item\/(\d+)/)?.[1]) }),
      messages,
    };
    if (!messages.length) {
      // Bubble labels differ by layout; give Claude the conversation text instead.
      const t = conv.scope ? await conv.scope.innerText({ timeout: 3000 }).catch(() => '') : await mainText(page);
      res.conversationText = t.replace(/\n{3,}/g, '\n\n').slice(-6000);
    }
    return res;
  });
}

export function replyToConversation(target, message) {
  if (!message?.trim()) throw new Error('Message text is empty.');
  return run(async (page) => {
    checkSendBudget();
    const conv = await openConversation(page, target);
    if (conv.noConversation) throw new Error('No existing conversation for this listing. Use marketplace_message_seller to start one.');
    if (!conv.box) throw new Error('Could not find the message box in this conversation. Use browser_snapshot to continue.');
    await typeMessage(page, conv.box, message);
    await jitter(400, 900);
    await page.keyboard.press('Enter');
    await jitter(2000, 3000);
    if ((await detectProblems(page)) === 'rate_limited') {
      logAction({ action: 'reply', target, status: 'rate_limited' });
      return { status: 'rate_limited', reason: 'Facebook says the messaging limit was reached.' };
    }
    sentTimes.push(Date.now());
    const snippet = message.trim().split('\n')[0].slice(0, 40);
    const confirmed = (await page.locator(`[aria-label*=${JSON.stringify(snippet)}]`).count()) > 0 || (await shown(page.getByText(snippet).last(), 2000));
    logAction({ action: 'reply', target, status: confirmed ? 'sent' : 'probably_sent', message });
    return { url: conv.url, status: confirmed ? 'sent' : 'probably_sent' };
  });
}
