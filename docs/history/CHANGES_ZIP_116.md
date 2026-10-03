# Zip 116 — Water/Aqua POS: KRA/eTIMS classification, assistant & submission validation

## Context

This picks up water-module parity work that was left open at the end of zip 115: water
(Aqua POS) never got the per-item KRA/eTIMS classification fields, the classification
assistant, or eTIMS submission validation that the other six POS modules (Shop, Hotel,
Hospital, Production, Services, Pharmacy) already have. This zip closes that gap for
those three pieces. X Report/Z Report and the Audit tab for water are **not** in this
zip — see "What's still open" below.

## Root cause

Water uses a materially different architecture from every other module:
- Its own `products` catalogue array (not `inventory`).
- Its own Add/Edit Item field ids (`product-*` / `edit-product-*`, not the shared
  `inv-*` ids every other module's Add/Edit Item form uses).
- No unified Reports tab, `reportBuildSales`/`reportsGenerate`/`reportsPrint` system —
  Daily Sales, Stock Report, Profits, Demand Trends are each their own bespoke tab.

The shared-function sync mechanism (`src/shared/functions.js` + each module's
`@shared:begin names=...` region) only works unmodified when a module's DOM ids and
data arrays match what the shared function body hard-codes. Water's don't, for the
KRA-assistant UI functions and the eTIMS validator, so those needed water-specific
versions rather than a blind add to its shared names list — attempting to add them
as-is would have thrown `ReferenceError: inventory is not defined` (validateSaleForEtims)
or silently written into the wrong, non-existent DOM elements (the assistant functions,
hard-coded to `inv-*` ids).

## What changed

**Per-item KRA/eTIMS classification (water/index.html)**
- New products now get `kra: defaultKraClassification()` on creation (`saveProduct()`).
- The Edit Item modal gained a "🧾 KRA / eTIMS Classification" section (class code,
  eTIMS item code, unit code, package code, country of origin, item type — all optional,
  all default to "Not yet classified", never invented).
- `openEditProductModal()` / `saveProductEditModal()` now populate/read this block via
  water-specific `populateKraClassificationForm()` / `readKraClassificationFromForm()`
  (same names and behaviour as every other module, wired to water's own
  `edit-product-kra-*` ids and `products` array). Status only becomes "Confirmed" once
  both a class code and an eTIMS code are entered by a person; every change is logged
  to `product.kraClassificationHistory` via the shared `recordKraClassificationChange`.
- The data-only pieces — `KRA_VAT_CATEGORY_LABELS`, `defaultKraClassification`,
  `recordKraClassificationChange`, `KRA_REFERENCE_RULES_BUILTIN`, `kraReferenceRules`,
  `addKraReferenceRule`, `matchKraReferenceRules` — are pulled in from the shared
  library like every other module (added to water's `@shared:begin` names list), so
  water's reference-rule table is the same one every module reads/writes.

**Classification assistant**
- "🔍 Help me classify this product" button added next to the KRA section, wired to a
  water-specific `runKraClassificationAssistant()` (reads `edit-product-name-input`,
  writes to `edit-product-kra-assist-result`). Same behaviour as every other module:
  suggests a VAT **category** only from the shared, editable keyword-reference table,
  never a KRA class code or eTIMS item code — those still require a person. No match →
  lets the admin save a new reference rule on the spot (`submitNewKraReferenceRule`).
  Accepting a suggestion (`acceptKraAssistantSuggestion`) only ever sets
  `edit-product-vat-select`.

**eTIMS submission validation**
- Water's real submission function, `submitSaleToEtimsIfEnabled()`, previously
  submitted every paid sale to `/api/etims-submit` with **no validation at all**. It now
  calls a water-specific `validateSaleForEtims(sale)` first (identical logic to the
  other modules', but looking items up in `products` instead of `inventory`):
  - **Blocks** submission (sets `sale.etimsStatus = 'validation_failed'`,
    `sale.etimsValidationErrors`) for a missing item name, invalid qty/price, or an
    unrecognized VAT category — with a toast naming the item, the issue, and the fix.
  - **Warns** (never blocks) when an item hasn't been KRA-classified yet — filing a real
    invoice for KRA to later cross-check is worse than filing it with a visible gap.

**Shared library fix (benefits every module, not just water)**
- `recordKraClassificationChange()` attributed every manual classification change to
  `currentStaffName` — a global that is **never actually declared anywhere in the
  codebase** (checked: not in root, not in hotel, not anywhere), so every "who changed
  this" entry silently fell back to the generic `'admin'`. Fixed to use the same
  `activeServerName()` helper every other classification/audit-adjacent action already
  uses for "who is currently serving" attribution. Fixed once in
  `src/shared/functions.js` and synced everywhere — index.html, hotel, hospital,
  production, services, pharmacy, and water all now attribute classification changes to
  the actual logged-in user/staff member.

## What was verified

- `npm run check` — clean, no shared-code drift, for all 7 modules.
- Every `<script>` block in `water/index.html` parses (`new Function(...)`) with no
  syntax errors.
- **Full test suite: 998/998 passing, 0 failures** (94 test files, run in 12 batches).
  This includes 7 new tests added to `tests/water-vat-category.test.mjs`:
  1. A product with no `kra` block defaults to "Not yet classified" — never invented.
  2. `saveProduct()` gives every newly-created product a "Not yet classified" KRA block.
  3. The Edit Item modal only marks status "Confirmed" once both codes are entered, logs
     the change to `kraClassificationHistory`, and correctly repopulates on reopen.
  4. The assistant suggests a category for a recognized item and never fills in a class
     or eTIMS code on its own.
  5. The assistant finds no match for an unrecognized item, and a newly-saved reference
     rule is picked up on the very next run.
  6. `validateSaleForEtims` blocks a structurally-broken line (missing name, bad qty,
     bad price, unknown VAT category) but never blocks merely for an unconfirmed KRA
     classification (warning only).
  7. `submitSaleToEtimsIfEnabled` sets `validation_failed` and **never calls the eTIMS
     API** for a structurally-broken sale.

## What's still open (not in this zip)

- **X Report / Z Report for water.** Every other module builds these from its own
  `reportBuildXReport`/`reportBuildZReport`/`posControlReportTotals` functions layered
  on top of the shared `reportBuildSales`/`reportsGenerate` system, which water doesn't
  have — water's Daily Sales is its own bespoke `buildDailySalesReportData()`. Building
  this correctly (X/Z must always agree with Daily Sales — single authoritative source)
  needs its own water-specific implementation reusing that function, plus the Z
  finalization gate wired into water's own `resolveAdminPwModalSuccess()` dispatcher
  (add a `'finalize-z-report'` case there). Scoped out of this zip to keep this delivery
  focused and fully tested rather than rushed.
- **Audit tab for water.** Same reasoning — needs a water-specific read model over
  `adminActivityLog`, `stockMovementLog`, `salesLog`, and each product's
  `kraClassificationHistory`, plus its own tab/nav entry (water has no shared
  Reports-tab block to hook into).
- Everything else already listed as open at the end of zip 115 (systematic UI-reliability
  sweep, generalized wholesale-tier/unit-conversion engines, performance/Cloudflare-cache
  audit, and the consolidated Final Report) remains open.

## Deploy steps

```
mkdir C:\dev\zip116
tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_116.zip" -C C:\dev\zip116
cd /d C:\dev\mydukapos
robocopy C:\dev\zip116 C:\dev\mydukapos /MIR /XD .git node_modules /XF package-lock.json wrangler.staging.toml
npm install --no-audit --no-fund
npm run check
npm test
npm run deploy:router (skip if zips 50-115 are already live)
npm run deploy
git add -A
git commit -m "Zip 116: water KRA/eTIMS classification, assistant, submission validation"
git push
```
