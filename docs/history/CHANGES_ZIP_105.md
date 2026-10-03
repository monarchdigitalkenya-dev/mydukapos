# Zip 105 — Fixes the hospital `npm run check` failure from zip 104

## Root cause
Zip 103's Record-a-Past-Sale Retail/Wholesale/Custom pricing fix was scoped to 5 modules (root, production,
hotel, services, pharmacy) — but hospital has the exact same "Record a Past Sale" feature and shares the same
`selectPastSaleItem` code via src/shared/functions.js. The shared-code sync still pushed the updated function
(which references a `pastSalePriceTier` variable and calls `choosePastSalePriceTier`) into hospital, since it
already carried that function under the shared-sync marker — but hospital never got the new variable
declaration or the tier-button HTML, because I didn't check for it there. `npm run check` runs
tests/lint-globals.test.mjs, which correctly caught the undeclared variable.

## Fix
- Added `let pastSalePriceTier = 'retail';` to hospital/index.html (was missing).
- Added the same Retail/Wholesale/Custom quick-select buttons above the past-sale price field that the other
  5 modules already have.
- Added the matching `.price-tier-btn.active` CSS rule.
- Registered `choosePastSalePriceTier` in hospital's shared-function name list and re-ran `npm run check`'s
  sync step so hospital now carries the same function body as the other 6 modules.
- Hospital's Record a Past Sale now behaves identically to root/production/hotel/services/pharmacy.

## Verification (this time, the full suite — not a subset)
- `npm run check` (shared-code drift check): clean.
- Every one of the 87 test files in tests/ run to completion in batches: 700+ individual test cases,
  zero failures, including the specific lint-globals test that caught this.
- tests/past-sale-price-tier.test.mjs extended to also run its checks against hospital (12/12 passing,
  up from 10/10 in zip 103/104).

No router changes — deploy:router not needed.
