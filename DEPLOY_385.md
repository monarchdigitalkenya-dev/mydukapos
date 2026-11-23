# Zip 385 - Stock typed in the item form now holds, category item manager, Price List in every app

Includes everything in zips 378 to 384.

## What changed
1. CRITICAL stock fix: a quantity typed in Add / Edit Item (Stock Quantity Available) is now recorded like a stock take, so it holds after a refresh and on every device. Before, the server kept its old figure (13 typed, 16 back).
2. Categories: every category (and Uncategorised) has an Items button - tick items, then Move them to another category or Delete them.
3. The Price List (with Targets vs Achieved and Sales by Category) is now in every app. Selling by minimum order stays in the Shop.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip385
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_stock-fix_385_11190235.zip" -C C:\dev\zip385

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip385 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
14. Press Ctrl+Shift+R on every till (on the terminal: swipe the app away and open it again). Sign in as admin.
15. Stock > Inventory: edit an item, change Stock Quantity Available (e.g. 16 to 13), Save.
16. Press Ctrl+Shift+R: it still says 13. Open the app on a second device: it says 13 there too.
17. Settings > Category images (Categories): press Items on Uncategorised, tick items, choose a category, press Move.
18. Open the Hotel / Pharmacy / other apps: Stock > Price List is there.
