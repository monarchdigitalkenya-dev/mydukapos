# Zip 375 - Print prints the RECEIPT, not the page (every app)

## What was wrong (plain words)
On the Chrome web app (and any Android print dialog), pressing Print on the Sales Counter printed the Sales Counter screen, not the receipt.
The app hides everything except the receipt just before printing, and un-hides it the moment Android says "print started". But Android draws its
preview AFTER that - and draws it again every time you change the paper size - so it saw the whole screen (12 pages).

## The fix
When you print, the receipt (or report, or kitchen slip, or barcode sheet) is copied into its own hidden document and THAT is printed.
What the screen does afterwards cannot change it. It uses your chosen paper width and letter size. Nothing to switch on.
Inside the Android/Windows app nothing changes (it prints with its own printer code).

## Also on this zip
Zip 374's delivery guard (orders/bills must keep arriving) is included.

## Check it on the terminal (Chrome web app)
1. Make a sale on the Sales Counter and press Print.
2. The print preview must show ONE narrow page with the receipt (not the Sales Counter).
3. In Settings > Receipt size set 58 mm (the print dialog's own "58mm Roll" must match), then print again.
4. Change the paper size in the print dialog: the preview must still show the receipt.
If it ever misbehaves, tell me; support can switch the fix off with localStorage pos_print_isolate = 0.

## Honest limits
Tested with automated tests in a simulated browser, not on your terminal: Chrome on Android may still show its own dialog and paper-size options (that is Android, not the app).
For printing straight to the built-in printer with no dialog at all, use the Hotel APK.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip375
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_print-receipt-fix_375_11162210.zip" -C C:\dev\zip375

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip375 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - check and test
8.  npm install
9.  npm run check
    (it must say: All apps match src/shared/)
10. node --test --test-concurrency=1 tests\zip375-print-isolate.test.mjs
    (the end must say: fail 0)

PART D - back up, database, deploy
11. npm run db:backup
12. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
13. npm run deploy:router
14. npm run deploy:fast

PART E - on the terminal
15. Open the app in Chrome, press Ctrl+Shift+R (or clear the site data once), then do the "Check it" steps above.
