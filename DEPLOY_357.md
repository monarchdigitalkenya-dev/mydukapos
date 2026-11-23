# Zip 357 - Unrecorded / Extra Sales, Hotel Service Orders (tiles, ✏️ Edit), Orders tab in the Tabs window, phone layout, MD icon everywhere (not Aqua)

Contains everything from zip 356 (KCB fix, sort button, invoices...). If you never deployed 356, this one deploys both.

## What changed
1. **Hotel > Service Orders menu** now uses the same tiles as the Sales Counter: square picture, stock pill on the corner, name (2 lines max), price at the bottom, all tiles the same height. The search box is full width. On phones: 3 tiles per row.
2. **✏️ Edit on every line of a Service Order** (like the Sales Counter's price chip): quantity (− / +), price **Retail / Wholesale / Custom**, note for the kitchen / bar, 🗑️ Remove. The edited price goes onto the posted order and the customer's bill.
   - A waiter (no payments / order-management permission) needs the management password to change a price; others only when Settings ask for it on the Sales Counter (same rule).
   - Tapping an item again adds a new Retail line; it never merges into a line with an edited price.
3. **Sales Counter > 🧾 Tabs** (the button stays, and shows a count): the window now has two tabs, **🧾 Tabs** and **🍽️ Orders**. Orders lists every open order with its progress (🔔 ready to serve first, then bill printed, preparing, new), the waiter and balance, with 👁️ View, ➕ Add items, 🧾 Print bill and 💳 Take payment.
4. **Phone layout (Hotel)**
   - Sales Counter tiles are square again on phones (the 16:10 box showed every photo shrunk with grey bands either side).
   - The Bills and ⇅ Sort buttons in the phone search row are proper round icons (the Sort button's words were spilling over).
   - Service Orders: line buttons in two neat rows, the POST ORDER bar no longer pushes "Clear" off the screen.
   - Checked all 43 Hotel screens at 390 px and 360 px: nothing is wider than the screen.
5. **MD icon on every installed app except Aqua:** Shop (already), Hotel, Hospital, Pharmacy, Production, Services, Owner Console - home-screen (PWA) icons, Windows app icons and Android launcher icons. Aqua keeps its water-drop icon. Phones that already installed the app pick up the new icon when the app updates (some Android phones only after removing and re-adding the home-screen icon).

6. **➕ Unrecorded / Extra Sales** (every till app: Shop, Hotel, Hospital, Pharmacy, Production, Services, Aqua) - at the top of **Daily Sales**:
   - Type the total sold without ringing up products (e.g. 10,000), the profit margin % (20 by default; whatever you type is remembered on that device), how it was paid (Cash / M-Pesa / Card / Bank, optional reference) and an optional note. Before saving it shows **Sales / Profit / Cost recovery** (10,000 at 20 % = profit 2,000, cost recovery 8,000).
   - Saved as ONE normal sale (line "Unrecorded / extra sales", no stock touched, cost = cost recovery), so Daily Sales, cash / M-Pesa totals, cash drawer, Profits, reports, sync and the Owner Console all count it exactly once.
   - **Daily summary** for any date: Product sales (recorded) vs Unrecorded / extra sales vs Total - revenue, profit and cost recovery. The printed **Sales Report** gets the same table under it.
   - Wrong entry? **Void** (same reason + audit as any sale) takes it out of every total.
   - Checked: one product sale + 10,000 cash @20 % + 5,000 M-Pesa @30 % gives Daily Sales 15,200 (cash 10,200, M-Pesa 5,000), Profits revenue 15,200 / cost 11,620, stock unchanged; after voiding the 10,000 every figure drops by exactly 10,000.

No database migration.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip357
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_hotel-extra-sales_357_11070039.zip" -C C:\dev\zip357

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip357 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
13. node --test tests\zip357-hotel-orders.test.mjs
    (the end must say: fail 0)
14. node --test tests\zip357-extra-sales.test.mjs
    (the end must say: fail 0)
15. node --test tests\zip356-kcb-fix.test.mjs tests\zip349-kcb-buni.test.mjs
    (the end must say: fail 0)

PART E - back up, database, deploy
16. npm run db:backup
17. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
18. npm run deploy:router
19. npm run deploy:fast
    (it prints "Old files from earlier releases left out of the upload" - expected)

PART F - after deploy (once)
20. Each device: hard-refresh once (Ctrl+F5); installed apps update on their next start.
21. Windows / Android apps: rebuild them from native\ as usual to carry the MD icon (the web apps get it with this deploy).
22. If zip 356 was NOT deployed before: KCB shops - Settings > Payment Gateway > KCB > check Environment, Till / account number, Pass Key (empty unless KCB gave you one) > Save > test KES 10.
