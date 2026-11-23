# Deploy zip 329 (replaces 328 - use this one) - Staff & HR, hospital doctor-to-cashier, customers/bills/contract issuing, sync health (includes everything up to 327)

All commands are Windows cmd. Run them one at a time, in order. Each PART has a clear START and END.
Nothing in this zip has been deployed or checked on your live Cloudflare account - the tests below ran on a test copy only.

What is new:
1. **Staff & HR** (Create Payroll): cadre, designation, supervisor, employment basis (permanent / contract / intern), full-time / part-time, end date (required for contract and intern), internship months, change history, pay lines with effective dates and optional approval, PDF-only documents, leavers, filters and alerts, salary "not entered" is different from a real 0.
2. **Weekly / monthly staff reports** - default OFF. Turn on in Create Payroll > Settings > HR settings. They run from the router cron (needs step 13).
3. **Hospital doctor -> cashier:** "Send to Cashier / Add Charge" in the consultation; the cashier queue loads the bill into the Sales Counter; a charge is PAID only by a completed sale.
4. **Customers, bills, receipts, contract stock issuance:** one profile per customer, bill details and signature fields on receipts, issue stock under a contract exactly once.
5. **Sync health:** Settings > Devices & Security > "Sync health" shows every device (waiting, needs attention, last good sync) with a safe "Retry / Reconcile" button.

Service worker version: zip-329. Database: migration `0017_hr.sql` (needs 0010 payroll applied first; the server also creates the HR tables by itself on first use, so this step is a safety net). The ROUTER must be redeployed (cron for reports).

## PART A - START: unpack the zip
1. mkdir C:\dev\zip329
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_329.zip" -C C:\dev\zip329
## PART A - END

## PART B - START: copy into the work folder (keeps the wrangler files already pointing at your account)
3. robocopy C:\dev\zip329 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
9. node --test tests\zip328-sync-matrix.test.mjs tests\zip328-hr.test.mjs tests\zip328-hospital-cashier.test.mjs tests\zip328-customers.test.mjs tests\zip328-customers-sync.test.mjs tests\zip328-perm-guard.test.mjs
   (every line must say ok, and the end must say: fail 0)
10. npm test
   (takes a long time. Known failures that also failed before this zip: menu-import "a dish without a price", zip180 "desktop display scale", zip254 "medicine list import". A few timing tests (svc-ui-boot, zip320-demo-reset) fail now and then when the computer is busy - run them again alone. Anything else failing: STOP and send me the name.)
11. npx wrangler d1 execute mydukapos-ledger --remote --file=migrations\0017_hr.sql
   (safe to run twice. If it says the payroll tables do not exist, your shop never used Create Payroll: skip this step - the server creates what it needs later.)
12. npm run deploy:fast
13. npm run deploy:router
   (needed so the cron can generate the weekly / monthly staff reports. Pages in step 12 and router in step 13 are both required.)
## PART C - END

## PART D - START: confirm (do this on a TEST shop first)
14. Open the shop once so the service worker updates to zip-329 (close and reopen once if it still shows the old version).
15. Staff: Create Payroll > Staff > Add. Choose Contract and leave End date empty: it must refuse. Enter pay 0: it saves as "0", while an empty pay shows "salary not entered".
16. Hospital: open a consultation > Send to Cashier / Add Charge. On the cashier device the queue shows it as "awaiting"; load it, pay, and the doctor's device shows "paid". Cancel one with a reason and check it disappears from the cart.
17. Sync health: Settings > Devices & Security > Sync health. Each open device appears. Turn one offline, make a sale, press Refresh: it shows "waiting"; go online and press Retry / Reconcile: it shows "Up to date".
18. Reports (optional): Create Payroll > Settings > HR settings > turn on weekly or monthly reports, press Generate now for the last complete period, open one report.

## PART D - END

## Remaining risks (honest list)
- Full test run on my side: all files ran in batches; the only failures left are the three known old ones above and two timing-sensitive files that also fail now and then in zip 327. The browser (playwright) tests were not part of that run.
- Nothing here is deployed or verified on live Cloudflare. After deploying, check Worker errors, and confirm two real devices converge (step 17).
- Server-side role checks for customers, contracts and hospital charges only work when staff sessions are in "enforce" mode, and a manager bypasses them. Otherwise the checks are in the app.
- The Owner app's contract screens were not updated.
- Contract numbers made offline on two tills can collide.
- Attendance and hours are not stored on the server, so staff reports show them as "unavailable". Per-staff sales come from the ledger's staff column.
- Hospital: part payment of a single line is not supported (the cashier removes lines from the cart); insurance / institution visits are not routed to the cashier; no payment-based blocking of clinical work was added.
- Ordinary-sale M-PESA entry without a code is still allowed (only patient-bill carts are strict).
- Two devices editing different fields of the same inventory item before syncing: newest record wins as a whole (from zip 327).
- Onfon SMS was tested against a mock only.

Rollback (Pages): Cloudflare dashboard -> Workers & Pages -> mydukapos-3ao -> Deployments -> previous Production deployment -> Rollback. Router: `wrangler rollback --config wildcard-router/wrangler.toml`. The migration only adds tables; leaving them in place is harmless.
