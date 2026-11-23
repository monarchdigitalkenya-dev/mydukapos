# Deploy zip 390

Same code as zip 389 (KCB sandbox payload popup, IPN transactionID fix). Both account files already hold the current account's ids, and the robocopy below copies them too.

1. mkdir C:\dev\zip390
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_full_390_11200850.zip" -C C:\dev\zip390
3. robocopy C:\dev\zip390 C:\dev\mydukapos /E /XD node_modules .git
4. cd /d C:\dev\mydukapos
5. node tools\switch-account.mjs --show
6. npx wrangler whoami
7. npm install
8. npm run check
9. npm run db:backup
10. npx wrangler d1 migrations apply mydukapos-ledger --remote
11. npm run deploy:router
12. npm run deploy:fast
