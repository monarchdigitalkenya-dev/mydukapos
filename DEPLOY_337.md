# Deploy zip 337 - FIX: stock moved from the Store to Inventory no longer doubles; plus everything in 336 (H10S built-in printer, FEFO batches, packaging, cost corrections, HMIS counter)

All commands are Windows cmd. Run them one at a time, in order. Each PART has a clear START and END.
Nothing here has been deployed or tried on your live Cloudflare account - the tests ran on a test copy only.

## What is new in 337
**The doubling bug (2 -> 4 -> 6).** Found and reproduced: when the Store's "received" confirmation did not reach the server and the till then forgot it had already added the transfer (a refresh, or a second device), the SAME transfer was added again each time. Now every transfer's ledger entry carries a fixed id made from the transfer itself, so this till refuses to add it twice and the server (which stores each ledger id once) can never count it twice. A second device that already added it is corrected back to the server figure when it syncs. The confirmation is also retried on the next visit, which clears the transfer.
Apps changed: all 6 that have a Store (Shop, Hotel, HMIS, Production, Pharmacy, Services). Service worker: zip-337. **No new database migration** (0019 from zip 336 is still the latest). Web deploy only; no new Android/Windows build is needed for this fix (they load the web app) - rebuild them only for the printer (PART G) or if you want fresh installers (PART H).
Already-doubled stock is NOT changed automatically: correct those items with a Stock Take (count what is on the shelf).

What zip 336 added (still included): H10S built-in printer, Store <-> Inventory without duplicate items, FEFO/FIFO batches (Pharmacy + Hospital), carton/packet/piece packaging, safe cost corrections and profit adjustments, HMIS Sales Counter, profit names.

## PART A - START: unpack the zip
1. mkdir C:\dev\zip337
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_337.zip" -C C:\dev\zip337
## PART A - END

## PART B - START: copy into the work folder (keeps the wrangler files already pointing at your account)
3. robocopy C:\dev\zip337 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
9. node --test tests\zip336-stock-engine.test.mjs tests\zip336-store-transfer.test.mjs tests\zip336-cost-control.test.mjs tests\zip336-builtin-printer.test.mjs tests\zip336-transfer-once.test.mjs
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
17. Open the app once so it updates to zip-337 (close and reopen it if it still shows the old version).
18. Store tab: put 10 bags of a test item in the Store, with the same item at 10 in Inventory. "Take to My Inventory" 5: Store 5, Inventory 15, and there is still only ONE item in Inventory. Then "📤 Move stock into the Store" 3: Store 8, Inventory 12, and the Store has one line.
19. "🩺 Store check": look-alike lines and stuck transfers are listed. Nothing changes until you press a button.
20. Inventory > ✏️ an item > "📦 Package sizes": add Packet = 20 (of the base unit) and Carton = 10 (of Packet). Save (the manager password is asked). Sales Counter: tap the item, choose "Packet". Complete the sale: the stock drops by 20.
21. Pharmacy or Hospital: restock a medicine with an expiry date and a cost, twice, with different expiry dates. Sell a few: Inventory > "🧪 Batches" shows the earliest expiry used first. Quarantine a batch (manager): it can no longer be sold.
22. Profits & Expenses > "🔎 Cost check" > "Correct cost…": type the right cost, choose "Also count past sales…", read the box "Before you save", then Save (manager). The cost of goods sold changes, the sales themselves stay as they were, and it shows in "📚 History".
23. Hospital Sales Counter on a tablet: the cart stays on the right while you scroll the products, and COMPLETE SALE is always on screen.
## PART F - END

## Try the fix (add to PART F, on a TEST shop)
- Shop: put 2 of an item in the Store, "Take to My Inventory" 2. Inventory goes up by 2 once. Refresh the page and open the Store tab: it stays the same. Check on a second device too.

## PART G - START: build the Android APK for the H10S (only if you use the handheld)
(one-time setup - skip any step already done)
22. winget install EclipseAdoptium.Temurin.17.JDK
    (close cmd and open a new one afterwards)
23. java -version
    (must say version 17)
24. Install Android Studio from developer.android.com/studio and open it once. Standard setup. Then More Actions > SDK Manager > SDK Tools > tick "Android SDK Command-line Tools" > Apply.
25. setx ANDROID_HOME "%LOCALAPPDATA%\Android\Sdk"
    (close cmd and open a new one afterwards)
26. echo sdk.dir=%LOCALAPPDATA:\=\\%\\Android\\Sdk> C:\dev\mydukapos\native\android\local.properties
27. "%ANDROID_HOME%\cmdline-tools\latest\bin\sdkmanager.bat" --licenses
    (type y to every question)
28. "%ANDROID_HOME%\cmdline-tools\latest\bin\sdkmanager.bat" "platforms;android-34" "build-tools;34.0.0"
(build)
29. cd /d C:\dev\mydukapos\native\android
30. gradlew.bat --version
    (first run downloads Gradle 8.9)
31. Build ONE app: gradlew.bat assemblePharmacyDebug   (others: assembleHmisDebug, assembleShopDebug, assembleHotelDebug, assembleProductionDebug, assembleServicesDebug, assembleAquaposDebug)
    (5 to 15 minutes; must end with BUILD SUCCESSFUL. If it says FAILED, send me the red lines - the printer code was never compiled before)
32. dir app\build\outputs\apk\pharmacy\debug\*.apk
(install on the terminal)
33. Plug the terminal in with USB, switch on USB debugging, approve the prompt on the terminal.
34. "%ANDROID_HOME%\platform-tools\adb.exe" devices
    (the terminal must show as "device")
35. "%ANDROID_HOME%\platform-tools\adb.exe" install -r app\build\outputs\apk\pharmacy\debug\app-pharmacy-debug.apk
    (use the real file name from step 32; must say Success)
(evidence about your terminal - read only)
36. "%ANDROID_HOME%\platform-tools\adb.exe" shell getprop ro.product.manufacturer
37. "%ANDROID_HOME%\platform-tools\adb.exe" shell getprop ro.product.model
38. "%ANDROID_HOME%\platform-tools\adb.exe" shell pm list packages recieptservice
    (should print package:recieptservice.com.recieptservice - if nothing, send me the outputs of 36 to 38)
39. On the terminal: Settings > Install App > "Use this terminal's built-in printer" - a test receipt should print.
40. Follow the list at the bottom of docs\BUILTIN_PRINTER_336.md
## PART G - END

## PART H - START: build the Windows installers (EXE and MSI) (optional)
(one-time setup)
41. winget install OpenJS.NodeJS.LTS
    (close cmd and open a new one afterwards)
42. node --version
    (must be 20 or higher)
(build)
43. cd /d C:\dev\mydukapos\native\windows
44. npm install
45. npm run check
46. node build.mjs pharmacy
    (one app; others: shop, hotel, hmis, production, services, aquapos, owner - or "node build.mjs" for all 8. First build 10 to 20 minutes)
47. dir dist\pharmacy
    (you should see <AppName>-1.0.0-Setup.exe and <AppName>-1.0.0.msi)
(try it)
48. Double-click the Setup EXE (or install the MSI). "Unknown publisher" is expected unless signed: More info > Run anyway.
49. Open the app, enter the shop link, check the shop loads.
50. Settings > Install App > This app's printers > choose the thermal printer > Test print.
(optional signing, only with a real code-signing certificate)
51. set CSC_LINK=C:\keys\your-certificate.pfx
52. set CSC_KEY_PASSWORD=your-certificate-password
53. node build.mjs pharmacy
## PART H - END

## Test results (this zip, on the test copy)
- NEW in 337: 2 tests reproduce your case and pass only with the fix (they fail with 6 instead of 4 without it): `tests\\zip336-transfer-once.test.mjs`. Store/transfer related tests: 49 pass, 0 fail.
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
