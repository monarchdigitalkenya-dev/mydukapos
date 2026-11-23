# Zip 362 - Car Wash: Splash & Dash price list + Price List tab, intake form and receipts, customers add / edit / delete in every app, staff tabs; plus everything in zip 361 / 360 / 359 / 358

Contains everything from zip 361 (Car Wash app), 360, 359, 358, 357 and 356. If you skipped any of them, this one deploys them too.

## What is new
- **Car Wash price list preloaded** from the Splash & Dash intake form, edited in the new **Price List** tab (prices, per-vehicle-type prices, add / delete services, vehicle types, print).
- **Printables:** client intake form / job card (A4, one page, signature lines), 80 mm receipt, A4 invoice, price list, blank intake form.
- **Customers:** add, edit and delete in every app (Shop, Hotel, Hospital, Production, Services, Aqua POS, Pharmacy, Car Wash). Car Wash adds email, gender, preferred contact and vehicle year.
- **Staff tabs:** in the Car Wash app the owner ticks the tabs each person can open (Staff & Teams > Edit).
- **Sync fix:** a customer / vehicle / job deleted on one Car Wash device now disappears on the others.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip362
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_carwash-pricelist_362_11091054.zip" -C C:\dev\zip362

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip362 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
13. node --test --test-concurrency=1 tests\zip362-pricelist-customers.test.mjs
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
