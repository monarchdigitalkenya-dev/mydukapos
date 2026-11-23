# Deploy zip 335 - Staff tab popup (names list, everything in one popup, add staff on the tab) + reliability fixes (includes everything up to 334)

All commands are Windows cmd. Run them one at a time, in order. Each PART has a clear START and END.
Nothing here has been deployed or tried on your live Cloudflare account - the tests ran on a test copy only.

What is new:
1. **Staff tab = a list of names.** Tap a name: ONE popup with Personal (registration numbers), Employment, Login & access, Roles & branches, Salary & deductions, Documents, Payroll history, Reports, Change history, and "Download staff info (PDF)". You are no longer sent to the Payroll tab.
2. **Add staff is on the Staff tab**, not Settings: a person who will sign in to the POS (name, tabs, manager, invite link) or a staff record only (details, numbers, documents, pay).
3. **Reliability, no extra cost:** no full push of the shop's data on every focus/reconnect when nothing is waiting; every API call that had no time limit now stops waiting after 25 s; refresh retries are spread per device; the print relay no longer writes to storage for empty polls (the largest idle write source).

Service worker version: zip-335. No new migration. Pages only (no router deploy needed).
Included from zip 334: registration numbers, 1.5 MB documents, staff info download. From zip 333: Daily Sales payment totals and Aqua raw-material varieties.

## PART A - START: unpack the zip
1. mkdir C:\dev\zip335
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_335.zip" -C C:\dev\zip335
## PART A - END

## PART B - START: copy into the work folder (keeps the wrangler files already pointing at your account)
3. robocopy C:\dev\zip335 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
9. node --test tests\zip335-reliability.test.mjs tests\zip335-staff-popup.browser.test.mjs tests\zip334-staff-details.browser.test.mjs tests\zip332-staff-hub.browser.test.mjs
   (the end must say: fail 0)
10. npm test
   (several minutes; end must say: fail 0 - if a test fails, STOP and send me its name. Known older failures from before zip 327: menu-import wording, zip180, zip254)
11. npm run deploy:fast
## PART C - END

## PART D - START: use it (try on a TEST shop first)
12. Open the app once so it updates to zip-335 (close and reopen if it still shows the old version).
13. Open the Staff tab: you see only a search box, "Add staff", and the names. Tap a name: the popup opens. Look through Personal (registration numbers), Documents, Salary & deductions, and (for people who sign in) Login & access. Press "Back to the staff list" or X to close.
14. Press "Add staff" > "Someone who will sign in to the POS": type the name, tick their tabs, Generate Invite Link, send it. After they set a PIN they appear in the list.
15. Press "Add staff" > "A staff record only": fill what you know, add numbers, Save, then add documents.
16. Settings > Staff Accounts no longer holds the invite form (it now lives on the Staff tab).
## PART D - END

## Honest limits
- Not tried on a live phone or on live Cloudflare - only in a phone-size test browser.
- Payroll runs, bulk payroll and payslips stay in the Payroll tab (they are not about one person). The Staff tab has a button to them.
- "Login & access" shows the app's existing roster card for that person (a copy of it); changes made there work as before.
- A person who signs in but has no payroll record yet is added to the payroll register automatically the first time someone with staff rights opens the Staff tab (existing behaviour); people without payroll rights only get the Login & access card.
- The 25 s limit counts until the server starts answering; a very slow download of the answer itself is not cut. Uploads, backups, exports and the live socket have no 25 s limit.
- Not done in this zip (from the speed report): the server-side one-query-per-list speed-up, row caps on big tables, the in-app performance log, and sending only changed records. The audit log in the ledger database (about 735,000 rows in 13 days) is a financial trail and was left alone; shrinking it needs a decision from you.

Rollback (Pages): Cloudflare dashboard -> Workers & Pages -> mydukapos-3ao -> Deployments -> previous Production deployment -> Rollback.
