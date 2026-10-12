# Zip 263 - Visual refresh of the POS apps

Scope: the same override stylesheet (`<style id="mdp-ui-2">`, last thing before `</body>`) in `index.html` (Shop), `water/`, `hotel/`, `hospital/`, `pharmacy/`, `production/`, `services/`.
It restyles colour, type, radius, shadows, focus and feedback. The Sales Counter's sticky/height logic (zip 168-181) is untouched: no `display`, `position`, `flex`/`grid` or sizing rule it measures was changed. Print is unchanged (`@media screen`).

Markup edits: `aria-label` on the alerts bell, barcode button (Shop) and main `<nav>`; `role="status" aria-live="polite"` on `#toast`; skip-to-content link + `#main-content` anchor; `name` on the sign-in / registration inputs (Shop); `theme-color` meta; search placeholder ellipsis (Shop).
`manifest.webmanifest`: `theme_color` -> `#10272a`.

Service workers (all 9): fingerprint ignores Cloudflare per-request rewrites; the freshly shown window is not told; `SW_VERSION` zip-263; fingerprint key `page-hash-2`.

Public site: `public-site/dashboard.html` links fixed; `functions/_middleware.js` serves the marketing home at the apex `/index.html`. Sales Counter polish in the override block (cart cells, search results, mini cart bar total, empty-cart Confirm, stray phonebook icon).

Owner Console + sample shops: Generate Link (Demo / Permanent), Get my own link (`functions/api/get-my-link.js`, `src/shared/blocks/shared-demo.html`), sample data without the word demo, light/dark banner, 3 photos per row + category tiles by default, shots in the Liquor Store and the Hotel's bar (`functions/api/_demo-seeds.js`).
Repeat buyers and licence: see the CHANGELOG entry "Get my own link, round 2" (branch question, optional email, licence PDF).
Trash / contacts and prices: see the CHANGELOG entries "Trash and contacts" and "Prices are editable" (`_forget.js`, `_prices.js`, `product-prices.js`, Owner Console Trash + Prices tabs). Set your prices once under Owner Console -> Prices; until then every product uses the website price (KES 3,000).
Setup note: "Get my own link" sends an M-Pesa prompt only when the OWNER account (the console's own shop) has a payment gateway saved in its Settings -> Payment Gateway; otherwise the buyer uses "I've made this payment" and you confirm it. Every sample shop loads the new data by itself on its next visit (`SEED_VERSION` is now 2); "Refresh the sample data of every shop" under Generate Link -> Demo does it at once.

Not changed: `owner/`, `public-site/`, `order/`, `src/shared` blocks (the sidebar is recoloured from the override block), `functions/`, migrations.

Known gaps: emoji icons are not `aria-hidden` (they live in shared-block strings); the phone header still wraps to three rows (it has the existing Hide button); Aqua (`water/`) rendered a blank content area in the headless check with or without this block, so it was not verified visually; the other apps were checked on the Sales Counter only.

