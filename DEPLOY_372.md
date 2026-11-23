# Zip 372 - handheld POS: Print prints the receipt, not the page

## What was wrong
On a handheld terminal (Android app), Print only used the terminal's built-in printer after you had chosen it by hand in Settings > Install App. Until then the app handed the screen to Android's "print the page" dialog, so you got the page.

## What changed
1. A handheld with a built-in printer that has never had a printer or print mode chosen now picks the **built-in printer by itself** when the app opens (silent: no test print, no paper wasted; 58 mm width set if none). Print then sends the receipt straight to it.
2. If the built-in printer was saved but the print mode had fallen back to "system dialog", it is put back on the built-in printer.
3. Your own choices are never overridden: another Bluetooth printer, or "system dialog" chosen on purpose, stay as they are.
4. When the Android print dialog is used anyway (no built-in or Bluetooth printer), the receipt, report and kitchen slip are now isolated with plain rules too, so the dialog gets only the slip.

## Honest notes
- I could not test on your real terminal. The tests simulate the Android app and prove the receipt goes to the built-in printer and the page is not sent. Please print one receipt on the handheld after updating.
- This changes the web app only, so there is NO new Android install: the app loads it from the server. If a handheld still prints the page, open Settings > Install App > "Use this terminal's built-in printer" once and tell me what the printer panel says.
- Hand-held terminals with a different brand of printer service (not the built-in Senraise one) still need a paired Bluetooth printer chosen in Settings.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip372
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_handheld-print_372_11161450.zip" -C C:\dev\zip372

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip372 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - check and test
8.  npm install
9.  npm run check
    (it must say: All apps match src/shared/)
10. node --test --test-concurrency=1 tests\zip372-handheld-print.test.mjs
    (the end must say: fail 0)

PART D - back up, database, deploy
11. npm run db:backup
12. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
13. npm run deploy:router
14. npm run deploy:fast

PART E - on the handheld
15. Close the MyDukaPOS app fully and open it again (it loads the new version). Wait about 3 seconds, then make a test sale and tap Print.
