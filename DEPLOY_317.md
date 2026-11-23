# Deploy zip 317 - Variant expiry dates (includes everything from 304 to 316)

Zip 317: each variant has its own optional expiry date (Add New Items and the edit variants window); editing variants no longer wipes their attributes / barcode / photo.
Zip 316: faster Shop start-up, the Cloudflare security check no longer shown as "link not active", Business HQ dialog fits at 80% scale, website fixes; every test passes.
Zip 315: a phone stuck on "Syncing" catches up by itself (smaller fetches, a jammed send is released). THE ROUTER MUST BE DEPLOYED THIS TIME (step 23): the shop database code changed. No database migration.
Zip 314: Inventory > "Export / Import products & variants": one file, one row per product or variant (any attributes), imported back without losing anything; a separate Batches & expiry file. No database change.
Zip 313: receipts show tokens earned and the token balance (Settings > Loyalty switch, on by default); Business HQ has its own line in the side menu.
Zip 312: searching "socks" now lists every sock (in stock first, up to 60, with a note when there are more), and words work in any order ("socks h&f").
Zip 311: the Business HQ button stays in the Staff tab; Stock is one list per branch with Move / Send to branch / + Store on each item; transfers go out at once (approvals off unless you turn them on); every dialog has its ✕ at the top and its buttons at the bottom.
From zip 310 (details: CHANGELOG.md and docs/MULTIBRANCH_310.md): Business HQ has Stock (stores per branch, move
stock between a store and the shop floor), Transfers between branches (approve, dispatch, receive with damaged / missing, settle), Reports
(consolidated or per branch, CSV) and Roles (templates and custom roles per person per branch). New tables in the transaction database (step 19
creates them). From zip 309: Business HQ (branches, staff across branches, HQ administrators, audit). From zip 308: kitchen orders show in seconds.
From zip 307: the honest public website. From zip 306: lower Cloudflare cost with the same sync.

IF YOU HAVE NOT DEPLOYED ZIP 306 OR LATER YET, THE ROUTER MUST BE DEPLOYED (step 23; safe to run again anyway).
Service worker version: zip-317.

All commands are Windows cmd. Run them one at a time, in order. Every part says where it starts and ends.

## PART A - START: unpack the zip
1. mkdir C:\dev\zip317
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_317.zip" -C C:\dev\zip317
3. cd /d C:\dev\zip317
## PART A - END

## PART B - START: copy into the work folder (keeps the wrangler files already pointing at your account)
4. robocopy C:\dev\zip317 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
   (robocopy exit codes 0 to 7 are success - only 8 or higher is an error)
5. cd /d C:\dev\mydukapos
6. node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
7. node tools\switch-account.mjs --show
   (must print: Router forwards shop addresses to: mydukapos-3ao.pages.dev - if not, STOP)
## PART B - END

## PART C - START: back up before the change
8. if not exist backup mkdir backup
9. npx wrangler d1 export mydukapos-owner --remote --output=backup\owner-before-317.sql
10. npx wrangler d1 export mydukapos-ledger --remote --output=backup\ledger-before-317.sql
    (copies of the owner and transaction databases as they are now; keep them until you have checked HQ and the Money tab)
## PART C - END

## PART D - START: databases and storage (create steps are safe to repeat - "already exists" is fine, just carry on)
11. npx wrangler kv namespace create mydukapos_kv
12. npx wrangler d1 create mydukapos-ledger
13. npx wrangler d1 create mydukapos-audit
14. npx wrangler d1 create mydukapos-owner
15. npx wrangler r2 bucket create mydukapos-media
16. npx wrangler r2 bucket create mydukapos-audit-archive
17. npx wrangler r2 bucket create mydukapos-db-backups
18. npx wrangler d1 execute mydukapos-owner --remote --file=sql\owner-db\0002_money.sql
    (creates owner_money and owner_money_log; safe to run again)
19. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (applies 0015_org.sql and 0016_stock.sql if not yet applied: stores, stock movements, transfers, approval rules, roles. If it asks "Ok to proceed?" answer y)
20. npx wrangler pages project create mydukapos-3ao --production-branch=mydukapos
    (if it says the project already exists, carry on)
## PART D - END

## PART E - START: check and deploy
21. npm install
22. npm run check
    (must say: All apps match src/shared/. then cards in sync then owner pro in sync)
23. npm run deploy:router
    (first line printed: "wildcard-router\wrangler.toml: added the SYNC_ROOM binding" or "... SYNC_ROOM binding present"; then the bindings
    list must include env.SYNC_ROOM (SyncRoom). If wrangler asks nothing and says Deployed, carry on)
24. npm run deploy:fast
    (use npm run deploy instead if you also want the full test run before upload; it takes a long time)
## PART E - END

## PART F - START: confirm
25. Open https://<any-shop>.mydukapos.store/api/health once, then open each app (Shop, Hotel, Hospital, Pharmacy, Production, Services, Water, Owner Console) so the service worker updates to zip-317 (close and reopen the app once if it still shows the old version).
26. Loyalty: Settings > Loyalty > tick "Show tokens earned and the token balance on the receipt". Sell to a customer with a phone number: the receipt shows LOYALTY TOKENS - Earned this sale and Token balance.
27. Side menu: "🏢 Business HQ" is just above your name at the bottom of the side menu.
28. Sales Counter: search "socks": the H&F socks are listed (in-stock ones first). Search "socks h&f": only the H&F socks.
29. Business HQ: in the main branch, open Staff > "🏢 Business HQ" (the button stays there now), sign in with the main branch's management password. It opens on Overview.
30. Stock: pick an item > "+ Store" > Add new stock > quantity > Save. The item now shows "Main store" with that quantity.
31. On the same item press Move > From Main store > To Shop floor > quantity > Move. On that branch's till the shop-floor quantity goes up (refresh once).
32. On an item press "Send to branch" > choose the branch > quantity > Send. Then Transfers > the transfer > Confirm received (the other branch's till goes up).
33. Reports: Sales by day and branch > All (consolidated) > Show > Download CSV.
34. More > Roles: "+ Cashier" > Save role. Staff > a person > ⋯ More > Role at a branch > give it. (More > Transfer approvals: leave "It goes out at once" unless you want approvals.)
35. Kitchen (zip 308): a waiter's order appears on the kitchen screen within a few seconds.
## PART F - END

Rollback (Pages): Cloudflare dashboard -> Workers & Pages -> mydukapos-3ao -> Deployments -> previous Production deployment -> Rollback.
The new tables are only read by the new code; an older deployment simply ignores them. backup\ledger-before-317.sql and backup\owner-before-317.sql are the databases as they were before.
