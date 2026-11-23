# Zip 365 - Aqua POS stock per bottle, client bottles, paste stock balances; plus everything in zip 364, 363, 362, 361 / 360 / 359 / 358

Contains everything from zip 364 (tile menu, Aqua one-button Edit), zip 363 (car wash typing / mobile), zip 362 (price list, printables, customers, staff tabs), zip 361 (Car Wash app), 360, 359, 358, 357 and 356. If you skipped any of them, this one deploys them too.

## What is new
- **Aqua POS - stock per bottle:** Grip, Aqua clear, Aqua blue... each have their own stock on the Sales Counter, Inventory, Stock Take and Price List.
- **Client bottles** (e.g. Jays Hexa, Bistro Hexa): counted, but not on the Sales Counter or Price List.
- **Production > 📋 Paste stock balances:** paste your balances list as you type it; check the preview; Save sets each bottle's stock.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip365
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_aqua-bottlestock_365_11092105.zip" -C C:\dev\zip365

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip365 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - remove the retired apps from your folder (safe: none of these are in this release)
8.  if exist C:\dev\mydukapos\chama rmdir /s /q C:\dev\mydukapos\chama
9.  if exist C:\dev\mydukapos\crm rmdir /s /q C:\dev\mydukapos\crm
10. if exist C:\dev\mydukapos\school rmdir /s /q C:\dev\mydukapos\school

PART D - check and test
11. npm install
12. npm run check
13. node --test --test-concurrency=1 tests\zip365-aqua-bottles.test.mjs tests\zip364-tiles-aqua-edit.test.mjs
    (the end must say: fail 0 - takes a few minutes)
14. node --test tests\zip361-carwash.test.mjs
    (the end must say: fail 0)

PART E - back up, database, deploy
15. npm run db:backup
16. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
17. npm run deploy:router
18. npm run deploy:fast
    (it prints "Old files from earlier releases left out of the upload" - expected)

PART F - after deploy
19. Each device: hard-refresh once (Ctrl+F5); installed apps update on their next start.
20. Aqua POS: switch to 🏭 Production at the top, open Production, tap **📋 Paste balances**, paste your list, tap **👀 Read and check**.
21. In the preview check each line: the bottle, the client (Jays, Bistro) and the number. Leave the "full balance" box ticked, then **💾 Save balances**.
22. Sales Counter: each bottle shows with its own stock; Jays Hexa and Bistro Hexa do not. Set prices for any new size (e.g. 1500ml) in Inventory.
23. Next production: pick the bottle as usual - the bales go to that bottle's stock.
