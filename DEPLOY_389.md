# Zip 389 - KCB sandbox payload in a popup (plus everything in zip 388)

Includes everything in zips 378 to 384.

## What changed
1. KCB sandbox: after sending an M-Pesa prompt with KCB set to Sandbox, a popup shows the exact JSON request sent to KCB and KCB's answer. Press Copy request and paste it into the email to KCB.
2. Everything from zip 388: every figure reconciled, Daily Sales count and unpaid, whole-shilling quotes, bill payments in the Price List and category report, KCB IPN transactionID fix.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip389
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_kcb-popup_389_11192320.zip" -C C:\dev\zip389

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip389 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
14. Press Ctrl+Shift+R on the till (on the terminal: swipe the app away and open it again). Sign in as admin.
15. Settings > Payment Gateway: KCB Buni, Environment = Sandbox, Save.
16. Sales Counter: add an item, choose M-Pesa, send the prompt to a test number.
17. The popup "KCB sandbox: request sent to KCB" opens. Press Copy request and paste it into the email to KCB.
