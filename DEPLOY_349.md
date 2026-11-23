# Deploy zip 349 - Restock fix (stock now says clearly when nothing was added)
Apps changed: Shop, Hotel, Hospital, Production, Services (the Restock tab). Service worker: zip-349.
**No new database migration.** Web + functions deploy only. Nothing here was deployed by me to your live Cloudflare account.
All commands are Windows cmd. Run them ONE at a time, in order: paste one line, press Enter, wait for it to finish, then the next. No File Explorer needed.

PART A - unpack
1.  mkdir C:\dev\zip349
2.  tar -xf "%USERPROFILE%\Downloads\ZIPNAME.zip" -C C:\dev\zip349
    (replace ZIPNAME.zip with the exact file name of the zip I gave you)

PART B - copy into the work folder and lock the CORRECT account
3.  robocopy C:\dev\zip349 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
10. node --test tests\zip349-restock-nothing-stocked.test.mjs
    (the end must say: fail 0)

PART D - back up and deploy
11. npm run db:backup
12. npm run deploy:fast

PART E - try it on the LIVE site
13. Open each app once, then refresh once, so it updates to zip-349 (every phone and till).
14. Restock tab: type the MAIN name of an item that has variants (for example "Polo") with a quantity and cost, then press Complete Restock. You must now see a RED message "has variants: restock each variant with its own code", no "Restock recorded", and the row stays on screen.
15. Change the row to a variant code (for example Polo - Red) and press Complete Restock again. The stock goes up and the green "Restock recorded" message appears.
Beginner guide: docs\GUIDE_349.md. If anything looks wrong, tell me the step number and what the screen said.
