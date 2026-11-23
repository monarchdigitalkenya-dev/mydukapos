# Zip 363 - Car Wash: type or pick services, sign-in like the other apps, phone layout; plus everything in zip 362, 361 / 360 / 359 / 358

Contains everything from zip 362 (price list, printables, customers, staff tabs), zip 361 (Car Wash app), 360, 359, 358, 357 and 356. If you skipped any of them, this one deploys them too.

## What is new
- **Services by typing or drop-down** at check-in, in a new cleaning job and when editing a job.
- **Price List:** every preloaded service editable - name, section, price, duration, loyalty, active; add and delete.
- **Sign-in like the other apps:** Who's logging in? list; the person signed in shows at the top; tap it to Switch user or Sign out.
- **Phone friendly:** tables become cards, job windows fit the screen, nothing hidden behind the bottom bar.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip363
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_carwash-mobile_363_11091231.zip" -C C:\dev\zip363

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip363 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - remove the retired apps from your folder (safe: none of these are in this release)
8.  if exist C:\dev\mydukapos\chama rmdir /s /q C:\dev\mydukapos\chama
9.  if exist C:\dev\mydukapos\crm rmdir /s /q C:\dev\mydukapos\crm
10. if exist C:\dev\mydukapos\school rmdir /s /q C:\dev\mydukapos\school

PART D - check and test
11. npm install
12. npm run check
13. node --test --test-concurrency=1 tests\zip363-picker-mobile.test.mjs tests\zip362-pricelist-customers.test.mjs
    (the end must say: fail 0 - takes a few minutes)
14. node --test tests\zip361-carwash.test.mjs
    (the end must say: fail 0)

PART E - back up, database, deploy
15. npm run db:backup
16. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
17. npm run deploy:router
18. npm run deploy:fast
    (it prints "Old files from earlier releases left out of the upload" - expected)

PART F - after deploy
19. Each device: hard-refresh once (Ctrl+F5); installed apps update on their next start.
20. Car Wash (owner): open **Price List** - check the prices, change any, **Save price list**. A business that already edited its own prices in zip 361 keeps them: tap **Load the standard price list** if you want the Splash & Dash list.
21. Car Wash (owner): Settings > Business - name, phone, email, location, logo (they print on the intake form, receipt and invoice).
22. Car Wash (owner): Staff & Teams > Edit each person > tick the tabs they may open > Save.
23. Print a test: open a job > 📝 Intake form / 🧾 Receipt / 📄 Invoice (A4); Price List > Print price list / Blank intake form.
24. Public demo reloads its sample data once (new price list).
