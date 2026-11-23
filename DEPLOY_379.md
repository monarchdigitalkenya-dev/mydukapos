# Zip 379 - dark receipts on the handheld terminal, no status indicators on screen

Includes everything in zip 378 (STK checks, receipt layout, cleared customers). If 378 was never deployed, this one covers both.

## What changed
1. Receipts print DARK on thermal printers (the handheld terminal, Bluetooth, USB, network):
   - Printer letters: every line bold + double-strike (the printer goes over each line twice).
   - A chosen letter size (printed as a picture): letters drawn bold with a thin black outline, and the grey edges of letters now print black. Digits like 6, 8 and 0 stay open and readable.
   - Printing through the phone's print screen: all receipt text pure black and bold.
2. No status indicators on screen:
   - "Not receiving new orders - last update ... Retry now" bar: gone (zip 378), with its beep and the Live / Not receiving pill.
   - "Stock confirmed by the server ... ago" bar and its Refresh stock button: gone. The stock is still refreshed from the server by itself.
   - "Saving on this device - will sync automatically" pill: gone. Work is still saved and synced by itself.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip379
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_dark-receipt-quiet_379_11180920.zip" -C C:\dev\zip379

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip379 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - check and test
8.  npm install
9.  npm run check
    (it must say: All apps match src/shared/)
10. node --test --test-concurrency=1 tests\zip379-dark-quiet.test.mjs tests\zip378-bugfix.test.mjs
    (the end must say: fail 0)

PART D - back up, database, deploy
11. npm run db:backup
12. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
13. npm run deploy:router
14. npm run deploy:fast

PART E - check on the handheld terminal
15. Close the MyDuka app on the terminal fully (swipe it away) and open it again, so it loads this version.
16. Make a small sale and print: the letters must be solid black.
17. The Sales Counter must show no red bar, no "Live" pill and no "Stock confirmed by the server" line.
