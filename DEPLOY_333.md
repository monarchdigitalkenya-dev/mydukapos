# Deploy zip 333 - Daily Sales payment totals (all apps) + Aqua raw-material varieties, recipes, production and restock (includes everything up to 332)

All commands are Windows cmd. Run them one at a time, in order. Each PART has a clear START and END.
Nothing here has been deployed or tried on your live Cloudflare account - the tests ran on a test copy only.

What is new:
1. **Daily Sales (every app):** a "Payments collected" panel - Cash, M-Pesa, Card, Other, Total collected; unpaid/credit and voided shown separately; Print button.
2. **Aqua Raw Materials = varieties:** each variety has its own stock, cost, SKU, category, units (1 bag = N pcs), reorder level, history. Add, edit, search, filter, restock, adjust, deactivate.
3. **Aqua recipes:** category + quantity + wastage + optional + which varieties are allowed. One variety can serve many products and one product many varieties.
4. **Aqua production + custom bale orders:** you pick the actual variety; only that one is deducted; short stock blocks; costs are frozen on each run; a custom order cannot be fulfilled twice; Admin can reverse a run.
5. **Aqua restock:** audited receipts with unit conversion, weighted-average cost, supplier, credit (not paid) handling.
6. **Server:** matMovements, productionLog and restockLog now merge by id.

Service worker version: zip-333. No new database migration. Only Pages needs deploying (no router deploy).
Not in this zip yet: the shared Record Purchase screen and Purchases report for all apps (planned for the next zip).

## PART A - START: unpack the zip
1. mkdir C:\dev\zip333
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_333.zip" -C C:\dev\zip333
## PART A - END

## PART B - START: copy into the work folder (keeps the wrangler files already pointing at your account)
3. robocopy C:\dev\zip333 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
   (robocopy exit codes 0 to 7 are success - only 8 or higher is an error)
4. cd /d C:\dev\mydukapos
5. node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6. node tools\switch-account.mjs --show
   (must print: Router forwards shop addresses to: mydukapos-3ao.pages.dev - if not, STOP)
## PART B - END

## PART C - START: check, test and deploy
7. npm install
8. npm run check
   (must say: All apps match src/shared/. then cards in sync then owner pro in sync)
9. node --test tests\zip333-sales-payments.test.mjs tests\zip333-aqua-materials.test.mjs tests\zip333-aqua-materials.browser.test.mjs
   (the end must say: fail 0)
10. npm test
   (several minutes; end must say: fail 0 - if a test fails, STOP and send me its name. Known older failures from before zip 327: menu-import wording, zip180, zip254)
11. npm run deploy:fast
## PART C - END

## PART D - START: use it (try on a TEST shop first)
12. Open the app once so it updates to zip-333 (close and reopen if it still shows the old version).
13. Any app > Daily Sales: the "Payments collected" panel is above the list. Press Print to check the paper copy.
14. Aqua > switch to Production > Raw Materials. Your old materials are still there with their stock. Any marked "check category": open Edit and choose the right category.
15. Add two bottle varieties (e.g. Hex 500ml, Round 500ml) with opening stock. Open "Products" on each and tick the products it can be used in.
16. Inventory > the product > Recipe: set the quantity per unit for Bottle, Cap, etc. and tick the allowed varieties.
17. Production tab > Produce: choose the bottle variety used; confirm. Check that only that variety dropped, and see it in the variety's History.
18. Raw Materials > Restock a variety in bags: the preview shows the conversion (2 bag = 100 pcs) and the new average cost. Try "On credit" - it records the amount owed, not paid.
## PART D - END

## Honest limits
- Not tried on a live phone or on live Cloudflare - only in test copies (including a phone-size test browser). Test on one device first.
- Stock is kept on the device and synced; the server applies each change once through the existing stock ledger and never goes below zero, but this is not a database transaction. Two devices using the last units at the same moment: the second is clamped at zero and you will see it in History.
- A custom bale order is guarded against double submit and carries an order reference; there is no separate customer-orders list to link to yet.
- The sale-time automatic deduction for a sold product still uses the recipe's default variety (the first allowed one), as before; production-time picking is exact.
- The old per-material "selling price" field is kept on existing records but is not shown on the new edit screen.
- Unit conversions are only what you set per variety (bag, bale, case...). A unit with no conversion is refused - nothing is assumed.
- Purchases report and the shared Record Purchase screen: not in this zip.

Rollback (Pages): Cloudflare dashboard -> Workers & Pages -> mydukapos-3ao -> Deployments -> previous Production deployment -> Rollback.
