# Deploy zip 350 - KCB Buni STK push fix
Changed: functions/api/mpesa-stkpush.js (server side only). Service worker: zip-350.
**No database migration.** Nothing here was deployed by me to your live Cloudflare account.
All commands are Windows cmd. Run them ONE at a time, in order: paste one line, press Enter, wait, then the next.

PART A - unpack
1.  mkdir C:\dev\zip350
2.  tar -xf "%USERPROFILE%\Downloads\ZIPNAME.zip" -C C:\dev\zip350
    (replace ZIPNAME.zip with the exact file name of the zip I gave you)

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip350 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
    (must print: Router forwards shop addresses to: mydukapos-3ao.pages.dev. If not, STOP.)
7.  npx wrangler whoami

PART C - check and test
8.  npm install
9.  npm run check
10. node --test tests\zip349-kcb-buni.test.mjs
    (the end must say: fail 0)

PART D - back up and deploy
11. npm run db:backup
12. npm run deploy:fast

PART E - try it on the LIVE site (read docs\GUIDE_350_KCB.md first)
13. Settings > payment gateway > KCB Buni. Check Environment (Sandbox vs Production) matches where your Consumer Key/Secret were created, and the Till number is filled in.
14. Send a small STK push (KES 1-10) to your own phone.
15. If it still fails, the red message now names the cause. Send me that exact message.
