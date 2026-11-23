# Deploy zip 339 - everything from this chat
Covers: (1) variants from Store add to the SAME item (no 2 -> 4 -> 6), (2) Store looks like Inventory with Move + Store stock valuation, (3) Settings categories add / rename / delete, (4) Hotel public "Order from home" QR, (5) HMIS professional redesign (cashier payment summary, sectioned reception form, design layer), (6) test fix (merge list), (7) Hotel phone layout.
Apps changed: Shop, Hotel, Hospital (HMIS), Pharmacy, Production, Services, Water (shared parts), the order page and the QR server code (functions/api/qr-order.js, _ratelimit.js). Service worker: zip-339.
**No new database migration** (the public QR uses the existing qr_locations table). Web + functions deploy only.
All commands are Windows cmd. Run them ONE at a time, in order: paste one line, press Enter, wait for it to finish, then the next.
Nothing here was deployed by me to your live Cloudflare account.

┌─ PART A ─ START ─ unpack ───────────────────────────────┐
1.  mkdir C:\dev\zip339
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_project_339_final.zip" -C C:\dev\zip339
└─ PART A ─ END ──────────────────────────────────────────┘

┌─ PART B ─ START ─ copy into the work folder and lock the CORRECT account ─┐
3.  robocopy C:\dev\zip339 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; only 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
    (must print: Router forwards shop addresses to: mydukapos-3ao.pages.dev. If not, STOP - do not deploy.)
7.  npx wrangler whoami
    (must show the Cloudflare account that owns mydukapos-3ao.pages.dev. If it shows a different account, run: npx wrangler logout, then npx wrangler login, sign in with the right account, and run this step again. STOP until it is right.)
└─ PART B ─ END ──────────────────────────────────────────┘

┌─ PART C ─ START ─ check and test ───────────────────────┐
8.  npm install
9.  npm run check
    (must say: All apps match src/shared/, then cards in sync, then owner pro in sync)
10. node --test tests\zip338-online-qr.test.mjs tests\qr-d1-flow.test.mjs tests\e2e-revert.test.mjs
    (the end must say: fail 0)
11. node --test tests\zip338-variant-return.browser.test.mjs tests\zip338-categories.browser.test.mjs tests\zip338-online-qr.browser.test.mjs tests\store-pro-301.browser.test.mjs tests\zip190-category-tiles.browser.test.mjs
    (the end must say: fail 0. Needs Playwright on your PC; without it these are skipped, not failed)
12. node --test tests\zip338-hmis-ui.browser.test.mjs tests\zip339-hotel-mobile.browser.test.mjs tests\hmis-patient-flow.test.mjs tests\hmis-pipeline.test.mjs tests\zip259-hmis.test.mjs
    (the end must say: fail 0)
13. npm test
    (takes several minutes. I could only run part of the full suite on my test copy, so run all of it here.
     Older failures you listed before - menu-import wording, zip180, zip254, and "Admin runs payroll end to end" in zip216-payroll.browser for index.html and water - may still show; they are not from this zip.
     A timing test (for example zip159 "perf") can fail when the PC is busy: close other programs and run that one file alone with: node --test tests\zip159-hotel-categories.test.mjs
     If any other test fails, STOP and send me its name.)
└─ PART C ─ END ──────────────────────────────────────────┘

┌─ PART D ─ START ─ back up the data, then the database step ─┐
14. npm run db:backup
    (writes a copy of every table into the backup folder; wait for it to finish)
15. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (your usual step. "Nothing to apply" is the expected answer - this zip adds no migration.)
└─ PART D ─ END ──────────────────────────────────────────┘

┌─ PART E ─ START ─ deploy (to the account checked in step 7) ─┐
16. npm run deploy:fast
    (checks, then publishes the apps and the server functions to mydukapos-3ao.pages.dev)
17. npm run deploy:router
    (re-sends the address router to the same account; safe to repeat. Skip it only if you never changed the router.)
└─ PART E ─ END ──────────────────────────────────────────┘

┌─ PART F ─ START ─ check it on the LIVE site (use a TEST shop first) ─┐
18. Open each app once so it updates to zip-339 (close and reopen it if it still shows the old version).
19. Variants: Store tab > put an item with sizes in the Store > "Move" 2 of one size. In Inventory that size goes up by 2 and no new item appears. Move 2 more: +2 again (not 4, 6...). Old extra items: Store tab > Store check > "Extra items that belong to a size" > Merge.
20. Store tab: same layout as Inventory, "Move" instead of "Take", and the Store Stock Valuation panel on top.
21. Settings > Category Images & Order: Add category, Rename one, Delete one. Check the items in Inventory.
22. Hotel: Settings > QR ordering > "Make the public QR" > print on receipts. Print a test receipt, scan it with a phone, add food, fill name, phone, address, Send. The order shows in Service Orders; press Claim.
23. Hospital (HMIS) Cashier / Counter: add items, check the Total due / Paid / Balance / Change strip, complete a test sale. Reception: the Register New Patient form has sections.
24. Hotel on your phone: open Bar, Hotel/Rooms, Facilities, Inventory - every form is one column, nothing runs off the screen.
└─ PART F ─ END ──────────────────────────────────────────┘

Beginner guide: docs/GUIDE_338.md. If anything looks wrong after deploying, tell me the step number and what the screen said.
