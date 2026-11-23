# Zip 360 - Receipt layout: Standard or Detailed; 💰 Sales button back with a ↓ Sort button; plus everything in zip 359 / 358

Contains everything from zip 359 (Hotel order delivery confirmed), 358 (Till payments fix, Till health, phone layouts), 357 and 356. If you skipped any of them, this one deploys them too.

## Sales Counter: 💰 Sales button is back
- The green **💰 Sales** button (the day's Total / Cash / M-Pesa) is back on the Sales Counter in every app, on desktop and phone.
- The Sort button now sits **right after it** and is just a **↓** arrow. Each tap switches the product order (Most sold → A–Z; Aqua: By size → A–Z → Most sold) and says which order is on; holding / hovering shows it too. Remembered per device.
- Settings > View > "Hide the 💰 Sales button" still works as before.

## Receipt layout (new, every till app: Shop, Hotel, Hospital, Pharmacy, Production, Services, Aqua)
Settings > Receipts > **🧾 Receipt layout**:
- **Standard** - the receipt you have now (unchanged, byte for byte).
- **Detailed** - a boxed document like the printed quotation sample: document title, company name in bold, address / phone / email / PIN, a details table (Branch, Doc No, Date & Time, Order, Served By, Customer, phone / ID, Remarks), numbered items (code underlined, name, VAT %, price × qty, bold total), Total Breakdown (amount excl. VAT, VAT, big double-underlined TOTAL), payment, Prepared By, Please note / terms, payment details (Paybill / account) in bold, thank-you lines, contact line, NOTES, reference / barcode and "XX - END - XX".

What to fill in for the Detailed layout:
1. Settings > Receipts (top part, already there): business name, extra info (address lines), phone, email, KRA PIN, payment details (Paybill / Till / account), footer notes (printed as NOTES).
2. Settings > Receipts > Receipt layout > Detailed: document title (optional), branch name, please note / terms, thank-you message, contact line, show item codes, show VAT % per item, END mark > 💾 Save layout texts > 👁️ Preview.

Works everywhere a receipt goes: screen, system print, PDF, USB and Bluetooth thermal printers, 58 mm and 80 mm. Every switch (reference, barcode, VAT, stamp, PAID / UNPAID, signature area, eTIMS, loyalty) works in both layouts. The choice syncs to every till and, with shared receipt settings, every branch. If the Detailed layout ever cannot be built, the Standard receipt prints instead - a sale never goes without a receipt.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip360
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_receipt-layout-sales_360_11071958.zip" -C C:\dev\zip360

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip360 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
13. node --test tests\zip360-receipt-layout.test.mjs tests\zip359-order-delivery.test.mjs tests\zip358-till-health.test.mjs
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
