# Deploy zip 345 - what changed and how to put it live
Covers: (1) Hospital sales counter redesign, (2) Kenya county / sub-county / ward boxes, (3) newly registered patient ready to send on, (4) no more repeated buttons, (5) Edit feels like Add, (6) Shop IMEI / serial dropdown at the till, (7) Edit profit (set to 0) in Profits & Expenses, (8) Pharmacy + Hospital batches: move existing stock into a batch, Batch ID when restocking, remove a recalled batch, (9) Light mode that sticks, receipt preview always light, bigger text boxes.
Apps changed: Shop, Hospital (HMIS), Pharmacy, Hotel, Production, Services, Water, Owner (shared parts), server code functions/api/cost-control.js. Service worker: zip-345.
**No new database migration.** Web + functions deploy only.
All commands are Windows cmd. Run them ONE at a time, in order: paste one line, press Enter, wait for it to finish, then the next. No File Explorer needed.
Nothing here was deployed by me to your live Cloudflare account.

┌─ PART A ─ START ─ unpack ───────────────────────────────┐
1.  mkdir C:\dev\zip345
2.  tar -xf "%USERPROFILE%\Downloads\ZIPNAME.zip" -C C:\dev\zip345
    (replace ZIPNAME.zip with the exact file name of the zip I gave you)
└─ PART A ─ END ──────────────────────────────────────────┘

┌─ PART B ─ START ─ copy into the work folder and lock the CORRECT account ─┐
3.  robocopy C:\dev\zip345 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; only 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
    (must print: Router forwards shop addresses to: mydukapos-3ao.pages.dev. If not, STOP - do not deploy.)
7.  npx wrangler whoami
    (must show the Cloudflare account that owns mydukapos-3ao.pages.dev. If different: npx wrangler logout, then npx wrangler login, then run this step again.)
└─ PART B ─ END ──────────────────────────────────────────┘

┌─ PART C ─ START ─ check and test ───────────────────────┐
8.  npm install
9.  npm run check
    (must say: All apps match src/shared/, then cards in sync, then owner pro in sync)
10. node --test tests\zip345-static.test.mjs
    (the end must say: fail 0)
11. npm test
    (takes several minutes. Older known failures from earlier zips may still show. If a different test fails, STOP and send me its name.)
└─ PART C ─ END ──────────────────────────────────────────┘

┌─ PART D ─ START ─ back up the data ─────────────────────┐
12. npm run db:backup
13. npx wrangler d1 migrations apply mydukapos-ledger --remote
    ("Nothing to apply" is expected.)
└─ PART D ─ END ──────────────────────────────────────────┘

┌─ PART E ─ START ─ deploy ───────────────────────────────┐
14. npm run deploy:fast
15. npm run deploy:router
└─ PART E ─ END ──────────────────────────────────────────┘

┌─ PART F ─ START ─ check it on the LIVE site (use a TEST shop first) ─┐
16. Open each app once, then refresh once, so it updates to zip-345.
17. Hospital > Sales Counter: the cart rows are big and clear; Total, Paid, Balance are easy to read.
18. Hospital > Reception > Register: type "Nai" in County, pick Nairobi, then a Sub-county and a Ward. Register: the new patient appears under "Just registered" with a button to send to Triage.
19. Shop > Sales Counter: sell a phone that has IMEIs. A drop-down lets you pick which IMEI was sold.
20. Shop > Profits & Expenses > "Edit profit (set to 0)" or the Edit button on one item row. Check Profit shows 0. Use Edit > "Put the original profit back" to undo.
21. Pharmacy > Restock: there is a Batch ID box on each row.
22. Pharmacy > Inventory > open batches of an item > "Put stock into a batch", "Edit ID", "Remove from stock" (recall).
23. Shop > Inventory > Add New Item: tick "This item has a unique identifier per item" - a box appears to type IMEIs (one per line). Save: stock = number of IMEIs. (You only see this after deploying zip 345.)
24. Services (Car Wash): tap "+ New Task", pick Carpet or Motorbike, add a service, "+ Add staff" and choose a person, "Create Task".
25. Phone/tablet: tap Dark then Light, close the app, open it again: it stays Light. Open a receipt preview in dark mode: the paper is white.
└─ PART F ─ END ──────────────────────────────────────────┘

Beginner guide: docs/GUIDE_345.md. If anything looks wrong after deploying, tell me the step number and what the screen said.
