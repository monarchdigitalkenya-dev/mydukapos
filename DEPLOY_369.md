# Zip 369 - simple Expenses and Purchases tabs, Borrow & Lend between shops, delete a customer, Aqua inventory Export/Import, hotel Reception + check-in date; plus everything in zip 368 and earlier

## What is new
1. **💸 Expenses tab (every shop app, hospital, pharmacy, production, services, car wash, hotel).** Type the amount, tap a category, tap **Save expense**. It uses the app's own expense engine, so reports, sync and permissions are exactly as before. The old long "Add Expense" form in the Profit Report is now folded away (tap it to open if you ever want it).
2. **🛒 Purchases tab (all apps; in Aqua the old "Restocking" tab is renamed Purchases).** List what you bought (item, how many, what one cost, and optionally what it SELLS at - a new item otherwise sells at its cost). Choose **Paid in full / Part paid / On credit (pay later)**; credit and part-paid are recorded in the supplier's account (pay later in the Suppliers tab). Stock goes up, the cost price is updated, and ONE "Restock" expense is recorded. Pharmacy also asks batch and expiry. Scanning / photo / spreadsheet restock is still available in the **Restock** tab.
3. **Delete a customer.** Open the customer's profile and tap **Delete customer**. It now removes them on every phone after sync (it was a plain removal before, which could come back). Their past sales and receipts keep the name and phone. Only the Admin or a manager can delete.
4. **Aqua: export / import the inventory list.** On the Inventory tab: **Export list** (opens in Excel), **Import list** (shows a preview first - nothing changes until you tap Apply) and **Template** (a blank sheet to fill in).
5. **Hotel: new 🛎️ Reception tab** - rooms free, arriving today, in the house, leaving today, coming reservations, check-in and a reserve form, all on one screen.
6. **Hotel: "Date entered" when checking in a room.** Pick today (normal check-in), an earlier date (the stay starts on that date) or a later date (it becomes a reservation and the room is held, the guest is not checked in yet).

7. **🔄 Borrow & Lend (Shop, Production, Services, Pharmacy, Car wash, Hotel - the apps that have Trade Credits).** Items between you and other shops, in plain steps:
   - **📥 I borrowed items** - your stock goes UP now; you owe the other shop the value. An item you do not stock can be added to your stock so you can sell it.
   - **📤 I lent items** - your stock goes DOWN now (you cannot lend more than you have); they owe you the value.
   - Then settle it any way you agree, any number of times: **↩️ the same items come back** (stock moves back), **🔁 pay with other items** (worth more than owed? the extra becomes a new amount the other way), **💵 pay money** (part payments allowed), **✍️ write off** (manager, with a reason).
   - **⚖️ Cancel out** when you both owe each other. **📲 Send statement** on WhatsApp. Due dates with an overdue flag. A full history on every loan.
   - **✖ Cancel this entry** (manager) undoes an entry made by mistake and puts every stock change back.
   - The old **Trade Credits** tab still holds money entries; its totals now include item loans, and its Settle / delete buttons on an item loan send you to Borrow & Lend instead of closing it without the items.

## Honest notes
- **Crowded tabs I did NOT split** (they still hold many buttons): Settings, Payroll, Services counter, Hospital appointments, Gas, Add item, Rentals, Sales, Hiring, Store and Returns, plus the hotel's older Rooms tab (Reception is the simple view of it). Tell me which one bothers you most and I will split that one next. I did split Profit Report/Expenses, Restock/Purchases, and Hotel/Reception.
- In the Profit Report the **Recurring Expenses** section is still there (rent, wifi, salaries that repeat).
- **Borrow & Lend is not in the Aqua (water) and Hospital apps**, because those do not have the Trade Credits tab. Tell me if you want it there.
- **Money paid or received in Borrow & Lend is only tracked** (the same as Trade Credits always was): it is not added to Expenses or the cash drawer. Record the cash movement in the usual place if you need it in the books.
- **Two phones changing the SAME loan at the same moment** (for example both recording a return in the same second): the newest save wins, but the stock changes of both are kept in the stock log. Record a loan's returns on one phone at a time.
- A loan cannot be edited after saving; use **Cancel this entry** (manager) and enter it again.
- Deleting a customer wipes their name and phone from this and the other phones (sales and receipts keep what they were printed with). If they still owe money you are warned first.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip369
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_borrow-lend_369_11160212.zip" -C C:\dev\zip369

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip369 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - check and test
8.  npm install
9.  npm run check
    (it must say: All apps match src/shared/)
10. node --test --test-concurrency=1 tests\zip369-simple-tabs.test.mjs
    (the end must say: fail 0 - takes about 3 minutes)
11. node --test --test-concurrency=1 tests\zip369-shop-loans.test.mjs
    (the end must say: fail 0 - takes about 3 minutes)

PART D - back up, database, deploy
12. npm run db:backup
13. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
14. npm run deploy:router
15. npm run deploy:fast

PART E - after deploy
16. Each device: hard-refresh once (Ctrl+F5); installed apps update on their next start.

## Guide for beginners
**Expenses** - open **Expenses** (Money group in the side menu). 1) type the amount, 2) tap a category (Food, Transport, Rent...), 3) optional note, 4) **Save expense**. Today's list is underneath; tap the bin to remove a wrong one. Change the date at the top to record yesterday's expense.

**Purchases** - open **Purchases** (Stock group). 1) choose the supplier if you want, 2) type the item name (pick from the list, or type a new name to create it), how many, cost of ONE, 3) **+ Add another item** for more, 4) **Save purchase**. The total shows at the bottom.

**Delete a customer** - Customers > tap the customer > **Delete customer** > OK. If they still owe money, the message warns you first.

**Aqua inventory list** - Inventory tab. **Template** gives a blank sheet. Fill it (Code, Name, Type, Size, prices, Stock...). **Import list** > choose the file > read the preview (to update / new / skipped) > **Apply**. **Export list** saves your current list; you can edit it and import it back.

**Hotel date entered** - Rooms > tap a free room > Check in. **Date entered** is today by default. Choose a later date and the button changes to **Reserve** - the room is held for that date. Choose an earlier date to record a guest who arrived earlier.

**Hotel Reception** - open **Reception**. The cards show rooms free / arriving / in the house. Tap a room to check in, tap an arriving guest to check them in, tap Checkout on a guest who is leaving. The **Reserve a room** form is at the bottom.

**Borrow & Lend (example)** - Mama Mboga lends you 10 sugar. Borrow & Lend > **📥 I borrowed items** > shop name > item "Sugar 1kg", 10 > the value fills in from your price list (change it if you agreed another) > **Save**. Your stock is now +10. Later you give back 6: tap **Settle** on that loan > **↩️ I give the items back** > type 6 > **Save**. Stock is -6 and 4 sugar worth is still owed. You pay the rest with money: **💵 I pay money** > amount > **Save payment**. It moves to **Finished**.
If they instead take 2 cooking oil (worth more) in place of the sugar: **🔁 I pay with other items** > pick the oil, how many, the value > **Save**.
**Buy from a supplier on credit** - Purchases > fill the items > choose **📒 On credit** > pick the supplier at the top > **Save purchase**. Pay the supplier later from the Suppliers tab.
