#!/usr/bin/env node
// `npm run login` — sign in to Facebook once; the session is saved in the local browser profile.
// `npm run login -- --pin` opens Messenger instead, so you can enter your chat-history PIN.
import { openVisibleBrowser, PROFILE_DIR } from './browser.js';

const pin = process.argv.includes('--pin');
console.log(
  pin
    ? 'Opening Messenger. Enter your PIN if asked, then close the window.'
    : `Opening a browser window. Sign in to Facebook there (profile: ${PROFILE_DIR}).`
);
const res = await openVisibleBrowser(
  pin ? { url: 'https://www.facebook.com/messages/', waitForClose: true, timeoutMs: 15 * 60 * 1000 } : { timeoutMs: 10 * 60 * 1000 }
);
if (res.loggedIn) {
  console.log(res.alreadyLoggedIn ? 'Already logged in.' : 'Done. Session saved.');
  process.exit(0);
}
console.error(`Not logged in${res.reason ? `: ${res.reason}` : '.'}`);
process.exit(1);
