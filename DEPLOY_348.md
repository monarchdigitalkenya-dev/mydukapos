# Deploy zip 348 - Aqua simplified: materials by size, 9-step Production with a water tank, client default bottles, Price List & Invoices
Apps changed: Water (Aqua POS) only (every app got the shared sync list update). Service worker: zip-348.
**No new database migration.** Web + functions deploy only. Nothing here was deployed by me to your live Cloudflare account.
All commands are Windows cmd. Run them ONE at a time, in order: paste one line, press Enter, wait for it to finish, then the next. No File Explorer needed.

PART A - unpack
1.  mkdir C:\dev\zip348
2.  tar -xf "%USERPROFILE%\Downloads\ZIPNAME.zip" -C C:\dev\zip348
    (replace ZIPNAME.zip with the exact file name of the zip I gave you)

PART B - copy into the work folder and lock the CORRECT account
3.  robocopy C:\dev\zip348 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; only 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
    (must print: Router forwards shop addresses to: mydukapos-3ao.pages.dev. If not, STOP.)
7.  npx wrangler whoami
    (must show the Cloudflare account that owns mydukapos-3ao.pages.dev)

PART C - check and test
8.  npm install
9.  npm run check
    (must say: All apps match src/shared/, cards in sync, owner pro in sync)
10. node --test tests\zip348-aqua-flow.test.mjs
    (the end must say: fail 0)

PART D - back up and deploy
11. npm run db:backup
12. npm run deploy:fast

PART E - try it on the LIVE site (use a test shop first)
13. Open the Water app once, then refresh once, so it updates to zip-348 (every phone and till).
14. Switch the top site switch to Production. Open Materials > "Import CSV" > choose templates\aqua_materials_sample.csv (it is in C:\dev\mydukapos\templates). Press "Import now". 26 materials appear.
15. Fill in the missing prices (Hexa plain 1000ml, Grip plain 1500ml, the Hexa clear/blue bottles, 5/10/18.9/20 litre bottles) by pressing Edit on each. Add stock with Restock.
16. Materials > "Client bottles" > Import CSV > templates\aqua_client_bottles_sample.csv.
17. Production tab > "New production tank" (or Add water) so the tank has water. Then follow the 9 steps and press Record production.
18. Price List & Invoices tab: print a price list, make one invoice.
Beginner guide: docs\GUIDE_348.md. If anything looks wrong, tell me the step number and what the screen said.
