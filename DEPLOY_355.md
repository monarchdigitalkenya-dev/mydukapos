# Zip 355 - purchases of items with variants

## The bug
A purchase order ("Arrived") for an item with variants (size / colour) said "received - stock updated", but the stock vanished on the next sync:
1. Its stock movement was filed under the PARENT item's code. The server keeps a variant's stock under the VARIANT's code and ignores movements for a parent, so the quantity was never applied and the screen went back to the old figure.
2. A purchase line that named the item but no variant had nowhere to go at all and still showed "received".
3. Pharmacy: a Restock that stocked nothing (item with variants) still said "Restock recorded" and logged a KES 0 expense.

## Fixed (all apps)
- Variant purchases are logged under the variant's code, so the server applies them (tested: server, second sync and fresh load all keep it).
- A purchase-order line that names an item with variants but no variant is refused when you save the order and when you press Confirm Arrival, with the list of variants to pick. Nothing is half-received.
- Pharmacy Restock now behaves like the other apps: nothing stocked = no success message, no expense, rows stay on screen.
- Also carried from zip 354: Stock Report no longer counts sales twice; Capture List updates are itemised.

Checked and working: normal items, packs (Bought as: boxes x size + loose), box items (stock in boxes), batch items (Pharmacy / Hospital), serial items, stock take, restock by variant code.
Not supported: buying loose PIECES of an item stocked in boxes (a purchase always adds in the item's own stock unit).

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order. No database migration.

PART A - unpack
1.  mkdir C:\dev\zip355
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_variant-purchases_355_11061312.zip" -C C:\dev\zip355

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip355 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - check and test
8.  npm install
9.  npm run check
10. node --test tests\zip355-variant-purchase.test.mjs
    (the end must say: fail 0)

PART D - back up and deploy
11. npm run db:backup
12. npm run deploy:fast
