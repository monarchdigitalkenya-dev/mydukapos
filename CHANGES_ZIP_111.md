# Zip 111 — Water/Aqua POS: VAT category split (A/B/Z/E/N)

## What's new
Water's VAT category "C" (merged Zero-rated/Exempt) split into distinct Z (Zero-rated) and E (Exempt), plus
N (Non-VAT) — the same tax-correctness fix delivered to the other 6 modules, adapted to water's different UI
(no Add/Edit Item form — VAT category is edited inline per row in the products table, and separately per
refill size).

- Existing products AND existing refill sizes tagged category C auto-migrate to Z on load — tax position
  unchanged (still 0%), but an owner/admin should re-flag any that are actually Exempt.
- The products-table VAT dropdown, the bale/accessory edit modal's VAT dropdown, and the refill-size VAT
  dropdown all updated to A/B/Z/E/N.
- `updateProductField` and `updateRefillVatCategory` both still tolerate an incoming legacy 'C' value
  (normalizing it to Z) in case a synced-in record from an older device still carries it.
- `vatRateForCategory` updated: Z/E/N (and the legacy C fallback) all compute to 0%, same as every other
  module.

## What's still open for water
This is a partial phase — just VAT category correctness, matching the smallest coherent piece of the
tax-engine work. Water still does NOT have:
- Per-item KRA/eTIMS classification fields (class code, eTIMS code, unit/package code, origin, item type)
- The "Help me classify this product" assistant
- X Report / Z Report
- The Audit tab

All four of those were built against root's Add/Edit Item form and Reports-tab architecture, which water
doesn't share (different item-add flow: inline table-row editing rather than a big vertical form; and a
different Reports section entirely). Bringing those to water means adapting each one to water's own UI
patterns, not a straight port — separate, larger pieces of work.

## Verification
- tests/water-vat-category.test.mjs (new, 4 tests): product and refill-size C→Z migration, Z/E/N all compute
  to 0%, and updateProductField both accepts the new categories and still normalizes a stray legacy C.
- lint-globals, water-refill-sites, water-tanks-sites, water-custom-bale-and-site-stock,
  aqua-production-bale-link, aqua-cogs-cost-price, smoke, regressions, money: 70 tests, all passing.
- `npm run check`: clean.

No router changes — deploy:router not needed.
