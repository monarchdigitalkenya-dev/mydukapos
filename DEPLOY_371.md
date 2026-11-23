# Zip 371 - restock finds variants, one tap fills the name, scan searches Inventory, numbers add up

## What was wrong and what changed
1. **Restock / Purchases search did not find variants.** The drop-down now lists every variant as its own line ("Cotton Socks (Large Red)") with its own code, stock and last cost. Type any part: item name, variant name, code, SKU or barcode, words in any order ("red large socks"), with or without dashes. A parent item that has variants is not listed (you restock the variant). Typing a variant's code, barcode or full name in the box by hand also restocks that variant now (it used to create a new item). Same drop-down in the new Purchases tab.
2. **Tapping twice / only a few letters.** Root cause: the page's typing guard put back the half-typed text when the row redrew, and the old list picked on touch-start and hid itself whenever the phone keyboard scrolled the page. Now one tap picks the exact line (a drag only scrolls the list), the box lets go first so the full name stays, and the list follows the box instead of vanishing. Items with no code can be picked too.
3. **Scanning on the Inventory list** now searches the inventory (item code, barcode, piece code, any variant barcode), shows "Found: name" or "No item with code ...", and stays on Inventory. On the Sales Counter a scan still adds to the cart.
4. **Numbers.** Stock value on the Dashboard, the stock valuation panel and the stock reports now count every variant at its own cost and price (they used the parent's single price). The restock expense is rounded to the cent. New test checks stock, stock value, revenue, cost, profit and the restock expense against each other.

## Honest notes
- Aqua POS (water) has no barcode scan handler and no variants, so fix 3 does not apply there.
- Purchase-order screens keep listing the parent item (not variants), as before.
- Closed sales and old reports are not changed. Only how current stock is valued.
- "All numbers" is checked on the Shop flow end to end (restock, sell, void, dashboard, profit report). Tell me any screen where a figure still looks wrong and I will trace it.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip371
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_restock-variants_371_11161309.zip" -C C:\dev\zip371

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip371 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - check and test
8.  npm install
9.  npm run check
    (it must say: All apps match src/shared/)
10. node --test --test-concurrency=1 tests\zip371-restock-search-scan.test.mjs
    (the end must say: fail 0)
11. node --test --test-concurrency=1 tests\zip371-numbers-add-up.test.mjs
    (the end must say: fail 0)

PART D - back up, database, deploy
12. npm run db:backup
13. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
14. npm run deploy:router
15. npm run deploy:fast

PART E - after deploy
16. Each device: hard-refresh once (Ctrl+F5); installed apps update on their next start.

## Guide for beginners
**Restock a variant:** Restock (or Purchases) > in the item box type part of the name, variant or code (for example "large") > tap the line you want > the full name and code fill in and the cursor jumps to How many > type the quantity and the cost > save.
**Find an item with the scanner:** open Inventory, scan the barcode. The list shows just that item.
