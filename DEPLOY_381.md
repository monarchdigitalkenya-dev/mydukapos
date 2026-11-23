# Zip 381 - Price List, price list import, MOQ selling, payment fixes

Includes everything in zips 378, 379 and 380.

## What changed
1. Shop app: new Price List screen (side menu, Stock folder). Items and Services, each with price, MOQ, quantity left (items),
   monthly target in KSh and how much of it was achieved this month. Type into a box to change it (admin only).
2. Import price list: the E254 Services sheet (or any Excel / CSV price list) imports straight in. A preview shows every row
   first; nothing is saved until you press Import. All rows come in as services; switch any row or category to Item if you keep stock of it.
3. MOQ: the price is for the whole minimum order. Brown Bags Branded A3 = KES 73 for 150 pieces.
   Each MOQ item is set on the Price List to either
   - Whole packs only: 150 pcs = KES 73, 300 pcs = KES 146, 450 pcs = KES 219, or
   - Any number from 150: 200 pcs = KES 97 (rounded to the shilling - never cents).
   Imported items start as Whole packs only.
4. A service with no price in the list (Photo Studio Rental, Signages ...) is marked "typed at the counter": the cashier must type its price in the cart before checkout.
5. Payments: KCB / Co-op successful prompts were being marked failed; fixed. Daraja token is reused; a status check can no longer overwrite the callback's code; Co-op clock fixed; Paywave / KCB codes verifiable.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip381
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_price-list_381_11181455.zip" -C C:\dev\zip381

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip381 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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

PART E - import your price list
14. In Google Sheets open the E254 sheet: File > Download > Microsoft Excel (.xlsx).
15. Shop app: press Ctrl+Shift+R (on the terminal: swipe the app away and open it again). Sign in as admin.
16. Side menu: Stock > Price List > Import price list. Choose the downloaded .xlsx.
17. Check the preview: 123 rows, all New services. Rows with an orange note are worth a look:
    - targets smaller than one order (e.g. KSh 54 for the A4 branded bags) are left empty - type the real target on the Price List;
    - "Luxury Bags ... A5+" is in the sheet twice (KSh 110 and KSh 90); the second comes in as "... A5+ (2)" - rename it if it is A5.
18. Press Import 123 row(s).
19. Price List > Services: for each MOQ item choose Whole packs only or Any number from 150 under the MOQ box.
20. Sales Counter: add Brown Bags Branded A3 - the cart shows 1 x (pack of 150) = KES 73; + makes it 2 packs = KES 146.
