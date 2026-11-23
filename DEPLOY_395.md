# Deploy zip 395 - receipt switches
1. mkdir C:\dev\zip395
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_receipt-switches_395_11220930.zip" -C C:\dev\zip395
3. robocopy C:\dev\zip395 C:\dev\mydukapos /E /XD node_modules .git
4. cd /d C:\dev\mydukapos
5. node tools\switch-account.mjs --show
6. npx wrangler whoami
7. npm install
8. npm run check
9. npm run db:backup
10. npx wrangler d1 migrations apply mydukapos-ledger --remote
11. npm run deploy:router
12. npm run deploy:fast
