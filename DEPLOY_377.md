# Zip 377 - Bug-check release + APKs 1.2.0

## What changed in this zip (374 - 377)
1. Delivery guard (orders/bills must keep arriving): checks every 10 s whether this device really heard from the server; forces a catch-up, reopens a dead connection, re-sends stuck changes, keeps the screen on, and shows a red bar + beep if it still cannot. Bug-check fix: it now counts only answered pulls and real socket messages (not pushes), and the Retry button also revives permanently refused records.
2. Receipt printing prints the RECEIPT from its own hidden document, never the Sales Counter page.
3. Cash surplus is added and cash shortage subtracted under profit, then Final profit (Profits tab, printed Profit Report, Expenses & Profit).
4. Customer order page uses your business name and neutral words.
5. Native version 1.2.0 (code 3) so the APKs install as an update.

## Bug check results (honest)
All 518 test files cannot run in this environment (each browser test takes 15-60 s). I ran 55 of them covering everything touched plus sync, printing, login/tabs, checkout, bills, kitchen, orders, cash, reports, owner: all tests passed except two OLD failures that also fail on zip 368 and are unrelated to this work: (a) orders: an out-of-date expectation about hospital stock lots (updated); (b) first-run: Hospital inventory empty-state card (not changed). Several large suites finish slowly here (receipt-size, cash-drawer, orders) but every individual test in them passed. Syntax check of every script in all 9 apps: 0 errors. Not tested on real devices, printers or APKs.
Known limit found while checking: when a device's own change cannot be sent, the app deliberately does not apply other devices' changes until it can (to avoid overwriting your edit). The guard retries, and shows a red bar if it stays stuck.

## Check it
- Close a cash session with a difference (e.g. counted 300 over), then open Profits for that day: the box shows Cash surplus 300.00 and Final profit = Net profit + 300.
- Open your order link on a phone, add an item, open Your order: it says your shop name, no "restaurant".

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip376
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_bugcheck-apk_377_11171110.zip" -C C:\dev\zip376

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip376 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - check and test
8.  npm install
9.  npm run check
    (it must say: All apps match src/shared/)
10. node --test --test-concurrency=1 tests\zip374-delivery-guard.test.mjs
    (the end must say: fail 0)

PART D - back up, database, deploy
11. npm run db:backup
12. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
13. npm run deploy:router
14. npm run deploy:fast

PART E - check
15. Hard-refresh the app (Ctrl+Shift+R) and do the checks above.
