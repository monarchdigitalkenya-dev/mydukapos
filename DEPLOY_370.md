# Zip 370 - rename a hotel room (Reception + Rooms list); everything tied to the room moves with it

## What is new
1. **✏️ Rename on every room in the 🛎️ Reception tab.** New "🛏️ Rooms" list: each room with its guest (or "Free") and a **✏️ Rename** button.
2. **✏️ Rename on every room card in the Rooms list** (Hotel tab / Settings), next to the QR and the remove (x) buttons.
3. **Nothing is lost when you rename.** These all move to the new name: the guest in the house, the open bill and room folio, coming reservations (so the room stays held on the same dates), the room type and rate, the housekeeping status, and open room-service requests. The room's printed QR code keeps working (it is renamed in the background, and retried if you are offline).
4. **Finished history keeps the old name** (settled receipts, completed requests), because that is what was printed on the day.

## Rules (the app tells you if you break one)
- The name cannot be empty, longer than 40 letters, or the same as another room or a table (capital letters do not make a name different).
- Only the owner or a manager can rename. A branch you are only viewing cannot be renamed.
- Cancel the box and nothing changes.

## Honest notes
- If two phones are open, **let the other phone finish syncing** (a few seconds online) before you rename, and do not rename the same room on two phones at once: the newest save wins.
- There is no undo button. To undo, rename it back (the same button).
- Closed receipts and finished service requests are not rewritten.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip370
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_room-rename_370_11161010.zip" -C C:\dev\zip370

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip370 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - check and test
8.  npm install
9.  npm run check
    (it must say: All apps match src/shared/)
10. node --test --test-concurrency=1 tests\zip370-room-rename.test.mjs
    (the end must say: fail 0 - takes about 1 minute)

PART D - back up, database, deploy
11. npm run db:backup
12. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
13. npm run deploy:router
14. npm run deploy:fast

PART E - after deploy
15. Each device: hard-refresh once (Ctrl+F5); installed apps update on their next start.

## Guide for beginners
**Rename a room** - open **Reception**, scroll to **🛏️ Rooms**, tap **✏️ Rename** beside the room (for example Room 01), type the new name (for example Garden View), press OK. The toast says "Room 01 is now Garden View. Its guest, reservations and bills moved with it." The same button is on each room card in the Rooms list.
