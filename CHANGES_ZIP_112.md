# Zip 112 — eTIMS submission validation (spec section 19), root/Shop only

## What's new
`submitSaleToEtims()` now validates before sending anything to KRA, split into two tiers:

**Hard errors (block submission):** missing item name, invalid quantity (≤0), invalid price (<0), or an
unrecognized VAT category. These would produce a genuinely broken invoice line, so the sale is marked
`validation_failed` with the specific errors stored on it (`etimsValidationErrors` — item, issue, why it
matters, how to fix), and the cashier sees a toast explaining exactly what's wrong. The eTIMS API is never
called for these — confirmed by test, not just by reading the code.

**Soft warnings (never block):** an item that hasn't been through KRA classification yet (`kra.status` is
"Not yet classified" or missing). This is real and worth knowing about, so it's stored on the sale
(`etimsClassificationWarnings`) for later review — but it does NOT stop the actual tax filing. Blocking a
live invoice from reaching KRA over an incomplete classification would be worse for compliance than filing
it with a coarser one; the classification work (assistant, manual entry) is separate and ongoing.

The sale record itself is never touched by any of this — validation only affects the eTIMS signature side
(`etimsStatus`, `etimsValidationErrors`, `etimsClassificationWarnings`); the sale, its receipt, and its stock
deduction already happened before this runs, exactly as before.

## What's still open
- Not yet ported to hotel, hospital, production, services, pharmacy (or water, which doesn't have eTIMS
  submission wired the same way).
- No dedicated UI yet to review `etimsValidationErrors`/`etimsClassificationWarnings` after the fact beyond
  the initial toast — worth surfacing in Daily Sales or the Audit tab in a follow-up.

## Verification
- tests/etims-validation.test.mjs (new, 4 tests): invalid quantity blocks submission and never calls the
  API; an unrecognized VAT category blocks submission; an unclassified item is a warning that still submits
  successfully; a fully classified item submits with zero warnings.
- lint-globals, smoke, regressions, kra-classification, kra-assistant, money, receipts, xz-reports,
  audit-tab: 91 tests, all passing.
- `npm run check`: clean.

No router changes — deploy:router not needed.
