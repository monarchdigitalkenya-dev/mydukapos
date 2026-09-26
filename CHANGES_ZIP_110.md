# Zip 110 — KRA classification assistant ported to hotel, hospital, production, services, pharmacy

Same feature delivered in root (zip 109), now applied identically to the other 5 modules that share this
Add/Edit Item form architecture (water still excluded — different item-add architecture, same gap as every
other tax-engine phase).

Each module got:
- The "🔍 Help me classify this product" button + result panel in the KRA/eTIMS section of Add/Edit Item.
- The same reference-table assistant logic (KRA_REFERENCE_RULES_BUILTIN, kraReferenceRules,
  addKraReferenceRule, matchKraReferenceRules, runKraClassificationAssistant,
  submitNewKraReferenceRule, acceptKraAssistantSuggestion) — placed right before each module's own
  readKraClassificationFromForm, same safe positioning (outside every shared function region and block)
  as every other addition this session.
- Custom reference rules an admin adds are stored per-device (`pos_kra_reference_rules`), same as root.

## Verification
- tests/kra-assistant.test.mjs expanded to run its 5 checks against all 6 modules (30/30 passing, up from
  5/5 root-only in zip 109).
- lint-globals, smoke, regressions: 21/21 clean.
- Broader regression sweep this session: kra-classification, xz-reports, audit-tab, past-sale-price-tier,
  past-hire-price-tier, money, receipts, reports-and-speed, aqua-cogs-cost-price, gas — 156 tests, zero
  failures.
- `npm run check`: clean across all 7 modules.

No router changes — deploy:router not needed.
