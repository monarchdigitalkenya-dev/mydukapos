# Zip 114 — Tax engine centralized into src/shared/functions.js

## What changed
The 14 tax/KRA/eTIMS functions built up over zips 103–113 were duplicated as identical copies across root,
hotel, hospital, production, services, and pharmacy — deliberately kept OUTSIDE the shared-code sync region
at the time, to avoid the sync-wipe incidents that happened earlier in this work. Now that they're stable and
verified, they've been moved into the single canonical library (src/shared/functions.js) that
`npm run check`/`npm run sync` already governs for everything else, so future changes only need to happen
once instead of six times:

- vatRateForCategory, KRA_VAT_CATEGORY_LABELS
- recordKraClassificationChange, defaultKraClassification
- readKraClassificationFromForm, populateKraClassificationForm
- KRA_REFERENCE_RULES_BUILTIN, kraReferenceRules, addKraReferenceRule, matchKraReferenceRules,
  runKraClassificationAssistant, submitNewKraReferenceRule, acceptKraAssistantSuggestion
- validateSaleForEtims

Each module's duplicate definition was removed and its name added to that module's own
`@shared:begin names=...` list; `npm run sync` then regenerated each module's shared region from the one
library copy. Byte-for-byte identical to what was already tested — this is a refactor, not a behavior change.

**Left duplicated on purpose (out of scope for "tax engine" specifically):** the X/Z Report builders and the
Audit tab functions. Those have small per-module wiring differences already (different `bills`/persistence
patterns), and centralizing them is a separate, later piece of work — this zip only touches the tax/KRA/eTIMS
layer that was explicitly the target.

Water was not touched — it never had these functions in the first place (different item-add architecture),
so there's nothing to centralize there yet.

## Verification
Since this is a pure refactor (move code, don't change it), the test bar is: everything that passed before
must still pass identically, with the same behavior traced to the same shared source.
- tests/kra-classification.test.mjs, kra-assistant.test.mjs, etims-validation.test.mjs, lint-globals: 86
  tests, all passing.
- smoke, regressions, xz-reports, audit-tab, money, receipts, reports-and-speed, past-sale-price-tier,
  past-hire-price-tier, patient-billing: 139 tests, all passing.
- `npm run check` (shared function + block drift): clean across all 7 modules.

No router changes — deploy:router not needed.
