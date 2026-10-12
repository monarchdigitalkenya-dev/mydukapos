# Zip 258 - what changed and how it was checked

See `CHANGELOG.md` (zip 258) for the list. Files: `src/shared/blocks/first-run-customers.html` (new; written into the six till apps by `npm run sync`),
`src/shared/functions.js` (`getCustomerStatementSales` matches normalised phones), `tools/lib.mjs` (block registered), `tools/build-public-pages.mjs` and the
regenerated `public-site/*.html`, `public-site/shop.html`, `tests/zip258-first-run-customers.test.mjs`.

## How it works
* Everything in the block is additive and guarded. The old phone box `#sms-checkout-phone-input` stays in the page (hidden) and is still the only thing the
  checkout reads, so how a sale is saved did not change. `registerOrUpdateCustomer` and `awardTokensForSale` are wrapped (not replaced): the first adds the typed
  name of a new customer, the second looks the customer up by normalised phone and stamps `tokensEarned` on the sale just saved.
* The customer profile reads `salesLog`, `bills`, `returns`, `customers` only. A bill payment is linked to its customer through `billId`.

## Checked
* `tests/zip258-first-run-customers.test.mjs` runs in the real apps (jsdom): empty cards, add button opens Add New Items, cards go when stock exists, find by name and
  by part of the phone, failed sale changes nothing, tokens once, +254 variant earns tokens and creates no duplicate, duplicate phone offers the existing customer,
  bad number refused, new customer saved only by the successful sale, no customer attached links nobody, profile tabs and numbers, Escape closes, empty customer list.
* Screenshots (Chromium) at 1280 and 390 px: empty Sales Counter / Inventory, checkout field list / attached / new, customer list, profile tabs.

## Not verified here
Real M-Pesa / card / eTIMS / printing (deliberately not run), a live Cloudflare deploy, Android and Windows wrappers, Water (Aqua POS - it has a different sales counter and was not given the block).
