# Deploy zip 346 - import a stock list with boxes / packets / pieces, and count stock at each level
Covers: (1) NEW "📥 Import boxes & packets (Excel)" button in Inventory: reads your Stock_List.xlsx (or the blank template) and creates every item with its box > packet > piece levels; (2) Stock Take now has one box per level (full boxes, loose packets, loose pieces) that are added up for you; (3) selling by box / packet / piece at the Sales Counter already exists and now works straight after an import. Also still included from zip 345: IMEI box, Car Wash tasks, hospital and batch fixes.
Apps changed: Shop, Hospital (HMIS), Pharmacy, Hotel, Production, Services, Water (shared parts). Service worker: zip-346.
**No new database migration.** Web + functions deploy only.
All commands are Windows cmd. Run them ONE at a time, in order: paste one line, press Enter, wait for it to finish, then the next. No File Explorer needed.
Nothing here was deployed by me to your live Cloudflare account.

┌─ PART A ─ START ─ unpack ───────────────────────────────┐
1.  mkdir C:\dev\zip346
2.  tar -xf "%USERPROFILE%\Downloads\ZIPNAME.zip" -C C:\dev\zip346
    (replace ZIPNAME.zip with the exact file name of the zip I gave you)
└─ PART A ─ END ──────────────────────────────────────────┘

┌─ PART B ─ START ─ copy into the work folder and lock the CORRECT account ─┐
3.  robocopy C:\dev\zip346 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
10. node --test tests\zip346-static.test.mjs
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
16. Open the Shop once, then refresh once, so it updates to zip-346.
17. Inventory (list): above the search box tap "📥 Import boxes & packets (Excel)".
18. Choose Stock_List_ready_to_import.xlsx (or your original Stock_List.xlsx). Yellow rows are missing a box or packet size: type it in, or tick the row off, or use "Fill empty box sizes".
19. Tap "Import now". Find "KSL Sweets Assorted": Inventory shows it with Packet = 100 and Box = 1200 sweets.
20. Sales Counter: search that item and tap it. A chooser appears: 1 sweet, 1 Packet, 1 Box. Pick one, finish the sale, check the stock went down by 1 / 100 / 1200 sweets.
21. Stock Take: search the item. You see boxes like "Boxes (1200)", "Packets (100)", "Loose sweet". Type how many of each you counted; the total shows under them. Press "Update stock".
22. Stock Take > "count matches" fills the three boxes from the system stock.
└─ PART F ─ END ──────────────────────────────────────────┘

Beginner guide: docs/GUIDE_346.md. The ready-to-fill version of your list: Stock_List_ready_to_import.xlsx (in the zip, folder templates). If anything looks wrong after deploying, tell me the step number and what the screen said.
