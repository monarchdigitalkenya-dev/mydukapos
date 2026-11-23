# Zip 354 - stock audit

Checked every screen that changes stock: Restock, Orders (purchase orders, "Arrived"), Stock Take, sales, voids, returns, supplier returns, contract issue/return, Capture List, batch/lot items (Pharmacy, Hospital), variants. Each was run end to end, including the server being down, a refresh mid-sync, and two tills.

## Result
- Restock, purchase-order arrival and stock take all add / set stock correctly on the till AND on the server, in every app. New regression tests: `tests/zip354-purchase-stock.test.mjs` (8 tests).
- **Fixed - Stock Report double counted every sale.** A sale was counted in "Sold" (from the sales log) and again as a removal (its stock movement). Opening came out too high, "Removed" included the sales, and Closing of a past period was too high. Sales and their voids are now counted once (Sold). Restocks, purchase orders, returns and stock takes show under Added / Removed as before. (shared code, all apps)
- **Fixed - Capture List update of an existing item** changed its quantity with no itemised movement (it showed up as an anonymous "Stock correction"). It now records "Capture List (import)" with the exact change.

## Deploy
Front-end and shared code only. No migration. `sw.js` is zip-354 so tills pick the new build up.

All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip354
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_stock-audit_354_11061252.zip" -C C:\dev\zip354

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip354 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - check and test
8.  npm install
9.  npm run check
10. node --test tests\zip354-purchase-stock.test.mjs
    (the end must say: fail 0)

PART D - back up and deploy (no database migration this time)
11. npm run db:backup
12. npm run deploy:fast
