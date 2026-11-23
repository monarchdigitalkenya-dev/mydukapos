# Zip 382 - Targets vs Achieved report

Includes everything in zips 378 to 381 (Price List, price list import, MOQ selling, payment fixes).

## What changed
1. Reports now has a Targets vs Achieved button (Shop app).
2. It lists every item and service that has a monthly target, grouped by category: target for the period, achieved (sales value),
   achieved %, how much is still short, how many were sold, and a status - Reached, On track or Behind.
3. This month = the whole month's target; On track means you are at or above where you should be by today.
   Shorter or longer periods spread the monthly target by days (Last 7 days = about a quarter of the month).
4. Print / Save as PDF and Download for Excel (CSV) work on it like the other reports.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip382
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_targets-report_382_11181502.zip" -C C:\dev\zip382

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip382 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - check
8.  npm install
9.  npm run check
    (it must say: All apps match src/shared/)

PART D - back up, database, deploy
10. npm run db:backup
11. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
12. npm run deploy:router
13. npm run deploy:fast

PART E - check
14. Shop app: press Ctrl+Shift+R (on the terminal: swipe the app away and open it again). Sign in as admin.
15. If not done yet: Stock > Price List > Import price list - import E254_Services_Import.xlsx, then E254_Products_Import.xlsx.
16. Reports: Period = This month, press Targets vs Achieved.
17. Press Download for Excel (CSV) or Print / Save as PDF to keep it.
