# Zip 359 - Hotel orders: delivery to the kitchen / bar confirmed and resent quietly; plus everything in zip 358 (Till payments fix, Till health, phone layout)

Contains everything from zip 358, 357 (Extra Sales, Hotel orders, MD icons) and 356. If you never deployed 358, this one deploys it too.

## Zip 359 - Hotel orders reaching the kitchen / bar
- Posting from **Service Orders** (and the Sales Counter "Add This Order to Tab" / 🧾 Tab) now says **"📤 Order for Table 05 sent — waiting for the kitchen / bar…"**, then **"✅ Kitchen / bar have Table 05's order."** only once the server has accepted it. Before, it said "the kitchen / bar have it" the moment Post was tapped, even if the send then failed.
- If a send fails, **no message** is shown: the normal sync keeps sending by itself, and a spaced extra nudge (20 s, 40 s, then every 60 s, only when no other send is running or waiting, never inside the sync's own back-off) makes sure the order goes as soon as the server takes it. It never sends anything that is not already waiting to go, so it adds no extra server (KV) writes.
- Tested end to end with 4 devices (waiter phone, kitchen screen, bar screen, cashier) on the real sync code: kitchen board 5-7 s, bar 5 s, the cashier's 🍽️ Orders list 11 s; and with the server refusing for 30 s: no message, a handful of sends, delivered automatically when the server came back.

## Why direct Till payments were not showing (what was found)
A customer paying the Till from the phone menu reaches the system only if Safaricom calls our confirmation address. Four places could lose it with NO error anywhere:
1. **Old address still registered at Safaricom.** Production lets each number register its addresses ONCE. Pressing "Register" again changes nothing (Safaricom answers "already registered") and keeps sending to the first address - an old one (e.g. containing "mpesa", which Safaricom's production system silently drops) or one with an old/no shop key.
2. **Wrong number.** For a Buy Goods Till the live Daraja app usually belongs to the STORE / Head Office number, not the number on the Till sticker. The system registered the Till number first and stopped there.
3. **Callbacks held in a hidden bucket.** A notice whose shop key did not match (old address) was kept where no screen showed it; a notice that carried no shop id was acknowledged and dropped.
4. **Cloudflare Bot Fight Mode** answers Safaricom's server call with a challenge page, so the payment never reaches the app and nothing is logged. A WAF skip rule cannot bypass Bot Fight Mode.

## What changed
1. **New callback address** `/api/pcb/<shop>/<key>/c` - shop and key in the path, no query string, no forbidden words (mpesa, safaricom, query, exe, cmd, sql). The old address keeps working for shops still registered with it.
2. **Register Till URLs** now registers BOTH numbers (Store / Head Office first, then the Till), on C2B **v2** first (v1 if the app only has v1), and shows what Safaricom answered for each number.
3. **Nothing is dropped any more:** a notice with an old key, or with no shop in its address (matched by its Till / Store number), is **HELD** and shown to the owner, who checks it on the M-PESA statement / SMS and presses **Accept** (management password) - it then appears in Till Payments as usual - or **Dismiss**.
4. **🩺 Till health** (Settings > Payment Gateway under the Register button, and the 🩺 Health chip in Till Payments): working / waiting / needs attention, what to do, registered numbers, held payments, the last notices from Safaricom.
5. **⟲ Recover missed payments** (Safaricom Pull Transactions API): asks Safaricom for the Till's payments of the last 6 / 24 / 48 hours (48 h is Safaricom's limit) and adds any that are missing, never twice. Needs the "Pull Transactions" product on the live Daraja app; the first time it asks for the business phone number.
6. **Calmer POS screen:** the big top banner is now a one-line snackbar at the bottom-left (name, code, amount, **Match**, ✕; several payments show "+N more"); the checkout button just says **📲 Till** with a count; a payment equal to the sale on the counter is tagged **= CART TOTAL** and listed first (the cashier still confirms).
7. **Extra Sales in the Owner Console** too (Daily Sales tab) - all 8 apps now have it.
8. **Phone layout fixes:**
   - Staff > Registration numbers, licences & contacts (every app): on a phone the Number box slid under the Valid until box. Each row is now two lines on a phone (Kind + Number, then Valid until + ✕).
   - Hotel > Inventory > dish sizes: the row ran off a phone screen. Now: size name on its own line, then Price / Recipe × / Cost (each labelled) + ✕.

No database migration (the Till table is created automatically, as before).

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip359
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_order-delivery_359_11071801.zip" -C C:\dev\zip359

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip359 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
13. node --test tests\zip359-order-delivery.test.mjs tests\zip358-till-health.test.mjs
    (the end must say: fail 0)
14. node --test tests\zip357-extra-sales.test.mjs tests\zip357-hotel-orders.test.mjs
    (the end must say: fail 0)
15. node --test tests\zip250-daraja-callback-urls.test.mjs tests\zip262-c2b-register.test.mjs tests\zip259-till-payments.test.mjs
    (the end must say: fail 0)
16. node --test tests\zip269-kitchen-bar-screens.test.mjs tests\hotel-post-order-visible-293.test.mjs tests\zip269-dish-sizes.test.mjs
    (the end must say: fail 0)

PART E - back up, database, deploy
17. npm run db:backup
18. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
19. npm run deploy:router
20. npm run deploy:fast
    (it prints "Old files from earlier releases left out of the upload" - expected)

PART F - Cloudflare dashboard (once, in the browser - this is where Safaricom gets blocked silently)
21. Cloudflare dashboard > your domain (mydukapos.store) > Security > Bots: turn **Bot Fight Mode OFF**.
    (on a Pro plan with Super Bot Fight Mode instead: Security > WAF > Custom rules > Create rule: "URI Path starts with /api/pcb/" OR "URI Path starts with /api/pay-cb-" > Action: Skip > tick all remaining custom rules, rate limiting, managed rules, Super Bot Fight Mode, Browser Integrity Check, Security Level > Deploy)
22. Cloudflare dashboard > Security > Events: filter Path contains /api/pay-cb or /api/pcb - there must be NO blocked / challenged POSTs. If there are, fix step 20 first.

PART G - each Daraja shop (once per shop, from that shop's link)
23. Settings > Payment Gateway > check: Environment = PRODUCTION, Till number = the number on the sticker, Shortcode = the STORE / Head Office number, then Save.
24. Look at the new **🩺 Till health** box under "Register Till URLs". If it shows HELD payments: check each on the M-PESA statement / SMS > Accept (or Dismiss).
25. Delete the OLD addresses at Safaricom: an M-PESA Business Administrator logs in to the M-PESA org portal / Daraja > Self Services > URL Management > delete the C2B URLs for the Store number AND the Till number (or email apisupport@safaricom.co.ke asking to delete the C2B URLs for those numbers).
    (skip this step if Till health shows no held payments AND says "Working")
26. Press **Register Till URLs with Safaricom**. The message lists each number: ✅ registered, or "already registered" (= step 24 not done yet for that number).
27. Pay KES 10 to the Till from a phone. Within a minute Till health must say **Working - last payment notice ... s ago** and the payment appears in Till Payments.
28. Missed payments from the last 48 hours: Till Payments > 🩺 Health > Recover missed payments > Last 48 hours > (first time: business phone) > ⟲ Recover.
    (if it says the Pull Transactions product is missing: Daraja portal > Go Live / your live app > add "Pull Transactions", then try again)

PART H - after deploy
29. Each device, INCLUDING the kitchen and bar screens: hard-refresh once (Ctrl+F5); installed apps update on their next start.
30. Shops still registered with an address without a shop key keep working until 2026-12-01 only - do PART G for them before then (Till health warns about it).
