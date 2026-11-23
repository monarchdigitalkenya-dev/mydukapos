# Zip 378 - STK checks, receipt print, no panic bar, cleared customers stay cleared

## What was wrong and what changed (plain words)

1. M-Pesa STK (Daraja)
   - A payment amount sent with a comma ("22,000.00") was read as KES 22, so the sale it paid was flagged "paid less than the sale". All amounts from Safaricom, KCB and Paywave are now read correctly.
   - M-Pesa only moves whole shillings. A sale of 2,200.40 paid with 2,200 is no longer "paid less".
   - When Safaricom's callback never arrived, the payment was still confirmed by the status check, but its M-Pesa code was never recorded, so the typed code showed "no M-Pesa record". The confirmed prompt now counts as proof, and its code is recorded.
   - Sales flagged "paid less" before this update are checked once more with the corrected rules.
   - The Daily Sales banner now shows only real problems (code used twice, really paid less). "No record found yet" is no longer shown.
   - Till health no longer says "never registered" as an error: Register Till URLs is OPTIONAL. STK prompts work without it.
   - Daraja request: keys, shortcode and pass key pasted with a space or line break are cleaned; the account reference and description are plain letters and numbers (a business name with ( ) or ' made Safaricom refuse the prompt); the amount is always whole shillings.
   - When you replace live Daraja keys (held for 60 minutes for safety), a change of Sandbox/Production or Paybill/Till made at the same time now waits with them, instead of applying alone and breaking every prompt for that hour.
2. Printed receipt: the "Paper: 58 mm 80 mm" buttons, the "80 mm paper, N characters a line" note and the X no longer print. "Total:" and the amount stay on one line. The branch name prints without the building icon (it printed as an empty box). A long name like HOTEL(ACCOMODATION) breaks before the bracket.
3. The red "Not receiving new orders" bar, its beep, vibration and the bottom-left Live / Not receiving pill are gone. The app still reconnects and catches up by itself, silently.
4. Clear customers (and Remove Customer) now delete each customer properly on every device, so cleared clients do not come back after a sync. Deleted customers never show in any customer list.

## Honest limits
- Not tested against a live Daraja account or on your terminal printer. Tested with automated tests and by rendering the receipt in Chrome.
- A Till payment already saved by the old code as KES 22 (instead of 22,000) keeps that wrong amount. New payments are read correctly.
- Customers that already came back after an earlier clear must be cleared once more (Settings, Clear customers) after this update.
- Guests still checked in to a room are rooms, not customers: check them out from Reception to clear them.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip378
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_bugfix-stk-receipt_378_11180045.zip" -C C:\dev\zip378

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip378 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - check and test
8.  npm install
9.  npm run check
    (it must say: All apps match src/shared/)
10. node --test --test-concurrency=1 tests\zip378-bugfix.test.mjs
    (the end must say: fail 0)

PART D - back up, database, deploy
11. npm run db:backup
12. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
13. npm run deploy:router
14. npm run deploy:fast

PART E - check on the real devices
15. Open the app, press Ctrl+Shift+R (or close and reopen the installed app).
16. STK: send a KES 1 or 10 prompt to your own phone, pay it, complete the sale. Open Daily Sales: no warning banner.
17. Receipt: open a room bill, press Print. The paper must NOT show "Paper: 58 mm 80 mm", the note or the X, and "Total:" must have its amount on the same line.
18. Clear customers: Settings, Clear customers (or Remove Customer on one), then refresh on a second device. They must stay gone.
