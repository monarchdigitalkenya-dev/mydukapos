# Zip 103 — Tax engine Phase 1 (root), Past Sale/Hire pricing fix, Aqua COGS fix

## KRA/eTIMS tax classification — Phase 1 of the 72-section audit spec (root/index.html only, reference module)
- VAT category "C" (merged Zero-rated/Exempt) split into distinct Z (Zero-rated), E (Exempt), and new N (Non-VAT).
  Existing category-C items auto-migrate to Z on load per owner decision; migration logged on the item.
- Added a per-item KRA/eTIMS classification block (class code, eTIMS item code, unit code, package code, country
  of origin, item type) to the Add/Edit Item form — defaults to "Not yet classified", never invented. Status only
  becomes "Confirmed" once a class code AND eTIMS code are both entered.
- Every classification change (migration or manual) is logged on the item's own `kraClassificationHistory` array
  (date, user, source, previous→new value, reason) — ready for the future Audit tab to read from.
- New tests/kra-classification.test.mjs (4 tests).
- Not yet done: ported to the other 6 modules, the "Help me classify this product" AI assistant, a single shared
  tax-engine module, eTIMS submission validation against these fields, report/receipt labels for Z/E/N.

## Record a Past Sale — Retail/Wholesale/Custom pricing (root, production, hotel, services, pharmacy)
- Root cause: the price field always silently defaulted to retail with no visible way to charge wholesale — a
  person had to know the exact wholesale figure and type it in by hand.
- Fixed once in src/shared/functions.js (selectPastSaleItem + new choosePastSalePriceTier), synced to all 5 modules
  that have this feature. Retail/Wholesale/Custom quick-select buttons added above the price field; Wholesale is
  hidden when the item has none set.
- New tests/past-sale-price-tier.test.mjs (10 tests, one set per module).

## Record a Past Hire — Retail/Wholesale pricing (production only — the only module with hiring)
- Root cause: resolvePastHireGeneralSelection() always used hirePricePerDay even though the live Hiring Counter's
  own cart price picker (selectHireCartPriceOption) already supports a wholesaleHirePricePerDay rate — Record Past
  Hire just never wired it in.
- Added Retail/Wholesale toggle for Individual-mode past hires (hidden for Group/Set lines, which have no
  wholesale tier in the data model, same as the live counter); wholesale button hidden when the item has none set.
- New tests/past-hire-price-tier.test.mjs (2 tests).

## Aqua POS (water) — cost price not used for profit calculation
- Root cause: itemCogs() only ever computed cost from a BOM (materialsUsed) or the litre rate for refills — a plain
  item, sealed bottle, or bale with no production recipe (exactly the case where the cost price is set directly)
  contributed ZERO cost to COGS regardless of what its Cost Price was set to, so gross profit was overstated by the
  full cost of every such sale.
- Fixed by snapshotting each line's cost price at checkout time (`costAtSale`, from the product's own
  wholesalePrice) and using it in itemCogs(), with a fallback to the product's current cost for sales recorded
  before this fix existed. Applied to checkoutCart() and the Exchange/Return replacement-item flow.
- New tests/aqua-cogs-cost-price.test.mjs (3 tests).

Targeted test run: 64/64 passing across the new + adjacent regression files (money, regressions, gas, hold-sale,
receipts, storage). Full 656-file suite not re-run this zip due to its ~5min runtime; shared-code drift check
(`npm run check`) is clean. No router changes — deploy:router not needed.
