# Zip 368 - public barcode + Online Orders tab in every app, and the stock "Refresh" safeguard; plus everything in zip 367 and earlier

## What is new
1. **A public barcode (QR sign) in every shop app** (Shop, Water, Hospital pharmacy counter, Production, Services, Pharmacy, Car wash) - the same idea as the hotel one. Customers scan it, see what you sell, and send an order from their own phone. The hotel and owner apps are unchanged.
2. **New tab: Online Orders.** Every order that comes in through the barcode appears here with the customer's name, place, notes and items. Tap **Accept** (only one till can win), **Load into Sales Counter**, take payment the normal way, and the order is marked paid by itself.
3. **Everything is published to the barcode by default.** Items with a price and stock are put on the barcode menu automatically. Archived, out-of-stock, no-price items are left out. Hospital and Pharmacy never publish prescription-only medicines, and the Hospital never publishes services.
4. **Stock mismatch between Admin and a staff login on the same phone.** The phone can hold unsent changes (slow line, refused push). In that state it used to never ask the server for stock, so its numbers stayed old. It now asks (quantities only - your unsent work is never wiped) when the login changes, when the Sales Counter opens, every minute while it is stuck, and when you press **Refresh stock** on the slim bar above the Sales Counter. The bar also tells you "this phone has changes waiting to send".
   *Honest note:* I could not reproduce the exact original mismatch in testing; the safeguard above removes the one cause I found (a stuck phone never asking). If numbers still differ after you press **Refresh stock**, tell me which items and I will trace those.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip368
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_public-barcode_368_11151536.zip" -C C:\dev\zip368

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip368 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - check and test
8.  npm install
9.  npm run check
    (it must say: All apps match src/shared/)
10. node --test --test-concurrency=1 tests\zip368-public-order.test.mjs
    (the end must say: fail 0 - takes about 3 minutes)
11. node --test --test-concurrency=1 tests\zip368-stock-refresh.test.mjs
    (the end must say: fail 0)

PART D - back up, database, deploy
12. npm run db:backup
13. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply. The orders table already exists.)
14. npm run deploy:router
15. npm run deploy:fast

PART E - after deploy
16. Each device: hard-refresh once (Ctrl+F5); installed apps update on their next start.

## Guide: using the barcode and Online Orders (for beginners)
1. Open the app > **Online Orders** tab (under Sell in the side menu). The first time, tap **Make the code now**. The QR sign appears with your shop's public link.
2. Tap **Print the sign** (or **Picture** / **Share on WhatsApp**) and stick it at the counter or on bags. Customers scan, pick items, enter name and place, and send.
3. When an order arrives the tab shows a number badge. Open it: you see the name, place, notes and items.
4. Tap **Accept**. If two tills tap at once, only one gets it - the other is told it is taken.
5. Tap **Add to sale**. The items go into the Sales Counter cart with the customer's name shown. Check stock, then take payment as normal (cash, M-Pesa, card).
6. After the sale is saved, the order becomes **Paid** automatically. To refuse an order, tap **Decline**.
7. Settings in the tab: **Taking online orders** off pauses the barcode (customers see "please ask the shop"). Tap **Save & publish** after changing; **Publish items now** re-sends your items.
8. Stock: if numbers on a phone look different from another phone, tap **Refresh stock** above the Sales Counter grid.
9. Staff see the tab only if you give it in their role (Settings > staff roles > Online Orders).
