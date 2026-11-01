---
name: marketplace-shopping
description: Use Facebook Marketplace for the user — find and compare items, vet listings and sellers, message sellers, follow up on chats, and sell their own items. Use whenever the user mentions Facebook Marketplace, FB Marketplace, or buying/selling something locally secondhand.
---

# Using Facebook Marketplace for the user

Tools come from the `facebook-marketplace` MCP server. It is a real browser signed in as the user, so anything you send is from them.

## Buying

1. **Clarify only what matters**: item, budget, area. Use sensible defaults for the rest.
2. **Search** with `marketplace_search`. Try 2–3 phrasings (brand names, synonyms, misspellings). Use `max_price`, `sort: "newest"` for fresh deals, `days_since_listed: 7`, `delivery: "pickup"` for bulky items. For a city by name, call `marketplace_set_location` once first.
3. **Filter** out mismatches: accessories only, "wanted"/ISO posts, sold items, placeholder prices ($1, $123).
4. **Vet the best 3–8** with `marketplace_get_listing` (`photos: 3` when condition matters). For pricey items, check `marketplace_seller_profile` (rating, join date, other listings).
5. **Report** a ranked table: title, price, location, condition, age, link, and one line on why. Call out red flags.
6. **Message** with `marketplace_message_seller` when the user asks (e.g. "ask the top 3 if they'd take $80"). Write short, friendly, specific messages in the user's voice. If unclear whether they want to send, show the drafts first.
7. **Follow up**: `marketplace_list_conversations` → `marketplace_read_conversation` → `marketplace_reply`. Summarise replies for the user and ask before agreeing to a price, time or place they haven't approved.

## Selling

- `marketplace_your_listings` shows what they sell and its status.
- `marketplace_create_listing` fills in the form and returns a screenshot. Show it to the user, and only call `marketplace_publish_listing` after they approve.
- `marketplace_update_listing` marks sold, available or pending, or deletes. Confirm before deleting.
- Price help: search the same item, sold and active, and suggest a range.

## When things break

Facebook changes its layout often. If a structured tool errors or returns empty fields:
`browser_snapshot` → read the refs → `browser_click` / `browser_type` / `browser_scroll` → `browser_snapshot` again. Refs go stale after the page changes, so snapshot again before acting. `browser_screenshot` shows what the page looks like.

If you see a login, checkpoint or PIN message, call `marketplace_login` (with `url: "https://www.facebook.com/messages/"` for the PIN). The user completes it in a window on their computer. Never ask for their password or codes.

## Rules

- Never agree to pay, send deposits, share phone, address or payment details, or move to another app unless the user explicitly said to.
- Scam signs to flag: deposits before viewing, gift cards, Zelle/Cash App to strangers, verification codes, "my cousin will deliver", prices far below market, brand-new accounts with no ratings.
- Pace yourself: a few seconds between actions, no mass messaging. Stop if `rate_limited` comes back.
- If a send returns `probably_sent`, read the conversation before resending, to avoid duplicates.
