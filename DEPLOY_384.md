# Zip 384 - Variants, printable targets report, reports by category, MOQ and target on the item forms

Includes everything in zips 378 to 383 (Price List, import, MOQ selling, Targets report, service tiles, payment fixes).

## What changed
1. Price List: every variant (size / colour) has its own row with its price, stock and sales. The MOQ and the monthly target are the item's - the variants share them.
2. A variant of an MOQ item sells like the item: whole packs (or any number from the MOQ) at the variant's own price, from the variant's own stock.
3. Targets vs Achieved prints on A4 exactly as shown: Reports > Print / Save as PDF. The Price List also has a Print targets report button (for the month chosen there).
4. Reports by category: a Category picker beside the Period. It narrows Targets vs Achieved, and there is a new Sales by Category report (each category's sales, its share, what sold inside it). Both print on A4 and download for Excel.
5. Add Item form: a Price List details box - Category, MOQ, Sold as (whole packs / any number from the MOQ), Target per month.
6. Add Multiple Items: MOQ and Target / month columns.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip384
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_category-reports_384_11181540.zip" -C C:\dev\zip384

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip384 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
14. Press Ctrl+Shift+R (on the terminal: swipe the app away and open it again). Sign in as admin.
15. Stock > Price List: an item with sizes shows a row for each size; MOQ and target say "shared".
16. Reports: Period = This month, Category = Branding & Printing, press Targets vs Achieved, then Print / Save as PDF - an A4 page.
17. Reports: Category = All categories, press Sales by Category.
18. Stock > Add Item: the Price List details box (Category, MOQ, Sold as, Target per month) is under the prices.
19. Stock > Add Multiple Items: the table has MOQ and Target / month columns.
