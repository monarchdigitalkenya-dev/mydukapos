# Zip 104 — KRA tax-engine Phase 1 ported to all 6 remaining modules

Same fix set delivered in root (zip 103) — VAT category split (Z/E/N) + per-item KRA/eTIMS classification
fields + classification-change history — now applied identically to:
- hotel/index.html
- hospital/index.html
- production/index.html
- services/index.html
- pharmacy/index.html

(water was already checked in zip 103 and confirmed architecturally different — no inv-vat-category UI exists
there, so this phase doesn't apply to it yet; water's vatRateForCategory was left as-is pending a decision on
whether to add VAT-category selection to its item model at all.)

Each module got the same set of changes root did:
- vatRateForCategory Z/E/N/legacy-C-fallback update, KRA_VAT_CATEGORY_LABELS, recordKraClassificationChange,
  defaultKraClassification, readKraClassificationFromForm, populateKraClassificationForm.
- One-time migration: existing category-C items become Z (Zero-rated) on load, logged on the item.
- Add/Edit Item form: VAT dropdown now offers A/B/Z/E/N, plus a new KRA/eTIMS Classification block (class code,
  eTIMS item code, unit code, package code, country of origin, item type) — defaults to "Not yet classified".
- Inline inventory-row edit modal dropdown updated the same way.
- saveInventoryItem wired to carry the kra block + classification history for both items and services.

tests/kra-classification.test.mjs expanded to run its 4 checks against all 6 modules (24/24 passing).
Full smoke + regressions + money test files re-run clean (31/31) across the whole suite; shared-code drift
check (`npm run check`) is clean. No router changes — deploy:router not needed.

Still open from the master spec: the "Help me classify this product" AI assistant, a single shared tax-engine
module (currently duplicated per-module, matching the app's existing per-module architecture), eTIMS submission
validation against these fields, report/receipt labels for Z/E/N, and the X/Z reports + Audit tab phases.
