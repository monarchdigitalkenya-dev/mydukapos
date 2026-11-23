# Zip 387 - No red banners on screen (plus everything in 385 / 386)

Includes everything in zips 378 to 384.

## What changed
1. The red banners are gone in every app, the demo included: "N sales not stored yet", "This device's storage is full" and "This device's clock is ...". The saving and resending behind them still runs by itself.
2. Everything from zip 385 / 386: stock typed in the item form holds; category items Move / Delete; Price List in every app.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip387
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_no-red-banner_387_11191145.zip" -C C:\dev\zip387

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip387 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
14. Press Ctrl+Shift+R on every till and on the demo (on the terminal: swipe the app away and open it again).
15. Make a sale: no red banner appears at the bottom of the screen.
16. Stock > Inventory: edit an item's Stock Quantity Available, Save, press Ctrl+Shift+R - the new figure stays.
