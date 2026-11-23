# Deploy zip 303 (existing project - no databases to create, no migrations)

Windows cmd. Run one line at a time.

```
:: ===== START zip 303 deploy =====
1. mkdir C:\dev\zip303
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_303.zip" -C C:\dev\zip303
3. cd /d C:\dev\zip303
4. robocopy C:\dev\zip303 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
5. cd /d C:\dev\mydukapos
6. node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
7. node tools\switch-account.mjs --show
8. npm install
9. npm run check
10. npm run deploy:router
11. npm run deploy:fast
12. Open https://<any-shop>.mydukapos.store/api/health once, then open each app so the service worker (zip-303) updates.
:: ===== END zip 303 deploy =====
```

- Step 4: robocopy exit codes 0-7 are success.
- Step 7 must print: Router forwards shop addresses to: mydukapos-3ao.pages.dev (if not, STOP).
- Step 9 must say: All apps match src/shared/.
- Check: open https://mydukapos.store/ (hero + "One sale, from scan to dashboard"), then https://mydukapos.store/websites and send a test enquiry; it appears in your contact messages.
