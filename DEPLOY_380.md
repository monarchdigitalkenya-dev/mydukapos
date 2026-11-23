# Zip 380 - Invoicing under Money, printed invoice = preview

Includes everything in zips 378 and 379 (STK checks, receipt fixes, dark thermal print, no status indicators).

## What changed
1. Invoicing is now inside the Money folder of the side menu (right after Daily Sales), in every app.
2. The printed invoice is now exactly what the preview shows, on A4: same layout, same colours, same totals.
   Before, Print poured the invoice into the narrow receipt-roll "report" print, which is why paper and preview looked totally different.
   Statements and the receivables (ageing) page print the same way.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip380
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_invoice-money_380_11180933.zip" -C C:\dev\zip380

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip380 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - check and test
8.  npm install
9.  npm run check
    (it must say: All apps match src/shared/)
10. node --test --test-concurrency=1 tests\zip380-invoice-print.test.mjs tests\zip379-dark-quiet.test.mjs tests\zip378-bugfix.test.mjs
    (the end must say: fail 0)

PART D - back up, database, deploy
11. npm run db:backup
12. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
13. npm run deploy:router
14. npm run deploy:fast

PART E - check
15. Press Ctrl+Shift+R (on the terminal: swipe the app away and open it again).
16. Side menu: open Money - Invoicing is listed there.
17. Open an invoice, press Preview / Print, then Print: choose A4 paper. The paper must look like the preview.
