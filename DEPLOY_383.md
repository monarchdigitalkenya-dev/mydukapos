# Zip 383 - Service tiles on the Sales Counter

Includes everything in zips 378 to 382 (Price List, import, MOQ selling, Targets vs Achieved report, payment fixes).

## What changed
1. Sales Counter: services now have picture tiles next to the items (printing, typing, KRA, branding ...).
   A service with a photo shows it; one without shows its initials on a green tile, with a SERVICE tag.
2. The tile shows the price in whole shillings; with an MOQ it says e.g. KES 73 / 150 pcs; with no fixed price it says Price at counter.
3. Tap the tile to add it. A service that uses Matt OR Glossy paper asks which one first.
4. Service categories (Cyber Cafe, Branding & Printing ...) now show in the category tiles too.
5. To give a service a photo: Stock > Inventory, edit the service, add the picture.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip383
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_service-tiles_383_11181519.zip" -C C:\dev\zip383

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip383 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
14. Press Ctrl+Shift+R (on the terminal: swipe the app away and open it again).
15. Sales Counter: service tiles show with the items. Tap B/W Printing A4: it goes into the cart at KES 15.
16. Open a category tile (e.g. Cyber Cafe & Digital Services): its services are listed.
