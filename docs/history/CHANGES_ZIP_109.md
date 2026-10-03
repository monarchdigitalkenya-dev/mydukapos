# Zip 109 — KRA classification assistant (spec section 14), root/Shop only

## What's new
A "🔍 Help me classify this product" button in the Add/Edit Item form's KRA/eTIMS section.

**Important honesty note, and why it's built this way:** this app has no live KRA API to query, and the spec
is explicit that a class/eTIMS code must never be invented. So this assistant only ever suggests the
**VAT rate category** (Standard 16% / Reduced 8% / Zero-rated / Exempt / Non-VAT) from a small, keyword-based
reference table — it never touches the KRA class code or eTIMS item code fields, and never labels anything
"CONFIRMED MATCH" (nothing here is an authoritative source). Every suggestion:
- Shows which keywords it matched on and a plain-language reason.
- Requires an explicit tap ("Use this classification") — never auto-applies.
- If several categories are equally likely, shows all of them rather than silently picking one.
- If nothing matches, says so plainly ("NO MATCH FOUND — manual classification required") and offers to save
  a new rule for next time, instead of guessing.

**The reference table is the "updateable KRA classification data layer" the spec asks for when no live API is
available** (section 16): a small built-in starter set of genuinely well-known treatment categories (basic
unprocessed foodstuffs, pharmaceuticals, LPG, medical equipment, financial/insurance services, educational
materials, exports, fuel) — each explicitly labelled as something to verify with an accountant, not a verified
live feed — plus any rules an admin adds, stored locally and reused for future items.

## What's still open
- Not yet ported to the other 5 modules (hotel, hospital, production, services, pharmacy) or water.
- Accepting a suggestion on a brand-new item isn't yet logged to classification history (nothing to log a
  "change" against yet, since it's a new item) — but accepting one while editing an EXISTING item, through
  this same Add/Edit form (as opposed to the inline table-row editor), doesn't currently get recorded in
  kraClassificationHistory either. Worth tightening in a follow-up.
- No UI yet to review/edit/remove a saved custom reference rule once added (only adding is exposed).

## Verification
- tests/kra-assistant.test.mjs (new, 5 tests): single suggested match, accept-only-sets-VAT-category (never
  invents codes), no-match handling, a saved custom rule persists and gets matched later, and two equally
  likely categories are both surfaced rather than one being silently chosen.
- lint-globals, smoke, regressions, kra-classification, money, receipts, xz-reports, audit-tab: 91 tests,
  all passing.
- `npm run check`: clean.

No router changes — deploy:router not needed.
