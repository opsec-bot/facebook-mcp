#!/usr/bin/env node
// `npm run login` — sign in to Facebook once; the session is saved to the local browser profile.
import { interactiveLogin, PROFILE_DIR } from './browser.js';

console.log(`Opening a browser window. Sign in to Facebook there (profile: ${PROFILE_DIR}).`);
const res = await interactiveLogin({ timeoutMs: 10 * 60 * 1000 });
if (res.loggedIn) {
  console.log(res.alreadyLoggedIn ? 'Already logged in.' : 'Logged in. Session saved.');
  process.exit(0);
} else {
  console.error(`Login not completed: ${res.reason}`);
  process.exit(1);
}
