# Zip 356 - KCB payment fix, product sort button, appealing invoices, barcode switch, money/stock guards, popups, Aqua, hospital

## What changed
0. **KCB (Buni) M-Pesa prompt fixed.** Four faults, all on the server (`functions/api/mpesa-stkpush.js`):
   - Login: `grant_type` is now sent in the form body (KCB's live login server ignored it in the address and refused correct keys); keys pasted with spaces are trimmed.
   - Live address: pushes went to `buni.kcbgroup.com`, KCB's developer portal web page. They now go to the API gateway `api.buni.kcbgroup.com` (the old address is tried only if the gateway answers like a web page).
   - `messageId` header was 36 characters; KCB allows 32.
   - Shared paybill: sent in KCB's documented shape (`orgShortCode` / `orgPassKey` empty, `invoiceNumber` = `<your KCB account or Till>-<reference>`). The Settings box was ticked by default, so shops with their own Till were sent as shared. Now the Pass Key decides: no Pass Key = shared paybill 522522 into your number; Pass Key = your own Till.
   - After deploy: Settings > Payment Gateway > KCB: Environment = Production (only after KCB go-live), number = your KCB Till or account, Pass Key EMPTY unless KCB gave you one, Save, test with KES 1-10. Guide: `docs/GUIDE_350_KCB.md`.
1. **⇅ Sort button on the Sales Counter (every module).** The green 💰 Sales button next to the search box is replaced by a Sort button:
   - Shop, Hotel, Hospital, Pharmacy, Production, Services: one tap switches the product pictures between **🔥 Most sold** and **🔤 A–Z**.
   - Aqua: **💧 By size → 🔤 A–Z → 🔥 Most sold**.
   - Remembered on each device. The Daily Sales totals are still there: Settings > View > "Keep open" pins them on the counter.
2. **Barcode on receipts stays OFF when switched off.** Two causes fixed: (a) a switch changed on a device with no sync baseline went to the server without a change stamp and the server ignored it, so the next sync turned the barcode back on; (b) in a branch group with SHARED receipt settings the main branch never re-published these switches, so the old shared copy (barcode ON) kept coming back. Both fixed for every receipt switch (barcode, reference, VAT, stamp, signatures, customer phone/ID).
   - If you use shared receipt settings across branches: on the MAIN branch open Settings > Receipt once and set the Barcode switch the way you want; it is pushed to every branch.
3. **Money / stock guards.**
   - A delivery (pay-on-delivery) payment can no longer be recorded twice (second tap or a second till): the order must still owe money.
   - New cross-check test rings up a full day in every till (cash, M-Pesa, split, void) and compares the sales lines, the payments, Daily Sales, Profits and the stock movement log: every shilling and every unit counted once.
4. **Invoices redesigned (all modules).** One clean full-page look: logo and business details on a textured header, "Bill to" and "Details" cards, a striped item table, a "How to pay" box (your Paybill / Till / bank lines), totals and a big Amount Due, payment history, thank-you footer. Prints, saves as PDF and shares from the same window as before. Used by:
   - Customer > Generate invoice (all modules).
   - Bills tab: new **📄 Invoice** button next to 🖨️ Print (all modules; contracts too).
   - Aqua > Price List & Invoices.
   - Hotel > Events / custom orders invoice (pro-forma until completed).
   - Services > job payment drawer: new **📄 Invoice** button.
   - Hospital > Inpatient account (interim / final bill).
   - 58 / 80 mm roll printers still get a text version.
5. **CRM / Chama no longer shows up.** They were removed from the code long ago (zips 186 / 269), but robocopy never deletes files, so the old `chama`, `crm` (and `school`) files in C:\dev\mydukapos were uploaded with every deploy. Each zip now carries `tools\release-files.json`; the deploy uploads only the files of this release (plus your own wrangler*.toml) and lists the old files it left out. The last mentions of "Leads" in the Owner Console wording are gone.
   - Bonus: your local `backup\` folder (db:backup output) is no longer uploaded to the website either.
6. **Aqua opens where you last worked.** A device last used in Production (a production staff member signed in, or the admin switched to Production) opens in Production again. The plain link still lists everyone on "Who's logging in?", and a staff member still lands on their own site.
7. **Hospital patient edit.**
   - Editing no longer blanks Sex or Blood type when the stored value is not one of the list's words (e.g. "F", "male", "o+" from an import): it is matched or kept.
   - The "Registered, not sent on yet" chips on Reception now show the edited name at once (they kept the old name, so the edit looked lost).
   - New end-to-end test: edit -> server -> second till -> refresh.
8. **Pop-ups behind other pop-ups.** The pop-up opened last is always in front (e.g. Owner Console > client > 🔑 Reset password opened BEHIND the client window). Works in every app and the Owner Console; sign-in and lock screens are never covered.

No database migration.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip356
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_kcb-sort-invoices_356_11062029.zip" -C C:\dev\zip356

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip356 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
13. node --test tests\zip356-kcb-fix.test.mjs tests\zip349-kcb-buni.test.mjs
    (the end must say: fail 0)
14. node --test tests\zip262-customer-ledger.test.mjs
    (the end must say: fail 0)
15. node --test tests\zip356-money-crosscheck.test.mjs
    (the end must say: fail 0 - takes a few minutes)

PART E - back up, database, deploy
16. npm run db:backup
17. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (this zip has no new migration: it should say there is nothing to apply)
18. npm run deploy:router
19. npm run deploy:fast
    (the deploy prints "Old files from earlier releases left out of the upload" with the list - that is expected)

PART F - after deploy (once)
20. Owner Console / each shop: hard-refresh once (Ctrl+F5) so the new version loads.
21. KCB shops: Settings > Payment Gateway > KCB > check Environment, the Till / account number and the Pass Key (empty unless KCB gave you one) > Save KCB Credentials > send a KES 10 test prompt to your own phone.
22. Branch groups with shared receipt settings: on the MAIN branch, Settings > Receipt > set "Barcode" as wanted (tick then untick to force it out).
