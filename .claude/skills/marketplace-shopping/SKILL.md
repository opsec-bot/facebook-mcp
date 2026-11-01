---
name: marketplace-shopping
description: Hunt for items on Facebook Marketplace for the user — search, open promising listings, and report a ranked shortlist. Use when the user asks to find, compare, or check prices for something on Facebook Marketplace.
---

# Shopping Facebook Marketplace

Use the `facebook-marketplace` MCP tools.

1. **Clarify only what matters**: item, budget, and location if not obvious. Don't ask about anything else; use sensible defaults.
2. **Search** with `marketplace_search`. Add `max_price` when there's a budget. Try 2–3 phrasings (brand names, synonyms, common misspellings) since sellers title listings inconsistently. Use `sort: "newest"` when the user wants fresh deals.
3. **Filter** out obvious mismatches (wrong item, accessories only, "wanted" posts, prices like $1 or $123456 that are placeholders).
4. **Open the best 3–8** with `marketplace_get_listing` to read condition, description and listing age. Use `screenshot: true` when photos matter (condition, color, damage).
5. **Report** a short ranked table: title, price, location, condition, age, link, and one line on why it's a good or risky pick. Note red flags: price far below market, vague descriptions, "shipping only" for bulky items, requests to pay off-platform.

Rules:
- Browsing only. Never message sellers, make offers, or buy anything; give the user the link instead.
- If a tool says login is needed, tell the user and offer to run `marketplace_login` (it opens a browser window on their computer for them to sign in).
- Be gentle with requests: no more than ~15 listing opens per task unless the user asks for more.
