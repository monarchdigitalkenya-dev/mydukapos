# Zip 366 - HMIS changes (6 items) + cash figures fix; plus everything in zip 365 and earlier

## What is new
- **HMIS:** fees block removed (use Add Charge) - doctor views lab results only - consultation fee optional - past visits editable - "Draft & send to cashier" - second diagnosis - lab result delete needs management password or manager PIN.
- **POS cash:** Cash / M-Pesa / card now come from ONE rule everywhere. If cash was taken earlier in the day before the drawer was opened, the drawer shows a yellow notice; a manager taps **Add to opening count**.

## Fix today's drawer (the 42,330 case)
1. Sign in as a manager or admin, open the Cash drawer.
2. You will see "KES 15,000 cash was taken today before this drawer was opened". If that cash is in the drawer, tap **Add 15,000 to opening count** and confirm.
3. Expected now reads 42,330 = the cash you counted. Nothing is deleted; the original opening count stays on record.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip366
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_hmis-cashfix_366_11130055.zip" -C C:\dev\zip366

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip366 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - check and test
8.  npm install
9.  npm run check
10. node --test --test-concurrency=1 tests\cash-drawer.test.mjs
    (the end must say: fail 0 - takes a few minutes)

PART D - back up, database, deploy
11. npm run db:backup
12. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
13. npm run deploy:router
14. npm run deploy:fast

PART E - after deploy
15. Each device: hard-refresh once (Ctrl+F5); installed apps update on their next start.
16. Shop POS: open Cash drawer and follow "Fix today's drawer" above.
17. Hospital: open a consultation - the fees block is gone; use Add Charge. Try Add diagnosis, Draft & send to cashier, and Edit on a past visit.
18. Lab: in the lab list the (x) on a completed result asks for the management password or a manager PIN.

## Quick user guide (HMIS)
- **Consultation fee:** leave blank for no fee.
- **Add Charge:** procedures, nursing and other fees go here; they appear at the cashier.
- **Draft & send to cashier:** sends the charges now; you can keep working and Save later - the charges are not repeated.
- **Edit a past visit:** open the visit, tap Edit, change, Save (the change is recorded).
- **Doctor and lab:** the doctor can only view lab results; lab officers enter them.
