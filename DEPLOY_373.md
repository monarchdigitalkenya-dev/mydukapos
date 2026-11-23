# Zip 373 - Invoicing in every app, client statements, reconciliation, bigger payable total, default currency

## What is new
1. **🧾 Invoicing tab** in Shop, Aqua (water), Hotel, Hospital, Production, Services, Pharmacy, Car Wash **and the Owner Console** (Money / Finance folder, or the tab bar).
2. **Currencies**: KES is the default. Pick another currency on any invoice (USD, EUR, GBP, UGX, TZS, RWF, ZAR, AED, INR, CNY, or add your own in Settings). Each invoice keeps the rate it was made with.
3. **Default currency**: Invoicing > Settings > "New invoices use ...". Also "Also show Sales Counter totals in ..." puts a second-currency amount under the payable total.
4. **Tax choice per invoice**: No tax / Add tax on top / Tax is already in the prices. Tick or untick VAT per line. Discount as an amount or a percent.
5. **A presentable A4 invoice**: logo, big "amount due" band, PAID / VOID stamp, how-to-pay box, notes and terms, your choice of colour.
6. **Print, Save PDF, Share** (phone share sheet, WhatsApp, e-mail) or copy as text.
7. **Payments** on each invoice (M-Pesa, cash, bank...), part payments, status Paid / Part paid / Overdue.
8. **Clients & statements**: opening balance, invoices, payments, closing balance, ageing; "Receive payment" settles the oldest invoice first and keeps any extra as credit.
9. **Reconcile**: who owes what by age (1-30, 31-60, 60+ days), and a matcher: paste your M-Pesa / bank statement lines and the app ticks the payments that really arrived (by M-Pesa code, else amount + date) and shows what is missing either way.
10. **Desktop Sales Counter**: the payable total is much bigger.

## How to use it (beginner guide)
- Open **Invoicing**. Press **New invoice**. Type the client (saved customers auto-fill). Add lines: description, quantity, price. Choose tax. Press **Save & preview / share**.
- To get paid: open the invoice from the list, **Record payment** (or on the Clients screen, **Receive payment**).
- To send a statement: **Clients & statements**, pick the client, **Preview / print / share**.
- First time: open **Settings** and check the exchange rates (they are starting guesses, marked "check this rate") and add your business name / payment details if Settings > Receipt is empty.

## Honest notes
- Sales stay in KES in your books and reports. Only invoices use other currencies; the Sales Counter shows the second currency as a guide line.
- The PDF is a picture of the invoice made by your browser. If a device cannot make it, the app falls back to a plain-text PDF; Print > "Save as PDF" always gives the full design.
- Invoices sync between devices with your shop settings (newest edit wins per invoice). In the Owner Console they stay on that computer.
- Exchange rates are typed by you; the app does not fetch live rates.
- I could not test on a real phone, printer or WhatsApp here; tests cover the maths, matching, saving and the tab in all nine apps.

## APK (Android) - rebuild
The Android apps are a shell around the website, so Invoicing arrives by the normal deploy below (just close and reopen the app). A new APK is only needed for the new version number (1.1.0, code 2) and any native change.
I cannot build an APK in my workspace (no Android SDK). Build on your PC, all in cmd:
A1.  Install once: JDK 17 and Android Studio (it installs the Android SDK). Set the SDK folder: setx ANDROID_HOME "%LOCALAPPDATA%\Android\Sdk"  (then open a NEW cmd window)
A2.  cd /d C:\dev\mydukapos\native\android
A3.  echo sdk.dir=%LOCALAPPDATA:\=\%\Android\Sdk> local.properties
A4.  gradlew assembleRelease
A5.  dir app\build\outputs\apk\shop\release   (and hotel, hmis, production, pharmacy, services, aquapos, owner)
     Unsigned files end in -UNSIGNED.apk: Android will not install those. Sign them with your key (see native\README.md "Signing"), or push to GitHub and let Actions build the signed APKs (artifact "mydukapos-android").
A6.  To install one on a connected phone: adb install -r app\build\outputs\apk\shop\release\<file>.apk

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip373
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_invoicing_373_11161555.zip" -C C:\dev\zip373

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip373 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - check and test
8.  npm install
9.  npm run check
    (it must say: All apps match src/shared/)
10. node --test --test-concurrency=1 tests\zip373-invoicing.test.mjs
    (the end must say: fail 0)

PART D - back up, database, deploy
11. npm run db:backup
12. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
13. npm run deploy:router
14. npm run deploy:fast

PART E - check
15. Open the app, press Ctrl+Shift+R, open Invoicing, make one invoice, and add an item to the Sales Counter cart to see the bigger total.
