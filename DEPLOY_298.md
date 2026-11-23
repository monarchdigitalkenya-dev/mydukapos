# Zip 298 - Compact Sales Counter + always-ready barcode scanner, Delivery button fixed, hospital date of birth, lab technician lab-history view, less scrolling (all 7 apps)

What changed (details in CHANGELOG.md): the Sales Counter is compact (5-7 product columns, one search box, one category row, [Hold Sale] [Open Drawer] [COMPLETE SALE] on one row) and the barcode scanner works without clicking the search box; the Delivery popup can be clicked and typed into again; Hospital registration uses a date-of-birth picker (age in years AND months); the lab technician sees a patient's lab history only; one "Patient Notes" box removed (the notes under SOAP stay); Laboratory tab request row tidied (one Request button); phone dashboards fold their long sections; hotel "Applies to" tick-boxes no longer overlap; bigger tap targets.
No D1 migration, no router change. Service worker version `zip-298`.

All commands are Windows cmd. Run them one at a time, in order. Every part says where it starts and ends.

## PART A - START: unpack the zip
1. mkdir C:\dev\zip298
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_298.zip" -C C:\dev\zip298
3. cd /d C:\dev\zip298
## PART A - END

## PART B - START: copy into the work folder (keeps the wrangler files already pointing at your account)
4. robocopy C:\dev\zip298 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
   (robocopy prints exit codes 0 to 7 for success - only 8 or higher is an error)
5. cd /d C:\dev\mydukapos
6. node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
7. node tools\switch-account.mjs --show
   (must print: Router forwards shop addresses to: mydukapos-3ao.pages.dev)
## PART B - END

## PART C - START: databases and storage (create steps are safe to repeat - "already exists" is fine, just carry on)
8. npx wrangler kv namespace create mydukapos_kv
9. npx wrangler d1 create mydukapos-ledger
10. npx wrangler d1 create mydukapos-audit
11. npx wrangler d1 create mydukapos-owner
12. npx wrangler r2 bucket create mydukapos-media
13. npx wrangler r2 bucket create mydukapos-audit-archive
14. npx wrangler r2 bucket create mydukapos-db-backups
15. npx wrangler pages project create mydukapos-3ao --production-branch=mydukapos
    (if it says the project already exists, carry on)
16. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (nothing new to apply in this zip - safe to run)
## PART C - END

## PART D - START: check and deploy
17. npm install
18. npm run check
    (must say: All apps match src/shared/)
19. npm run deploy:router
20. npm run deploy:fast
    (use `npm run deploy` instead if you also want the full test run before upload)
## PART D - END

## PART E - START: confirm
21. Open each app once (Shop, Hotel, Hospital, Pharmacy, Production, Services, Water) so the service worker updates to zip-298.
22. Sales Counter: add an item, tap Delivery, type a name and a fee, tap Done - the summary bar must show them.
23. Hospital > Reception: pick a date of birth - the age line shows years and months.
24. Hospital > Laboratory: choose a patient - the lab-history card shows only lab tests.
25. Sales Counter (computer / tablet): you should see 5-7 small product cards across, ONE search box ("Search products, barcode or SKU..."), a thin row of category buttons, and under the cart [Hold Sale] [Open Drawer] [COMPLETE SALE] side by side.
26. Scanner: open the Sales Counter, click NOTHING, scan an item - it must land in the cart (the small "Scan ready" light is green). Scan the same item again - quantity goes up. Click in the Delivery name box and scan - it must stay in the box and not add an item.
27. Keys: F2 jumps to the search box, Esc clears it, Enter or Space on a focused product card adds it.
## PART E - END

Rollback: Cloudflare dashboard -> Workers & Pages -> your Pages project -> Deployments -> previous Production deployment -> Rollback.
