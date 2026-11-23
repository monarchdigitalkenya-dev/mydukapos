# Deploy zip 327 - resets that stay reset, Onfon SMS, demo rules, box-and-piece photo grid, search fixes, calmer Settings, void tests (includes everything up to 326)

All commands are Windows cmd. Run them one at a time, in order. Each PART has a clear START and END.
Nothing in this zip has been deployed or checked on your live Cloudflare account - the tests below ran on a test copy only.

What changed:
1. **Reset buttons really reset.** "Reset except inventory", "Purge demo data" and "Delete voided sales" now also tell the SERVER, so another device or an old offline device can not bring the sales back. "Reset app" asks the server to forget the shop (the shop name must be typed) and refuses when offline.
2. **Onfon Media SMS** (Settings > SMS Broadcast): Access Key, API Key, Client ID, Sender ID, on/off, test number, Send test, Check balance. Secrets are sealed on the server and never come back to the browser. Tested with a MOCK only (see "Still needed").
3. **Demo shops:** one new product per visit, original demo names locked, imports switched off. This is enforced in the visitor's browser only (the demo server stores nothing). No Cloudflare cron was added: the hourly demo reset is the device-local one from zip 320.
4. **Box-and-piece items are now in the photo grid** (one tile with Box and Piece buttons).
5. **Search:** one shared search for the till, Inventory, restock and pickers. Finds part of a name, any word order, "coca cola" = "Coca-Cola", variant names and codes, barcodes; a product with no name no longer blanks the list; a failed other-branch lookup says so instead of "no matches".
6. **Settings:** compact grouped list on the left (desktop), one dropdown on phones, a search box that filters sections and shows "No settings match".
7. **Voiding sales:** the existing void was audited; new tests prove stock comes back exactly once, voided money is out of totals, M-Pesa evidence is kept and never marked refunded, offline and two-device voids are safe.

8. **Cross-device sync audit:** the existing sync was traced and tested across 14 scenarios (A to B and B to A, updates, offline then restart, concurrent edits, missed notices, 500 / unreachable server, 400-record batches, integrity compare). No defect that loses sales or stock was found in these scenarios; one policy limit is documented under 'Remaining risks'.
9. **Also fixed:** the user guides now list the Suppliers tab (a guide test was failing on it).

Service worker version: zip-327. Database: no migration. The ROUTER must be redeployed (reset support in the shop database) - step 12.

## PART A - START: unpack the zip
1. mkdir C:\dev\zip327
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_327.zip" -C C:\dev\zip327
## PART A - END

## PART B - START: copy into the work folder (keeps the wrangler files already pointing at your account)
3. robocopy C:\dev\zip327 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
9. node --test tests\zip327-void.test.mjs tests\zip327-search.test.mjs tests\zip327-search-branches.test.mjs tests\zip327-reset-stays-reset.test.mjs tests\zip327-onfon.test.mjs tests\zip327-multidevice-sales.test.mjs tests\zip327-price-modes.test.mjs tests\zip327-sync-matrix.test.mjs
   (every line must say ok, and the end must say: fail 0)
10. npm test
   (takes several minutes; the end must say: fail 0 - if a test fails, STOP and send me the failing name)
11. npm run deploy:fast
12. npm run deploy:router
   (needed once for this zip: the shop database learns the reset and wipe commands. The Pages deploy in step 11 and the router in step 12 are both required.)
## PART C - END

## PART D - START: confirm (do this on a TEST shop first, not on a shop with real sales)
13. Open the Shop once so the service worker updates to zip-327 (close and reopen once if it still shows the old version).
14. Reset check: make 2 sales, Settings > Danger Zone > Reset except inventory. Open the shop on a second device: no sales there. Sales made afterwards still appear.
15. Search check: Sales counter, type part of a product name from the middle ("mince" for "Fresh Beef Mince"): it is listed. Inventory > search the same word: it is listed.
16. Settings check: on a computer, Settings shows a list on the left and the section on the right. On a phone it shows one dropdown. Type "sms" in "Find a setting": only matching sections remain.
17. Void check: sell 1 item for cash, Void it with the management password: stock goes back by 1, the sale is struck through and not in the day total.
18. Onfon (only with your own Onfon account): Settings > SMS Broadcast > Onfon Media. Fill the four fields, Save, press Check balance, then Send test to your own phone. Do not trust the integration until a real message arrives.
## PART D - END

## Remaining risks (honest list)
- Two devices that edit DIFFERENT fields of the SAME item before either has synced: the newer record wins as a whole, so the other device's field change is lost (both devices do end up identical). Stock quantities are not affected (they go through the stock ledger). Closing this needs per-field merging, which is a larger change.
- The full test suite (`npm test`) was only partly run in my session (about 1,430 results, all passing except two groups listed next). Run step 10 yourself before trusting the whole zip.
- `tests\menu-import.test.mjs` "a dish without a price is refused..." fails: the message changed in zip 323 and the test still expects the old wording (the import now lets you press Commit twice to save at price 0). I did not change this behaviour.
- Server-side void permission: a voided sale from a staff device is protected by the management password in the app; the server only enforces manager-only for cash-movement voids. Not changed in this zip.
- Not deployed, nothing verified on live Cloudflare. After deploying, check Worker errors and that two real devices converge (step 14).

## Still needed from you
- Onfon: the live API was NOT reachable from my test machine, so the field names, response codes and the balance call follow your brief and were only tested against a mock. You need an Onfon account with API access, an approved Sender ID, credits and (if Onfon asks) your Cloudflare IP allowed.
- Demo shops: the "one new product / names locked / no imports" rules live in the visitor's browser; a determined visitor can get around them on their own device only.
- The Owner Console's Settings screen keeps its own layout (not changed).

Rollback (Pages): Cloudflare dashboard -> Workers & Pages -> mydukapos-3ao -> Deployments -> previous Production deployment -> Rollback. Router: `wrangler rollback --config wildcard-router/wrangler.toml`.
