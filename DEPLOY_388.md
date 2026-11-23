# Zip 388 - Every figure reconciled + KCB IPN fix + KCB sandbox payload capture

Includes everything in zips 378 to 384.

## What changed
1. A full trading day was run on two tills against the real server; every figure was checked against the figure worked out by hand: 81 of 81 agree.
2. Daily Sales: the Sales count no longer counts voided sales; Unpaid now includes what customers still owe on bills.
3. Quoting a total gives whole shillings only (KES 1,000 for 3 items = 333 + 333 + 334).
4. Price List, Targets vs Achieved and Sales by Category include payments made on bills, so they add up to the Sales report.
5. KCB IPN: transactionID in our reply is now exactly KCB's transactionReference on every reply.
6. KCB sandbox: the exact STK push request and the last IPN can be read at /api/kcb-debug?c=<shop>&k=<key>.
7. Everything from zips 385 to 387.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip388
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_reconciled-kcb_388_11192310.zip" -C C:\dev\zip388

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip388 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
14. Press Ctrl+Shift+R on every till (on the terminal: swipe the app away and open it again). Sign in as admin.
15. Daily Sales: Sales count, Revenue, Cash and M-Pesa match the day's receipts; Unpaid shows what customers still owe on bills.
16. Sales Counter: add 3 of one item and quote a total that does not divide (e.g. 1000) - the lines are whole shillings that add up to the quote.
17. KCB: Settings > Payment Gateway, KCB Environment = Sandbox, Save. Copy the IPN Callback URL shown (it ends with ?c=...&k=...).
18. Send a test prompt from the till (pay with M-Pesa prompt, a sandbox number).
19. In the browser open the same address with kcb-debug in place of kcb-ipn, e.g. https://mydukapos-3ao.pages.dev/api/kcb-debug?c=YOURSHOP&k=YOURKEY - it shows the exact JSON sent to KCB and KCB's answer.
