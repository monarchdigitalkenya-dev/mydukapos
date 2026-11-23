# Deploy zip 394 - staff commission, Car Wash money section
1. mkdir C:\dev\zip394
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_commission-carwash_394_11220230.zip" -C C:\dev\zip394
3. robocopy C:\dev\zip394 C:\dev\mydukapos /E /XD node_modules .git
4. cd /d C:\dev\mydukapos
5. node tools\switch-account.mjs --show
6. npx wrangler whoami
7. npm install
8. npm run check
9. npm run db:backup
10. npx wrangler d1 migrations apply mydukapos-ledger --remote
11. npm run deploy:router
12. npm run deploy:fast
