# Deploy zip 299 (existing project - no databases to create, no migrations)

Windows cmd. Run one line at a time.

```
:: ===== START zip 299 deploy =====
1. mkdir C:\dev\zip299
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_299.zip" -C C:\dev\zip299
3. cd /d C:\dev\zip299
4. robocopy C:\dev\zip299 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
5. cd /d C:\dev\mydukapos
6. node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
7. node tools\switch-account.mjs --show
8. npm install
9. npm run check
10. npm run deploy:router
11. npm run deploy:fast
12. Open https://<any-shop>.mydukapos.store/api/health once, then open each app so the service worker (zip-299) updates.
:: ===== END zip 299 deploy =====
```

- Step 4: robocopy exit codes 0-7 are success.
- Step 7 must print: Router forwards shop addresses to: mydukapos-3ao.pages.dev (if not, STOP).
- Step 9 must say: All apps match src/shared/.
- Check: open Sales Counter - pictures are square and complete; Inventory thumbnails are square too.
