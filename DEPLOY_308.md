# Deploy zip 308 - Kitchen orders without the wait (includes everything from 304 to 307)

What changed (details: CHANGELOG.md): a posted order reaches the kitchen / bar screen in seconds even when the instant push is missed (was ~28 s).
From zip 307 (see docs/WEBSITE_REPORT_307.md): the public website now says only what the product really does (eTIMS, M-Pesa,
pricing, offline, testimonials), with a shorter home page: demos first, one pricing section, an honest offline section. From zip 306: devices with a working live connection ask "anything new?" over that connection instead of over HTTP
every 30 s, and pull only when something really changed; licence lookups use Cloudflare's free edge cache. Sales, restocks and stock sync
exactly as before (instant push unchanged; every fallback is the old polling).

IF YOU HAVE NOT DEPLOYED ZIP 306 OR 307 YET, THE ROUTER MUST BE DEPLOYED (step 22; safe to run again anyway): the shop database tells the live-sync room about every change. `npm run deploy:router` adds
the one setting it needs (SYNC_ROOM) to wildcard-router\wrangler.toml by itself - your account ids are not touched. No new database tables.
Service worker version: zip-308.

All commands are Windows cmd. Run them one at a time, in order. Every part says where it starts and ends.

## PART A - START: unpack the zip
1. mkdir C:\dev\zip308
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_308.zip" -C C:\dev\zip308
3. cd /d C:\dev\zip308
## PART A - END

## PART B - START: copy into the work folder (keeps the wrangler files already pointing at your account)
4. robocopy C:\dev\zip308 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
   (robocopy exit codes 0 to 7 are success - only 8 or higher is an error)
5. cd /d C:\dev\mydukapos
6. node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
7. node tools\switch-account.mjs --show
   (must print: Router forwards shop addresses to: mydukapos-3ao.pages.dev - if not, STOP)
## PART B - END

## PART C - START: back up the owner database before the change
8. if not exist backup mkdir backup
9. npx wrangler d1 export mydukapos-owner --remote --output=backup\owner-before-308.sql
   (a copy of the owner database as it is now; keep it until you have checked the Money tab)
## PART C - END

## PART D - START: databases and storage (create steps are safe to repeat - "already exists" is fine, just carry on)
10. npx wrangler kv namespace create mydukapos_kv
11. npx wrangler d1 create mydukapos-ledger
12. npx wrangler d1 create mydukapos-audit
13. npx wrangler d1 create mydukapos-owner
14. npx wrangler r2 bucket create mydukapos-media
15. npx wrangler r2 bucket create mydukapos-audit-archive
16. npx wrangler r2 bucket create mydukapos-db-backups
17. npx wrangler d1 execute mydukapos-owner --remote --file=sql\owner-db\0002_money.sql
    (creates owner_money and owner_money_log; safe to run again)
18. npx wrangler pages project create mydukapos-3ao --production-branch=mydukapos
    (if it says the project already exists, carry on)
19. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (nothing new to apply in this zip - safe to run)
## PART D - END

## PART E - START: check and deploy
20. npm install
21. npm run check
    (must say: All apps match src/shared/. then cards in sync then owner pro in sync)
22. npm run deploy:router
    (first line printed: "wildcard-router\wrangler.toml: added the SYNC_ROOM binding" or "... SYNC_ROOM binding present"; then the bindings
    list must include env.SYNC_ROOM (SyncRoom). If wrangler asks nothing and says Deployed, carry on)
23. npm run deploy:fast
    (use npm run deploy instead if you also want the full test run before upload; it takes a long time)
## PART E - END

## PART F - START: confirm
24. Open https://<any-shop>.mydukapos.store/api/health once, then open each app (Shop, Hotel, Hospital, Pharmacy, Production, Services, Water, Owner Console) so the service worker updates to zip-308 (close and reopen the app once if it still shows the old version).
25. Kitchen check: on the kitchen device open Kitchen Orders (or the full kitchen screen). On a waiter phone post an order: it appears on the kitchen screen within a few seconds. Post three more in a row: each appears.
26. Turn Wi-Fi off on the kitchen device for 20 s while a waiter posts an order, then turn it back on: the order appears within a few seconds of reconnecting.
27. Home page https://mydukapos.store/ (from zip 307): the headline reads "A POS built for the way Kenyan businesses work."; Pricing matches Owner Console > Billing.
28. Owner Console > Website > Testimonials (from zip 307): tick only genuine ones, then Save & Publish.
29. Two devices on the SAME shop link (from zip 306): a sale and a restock of 2 on A show on B, and stay the same after a reload.
## PART F - END

Rollback (Pages): Cloudflare dashboard -> Workers & Pages -> mydukapos-3ao -> Deployments -> previous Production deployment -> Rollback.
backup\owner-before-308.sql is the owner database as it was before.
Rollback is safe in any order: an older app simply ignores the new room answers, and an older router simply does not answer them (devices then use the 30 s HTTP check as before).
