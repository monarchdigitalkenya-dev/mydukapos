# Deploy zip 322 - shops refused for the 0000 password sync again + orange dot watchdog (includes everything from 304 to 321)

Zip 322: a shop created from 12 Oct 2026 with the password 0000 was refused on every sync ("server refused", orange dot); its sales now sync and the owner is asked to choose another password. Also: a shop stuck on the orange dot while online retries by itself every 3 minutes and reports WHY to the Owner Console's Errors tab. No database change. The router does not need deploying for this zip (deploy it only if you have not deployed zip 315 or later yet).
Service worker version: zip-322.

All commands are Windows cmd. Run them one at a time, in order.

## PART A - START: unpack the zip
1. mkdir C:\dev\zip322
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_322.zip" -C C:\dev\zip322
## PART A - END

## PART B - START: copy into the work folder (keeps the wrangler files already pointing at your account)
3. robocopy C:\dev\zip322 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
   (robocopy exit codes 0 to 7 are success - only 8 or higher is an error)
4. cd /d C:\dev\mydukapos
5. node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57321-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6. node tools\switch-account.mjs --show
   (must print: Router forwards shop addresses to: mydukapos-3ao.pages.dev - if not, STOP)
## PART B - END

## PART C - START: check and deploy
7. npm install
8. npm run check
   (must say: All apps match src/shared/. then cards in sync then owner pro in sync)
9. npm run deploy:fast
## PART C - END

## PART D - START: confirm and read the result
10. Open each app once (Shop, Hotel, Hospital, Pharmacy, Production, Services, Water, Owner Console) so the service worker updates to zip-322; close and reopen once if it still shows the old version.
11. On a shop that was stuck orange: within about 3 minutes it sends and fetches by itself. If it stays orange, open the Owner Console > Errors tab: look for "Sync dot stuck orange - online but orange | ..." The words after the bar are the cause, and the details line holds the evidence. Send me that line.
## PART D - END

Rollback (Pages): Cloudflare dashboard -> Workers & Pages -> mydukapos-3ao -> Deployments -> previous Production deployment -> Rollback.
