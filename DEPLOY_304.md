# Deploy zip 304 - One money record (Owner Console), Tax & Returns in every app, simpler navigation and settings

What changed (details: CHANGELOG.md and docs/AUDIT_304.md): the Owner Console counts every payment ONCE in a new Money tab (one record, one
calculation, a reconciliation of the old doubled totals); every POS app (Shop, Hotel, Hospital, Pharmacy, Production, Services, Water) gets a
Tax & Returns tab, a regrouped sidebar with a page finder, grouped Settings with a setting finder, and a sync status line on the Dashboard; the home page
has one menu button and the "Explore Live Demo" button.

New in the database: two tables in the OWNER database (owner_money, owner_money_log). The server creates them by itself on first use; step 17 creates
them up front (safe to repeat). No ledger migration. The router is unchanged (step 21 is safe to run anyway). Service worker version: zip-304.

All commands are Windows cmd. Run them one at a time, in order. Every part says where it starts and ends.

## PART A - START: unpack the zip
1. mkdir C:\dev\zip304
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_304.zip" -C C:\dev\zip304
3. cd /d C:\dev\zip304
## PART A - END

## PART B - START: copy into the work folder (keeps the wrangler files already pointing at your account)
4. robocopy C:\dev\zip304 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
   (robocopy exit codes 0 to 7 are success - only 8 or higher is an error)
5. cd /d C:\dev\mydukapos
6. node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
7. node tools\switch-account.mjs --show
   (must print: Router forwards shop addresses to: mydukapos-3ao.pages.dev - if not, STOP)
## PART B - END

## PART C - START: back up the owner database before the change
8. if not exist backup mkdir backup
9. npx wrangler d1 export mydukapos-owner --remote --output=backup\owner-before-304.sql
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
23. npm run deploy:fast
    (use npm run deploy instead if you also want the full test run before upload; it takes a long time)
## PART E - END

## PART F - START: confirm
24. Open https://<any-shop>.mydukapos.store/api/health once, then open each app (Shop, Hotel, Hospital, Pharmacy, Production, Services, Water, Owner Console) so the service worker updates to zip-304.
25. Shop: the sidebar shows Sell & Deliver, Stock, Money, Reports, People, Business, System and a "Find a page" box. Reports > Tax & Returns opens (banner: for review and manual filing).
26. Tax & Returns > Tax setup: answer "Is this business registered for VAT?". Overview > This month: the gross total equals Reports for the same dates.
27. Settings: the section buttons sit under headings (Payments, Receipts & Printers, Taxes ...); type "printer" in Find a setting.
28. Owner Console > Money & Billing > Money (one record) > Reconcile old records: read the report (old dashboard, old billing, corrected total, entries set aside). Download the CSV if you want a copy. Press Apply only when the figures look right. Then open each "Needs review" entry and choose Count it or Exclude, with a reason.
29. Owner Console > Dashboard: Collected revenue = Money > Overview for the same period.
30. Home page on a phone: one menu button; the main button reads "Explore Live Demo".
## PART F - END

Rollback: Cloudflare dashboard -> Workers & Pages -> mydukapos-3ao -> Deployments -> previous Production deployment -> Rollback.
The two new owner tables can stay (nothing else reads them). backup\owner-before-304.sql is the owner database as it was before.
