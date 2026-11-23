# Deploy zip 323 - Excel import keeps the prices (includes everything from 304 to 322)

Zip 323: importing an Excel / CSV file no longer loses the selling prices. Before: the review window ("Review Import - Inventory List" > "Batch Commit") showed the cost but nothing in the Retail / Wholesale boxes, and after the import every price was 0 whenever the price column was named anything the importer did not know ("Unit Price", "Retail", "Selling_Price", "SP" ...). No database change. The router does not need deploying for this zip.
Service worker version: zip-323.

What changed (Shop, Hospital, Hotel, Pharmacy, Production, Services - the Water app has its own simpler importer and is not affected):
- The Retail and Wholesale boxes in the review window are now filled from the file, so what you see is what is saved; a price you type there is the one saved (the file's hidden value used to overwrite it).
- More ways of writing the columns are recognised: Selling Price / Unit Price / Sell Price / Sale Price / Retail / SP / Rate (selling); Cost / Unit Cost / Buying / Purchase Price (cost); Wholesale Price (wholesale). Capital letters, spaces, underscores and a unit in brackets ("Price (KSh)") no longer matter.
- A file with NO selling-price column now says so before you commit, instead of silently saving 0.
- An EMPTY price, cost or quantity cell no longer zeroes an item that is already in the shop (it used to set that item's cost and stock to 0).

All commands are Windows cmd. Run them one at a time, in order.

## PART A - START: unpack the zip
1. mkdir C:\dev\zip323
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_323.zip" -C C:\dev\zip323
## PART A - END

## PART B - START: copy into the work folder (keeps the wrangler files already pointing at your account)
3. robocopy C:\dev\zip323 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
   (robocopy exit codes 0 to 7 are success - only 8 or higher is an error)
4. cd /d C:\dev\mydukapos
5. node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57321-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6. node tools\switch-account.mjs --show
   (must print: Router forwards shop addresses to: mydukapos-3ao.pages.dev - if not, STOP)
## PART B - END

## PART C - START: check, test and deploy
7. npm install
8. npm run check
   (must say: All apps match src/shared/. then cards in sync then owner pro in sync)
9. node --test tests\zip323-import-prices.test.mjs
   (must say: pass 30, fail 0)
10. npm run deploy:fast
## PART C - END

## PART D - START: confirm
11. Open the Shop once so the service worker updates to zip-323 (close and reopen once if it still shows the old version).
12. Inventory > Import from Excel/CSV. Use a small file with the columns Item Name, Qty, Cost, Unit Price (two rows). In the review window the Retail boxes show the prices. Press Batch Commit: Inventory shows the same prices.
13. Import a file with no price column at all: a notice says no selling-price column was found and the Retail boxes are empty; type a price in one and commit - that price is saved.
14. Existing item: import a row for an item you already have, with the Qty cell left empty: its stock stays as it was.
## PART D - END

Rollback (Pages): Cloudflare dashboard -> Workers & Pages -> mydukapos-3ao -> Deployments -> previous Production deployment -> Rollback.
