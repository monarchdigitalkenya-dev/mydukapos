# Zip 297 - deploy (NEW Cloudflare account, already switched)

This zip already carries the new account's ids in BOTH wrangler.toml files (KV e34ec52d..., ledger 5cb41a51..., audit b5d57318..., owner f505cb96...) and PAGES_ORIGIN = mydukapos-3ao.pages.dev. The router's built-in fallback is now that same project: a router deployed without the variable can no longer send shop traffic to the deleted old account (that was the 503 on shop links).
You can use your usual steps (robocopy skipping wrangler.toml, then switch-account) - both give the same result.

1. mkdir C:\dev\zip297
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_297.zip" -C C:\dev\zip297
3. cd /d C:\dev\zip297
4. robocopy C:\dev\zip297 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
5. cd /d C:\dev\mydukapos
6. node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
7. node tools\switch-account.mjs --show   (must print Router forwards shop addresses to: mydukapos-3ao.pages.dev)
8. npm install
9. npm run check
10. npx wrangler d1 migrations apply mydukapos-ledger --remote
11. npm run deploy:router
12. npm run deploy:fast
13. Open https://<any-shop>.mydukapos.store/api/health once; open each app so the service worker (zip-297) updates.
