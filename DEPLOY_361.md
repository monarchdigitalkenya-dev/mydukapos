# Zip 361 - Car Wash & Cleaning: its own application (out of Services), Owner Console tab, public website and demo; plus everything in zip 360 / 359 / 358

Contains everything from zip 360 (receipt layout, Sales + Sort buttons), 359, 358, 357 and 356. If you skipped any of them, this one deploys them too.

## What is new
- **Car Wash & Cleaning app** at `/carwash/` (product "carwash"): dashboard, car check-in by number plate, jobs board, carpets / sofas / mattresses / house and office cleaning, customers and vehicles, 9 + 1 loyalty, automatic SMS, staff and teams with roles, job billing and payments (cash, M-Pesa STK, deposits, part payments, refunds), invoices, reports to Excel / CSV / PDF, settings, activity log. No sales counter.
- **Services:** Car Wash is no longer offered. A Services shop set to car wash sees where its screens went; its car wash records are imported by the Car Wash app automatically (nothing deleted).
- **Owner Console:** new **🚗 Car Wash** tab - GENERATE APPLICATION LINK, copy / open, usage, activate / deactivate (revoke), identity, and "Move to Car Wash app".
- **Website:** Car Wash card on the home page, `/products/carwash`, and the public demo now opens the Car Wash app (sample data reloads once after deploy).
- Full details: `CARWASH_APP.md`.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip361
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_carwash-app_361_11090033.zip" -C C:\dev\zip361

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip361 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
13. node --test tests\zip361-carwash.test.mjs
    (the end must say: fail 0)
14. node --test tests\zip360-receipt-layout.test.mjs tests\zip359-order-delivery.test.mjs tests\zip358-till-health.test.mjs
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
20. Owner Console > 🚗 Car Wash > GENERATE APPLICATION LINK for each car wash business (or "Move to Car Wash app" for one that was on Services) > 📋 Copy link and send it.
21. In each Car Wash business (signed in as the owner): Settings > Business, Services & prices, Payments (Till / Paybill), then Staff & Teams > Add staff. SMS and M-Pesa use the same gateways as before: Settings > Data & system > Open system settings.
22. Public demo: open https://mydukapos.store/products/carwash > Try Live Demo (password 0000; staff PIN 0000).
