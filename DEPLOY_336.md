# Deploy zip 336 - H10S built-in printer, Store/Inventory without duplicates, FIFO/FEFO batches (Pharmacy + Hospital), carton/packet/piece packaging, cost corrections and profit adjustments, HMIS Sales Counter (includes everything up to 335)

All commands are Windows cmd. Run them one at a time, in order. Each PART has a clear START and END.
Nothing here has been deployed or tried on your live Cloudflare account - the tests ran on a test copy only (results at the bottom).

What is new:
1. **Store <-> Inventory, every module:** taking 5 of 10 bags from the Store into an Inventory of 10 now gives Store 5 / Inventory 15 on the SAME item. No second item is made. When two items here could be the one meant, the transfer waits for you to pick (a yellow note in the Store tab); it is not guessed. "📤 Move stock into the Store" is now in every module, and you choose the Store line. "🩺 Store check" lists look-alike lines, stuck transfers and lines that do not add up. A manager can merge two Store lines (both histories are kept).
2. **Batches (Pharmacy and Hospital only):** every delivery is its own batch with its cost, date, supplier and invoice. A sale takes the batch that expires first (FEFO; FIFO can be chosen). Expired, quarantined and recalled batches are never sold. A sale's cost is what those batches cost. A void or return goes back into the same batches. "🧪 Batches" on each item: quarantine / recall / release (manager), record details for old stock. Stock value by batch is in the Stock Value tab.
3. **Packaging, every module:** "📦 Package sizes" on an item (for example 1 Carton = 10 Packet, 1 Packet = 20 mini-packet). Stock is always counted in the smallest unit. At the Sales Counter you choose the package (or scan its barcode). Restock has "📦 Add by carton / packet", Stock Take has "📦 Count by package", and every list shows "1 Carton + 6 Packet + 13".
4. **Cost & profit, every module (Profits & Expenses tab):** 🔎 Cost check (costs that look wrong, sales at a loss, batches with no cost). A manager can correct a cost "from now on" or "also for past sales from a date", and sees the effect before saving. ♻️ Recalculate profit. ⚖️ Profit adjustment (for example to zero) for a period, with a reason, plus its reversal. You can close the books through a date. The password is checked on the server, and every action is recorded and cannot be edited.
5. **HMIS Sales Counter:** search first, the patient bill and the cashier queue in one slim strip, compact product tiles, the cart as its own column on a tablet or computer (the totals no longer cover the cart lines), and the dose folded into one "💊 Dose" line. COMPLETE SALE shows "Completing…" while it saves.
6. **Other tabs:** on Restock the delivery form comes first and its rows have room; on Inventory the Expiry horizon is a one-line summary; summary figures show two per row on a phone.
7. **Built-in printer of the H10S handheld (Android app):** the H10S is a Senraise terminal; its printer is a system service, not Bluetooth. The Android app now has an adapter for it: Settings > Install App > "Use this terminal's built-in printer". Full evidence, limits and the on-device test list: `docs/BUILTIN_PRINTER_336.md`. **Not tried on a real H10S.** It needs a NEW Android APK (PART G).
8. **Profit names fixed:** "Gross profit (before expenses)" and "Net profit (after expenses)". The old label "Gross Profit (after expenses)" was really net profit.

Service worker version: zip-336. **New migration 0019** (new tables only). **Router deploy needed** (the sync guard for batch costs runs in the shop database too).

## PART A - START: unpack the zip
1. mkdir C:\dev\zip336
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_336.zip" -C C:\dev\zip336
## PART A - END

## PART B - START: copy into the work folder (keeps the wrangler files already pointing at your account)
3. robocopy C:\dev\zip336 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
   (robocopy exit codes 0 to 7 are success - only 8 or higher is an error)
4. cd /d C:\dev\mydukapos
5. node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6. node tools\switch-account.mjs --show
   (must print: Router forwards shop addresses to: mydukapos-3ao.pages.dev - if not, STOP)
## PART B - END

## PART C - START: check and test
7. npm install
8. npm run check
   (must say: All apps match src/shared/. then cards in sync then owner pro in sync)
9. node --test tests\zip336-stock-engine.test.mjs tests\zip336-store-transfer.test.mjs tests\zip336-cost-control.test.mjs
   (the end must say: fail 0)
10. node --test tests\zip336-stock.browser.test.mjs
   (the end must say: fail 0. Needs Playwright on your PC; without it these tests are skipped, not failed)
11. npm test
   (several minutes; end must say: fail 0 - if a test fails, STOP and send me its name. Known older failures from before zip 327: menu-import wording, zip180, zip254)
## PART C - END

## PART D - START: back up, then the database tables (new tables only, safe to repeat)
12. npm run db:backup
   (writes a copy of every table into the backup folder; wait for it to finish)
13. npx wrangler d1 execute LEDGER_DB --remote --file=migrations\0019_stock_integrity.sql
   (creates store_lots, cost_corrections, profit_adjustments, cc_settings, stock_audit. Running it again changes nothing. The app also creates them by itself on first use)
14. npx wrangler d1 migrations apply mydukapos-ledger --remote
   (your usual step; if it reports 0019 already applied or nothing to apply, that is fine)
## PART D - END

## PART E - START: deploy
15. npm run deploy:router
16. npm run deploy:fast
## PART E - END

## PART F - START: try it (on a TEST shop first)
17. Open the app once so it updates to zip-336 (close and reopen it if it still shows the old version).
18. Store tab: put 10 bags of a test item in the Store, with the same item at 10 in Inventory. "Take to My Inventory" 5: Store 5, Inventory 15, and there is still only ONE item in Inventory. Then "📤 Move stock into the Store" 3: Store 8, Inventory 12, and the Store has one line.
19. "🩺 Store check": look-alike lines and stuck transfers are listed. Nothing changes until you press a button.
20. Inventory > ✏️ an item > "📦 Package sizes": add Packet = 20 (of the base unit) and Carton = 10 (of Packet). Save (the manager password is asked). Sales Counter: tap the item, choose "Packet". Complete the sale: the stock drops by 20.
21. Pharmacy or Hospital: restock a medicine with an expiry date and a cost, twice, with different expiry dates. Sell a few: Inventory > "🧪 Batches" shows the earliest expiry used first. Quarantine a batch (manager): it can no longer be sold.
22. Profits & Expenses > "🔎 Cost check" > "Correct cost…": type the right cost, choose "Also count past sales…", read the box "Before you save", then Save (manager). The cost of goods sold changes, the sales themselves stay as they were, and it shows in "📚 History".
23. Hospital Sales Counter on a tablet: the cart stays on the right while you scroll the products, and COMPLETE SALE is always on screen.
## PART F - END

## PART G - START: the Android app for the H10S (only if you use the handheld)
24. cd /d C:\dev\mydukapos
25. git add -A
26. git commit -m "zip 336: built-in printer"
27. git push
   (the GitHub "android" workflow builds the APKs; open Actions > android > the newest run > download the artifact "mydukapos-android" and unzip it)
28. Copy the APK of the app you use (for example the Shop or Pharmacy release APK) to the terminal and install it (allow "install unknown apps" if asked).
29. On the terminal: Settings > Install App > "Use this terminal's built-in printer", then follow `docs\BUILTIN_PRINTER_336.md` (the test list at the bottom).
## PART G - END

## Test results (this zip, on the test copy)
- `npm run check`: all apps in sync. `npm run lint`: no undeclared names, every inline handler exists. `tools/audit-buttons.mjs`: passed.
- New tests: stock engine 10/10, Store transfer (real SQL) 6/6, cost control + sync guard 6/6, browser 19/19 (transfers in 6 modules, packaging in 4, FEFO checkout in Pharmacy + Hospital, cost-correction pop-up, Sales Counter and 5 tabs at 1440 / 820 / 390 px, HMIS counter).
- Built-in printer: 7/7 new tests + 9 existing native tests pass (fake Android bridge; the Android code itself was NOT compiled here - the GitHub android workflow compiles it).
- Full `npm test`: **NOT completed** (it is too slow on the build machine; stopped on request). What was run: the first 56 test files (187 ok, 0 failed) and a further 76 older files that touch the changed areas. Result of those: 2 failures - (a) `zip182 ... viewport-unit compensation` - fails the same way on the untouched zip 335, not caused by this zip; (b) `inventory-pro` "import wizard ... 'running' !== 'done'" - appeared under heavy machine load, **not re-run alone and not classified**. Please run `npm test` on your PC (step 11) and tell me any failing name.
- NOT run: anything on your live Cloudflare account, a real phone, a real printer, a real two-device offline session (simulated in the tests instead).

## Honest limits
- FIFO/FEFO is in Pharmacy and Hospital only, as agreed. The other modules keep one cost per item (the cost recorded on each sale line).
- When two tills sell the same batch while BOTH are offline, the stock figure is right, but the cost of the extra units comes from a batch that was already empty. "Store check > Batches sold more than they held" lists these.
- The Store keeps batches only for stock moved in from Pharmacy / Hospital from now on. Stock that is already in the Store has no batch on file and arrives back as "Stock before batches" (no cost).
- Sending stock straight to another branch carries no batch details (it arrives as a batch with no cost). Going through the Store does carry them.
- Package levels cannot be used on an item that has "Box & piece" or variants, or on a made-to-order / produced / combo item. The app explains this when you try. Low-stock levels stay in the smallest unit. Barcode label printing for packages is not added yet. The package barcode does work at the counter.
- A partial return goes back into the batches the sale used, last batch first. The amount already returned on that sale is taken into account.
- Cost corrections and profit adjustments need the internet, because the password is checked on the server. Selling and restocking still work offline as before.
- The FEFO/FIFO choice is kept on each device (FEFO by default). Changing it is logged.
- Hospital: a medicine leaves stock when it is paid at the Cashier, and that checkout uses FEFO. The Pharmacy "✔ Dispensed" button only records the hand-over, as before. It never changed stock.
- Aqua POS: the cost & profit tools and the layout fixes only. It has no Store, and its costs come from refill sizes and materials.

Rollback (Pages): Cloudflare dashboard -> Workers & Pages -> mydukapos-3ao -> Deployments -> previous Production deployment -> Rollback. The router: Workers -> the router worker -> Deployments -> previous -> Rollback. The new tables can stay; the previous release ignores them.
