# Deploy zip 397 - print network off KV (new D1 migration 0021)
1. mkdir C:\dev\zip397
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_kv-savings_397_11232345.zip" -C C:\dev\zip397
3. robocopy C:\dev\zip397 C:\dev\mydukapos /E /XD node_modules .git
4. cd /d C:\dev\mydukapos
5. node tools\switch-account.mjs --show
6. npx wrangler whoami
7. npm install
8. npm run check
9. npm run db:backup
10. npx wrangler d1 migrations apply mydukapos-ledger --remote
11. npm run deploy:router
12. npm run deploy:fast
