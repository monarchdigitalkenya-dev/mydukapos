# Zip 113 — eTIMS submission validation ported to hotel, hospital, production, services, pharmacy

Same feature delivered in root (zip 112), now applied to the other 5 modules. Each had a slightly different
persistence pattern in submitSaleToEtims (some use persistSalesLogChange(), some inline safeSetItem calls —
one, or two, depending on the module), so the validation was wired in to match each module's own existing
pattern exactly rather than forcing a single shape:

- hotel, production: two safeSetItem calls (sales log + stock movement log)
- hospital: one safeSetItem call (sales log only)
- services, pharmacy: persistSalesLogChange() helper, same as root

The validateSaleForEtims() function itself is identical everywhere: hard errors (bad name/qty/price/VAT
category) block submission with a clear reason; an unclassified item is a warning that does NOT block the
actual KRA filing.

## Verification
- tests/etims-validation.test.mjs expanded to run its 4 checks against all 6 modules (24/24 passing, up
  from 4/4 root-only in zip 112).
- lint-globals, smoke, regressions: 21/21 clean.
- Broader regression sweep: kra-classification, kra-assistant, xz-reports, audit-tab, water-vat-category,
  money, receipts, patient-billing, hmis-integrity — 236 tests, zero failures.
- `npm run check`: clean across all 7 modules.

No router changes — deploy:router not needed.
