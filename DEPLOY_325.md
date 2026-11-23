# Deploy zip 325 - Business HQ: Admin only, no password (includes zip 324 and everything before)

What changed (Shop, Hospital, Hotel, Pharmacy, Production, Services, Water + functions/api/org.js):
- Business HQ opens straight away for the Admin who is signed in on the till. There is no password or PIN box any more.
- The "Business HQ" buttons (Staff tab, side menu, branch menu) show ONLY while the Admin is serving. When a staff member is checked in they disappear, and opening HQ from code says "Business HQ is for the Admin only."
- The SERVER also checks: the passwordless sign-in works only from the MAIN branch (a sub-branch's Admin is not the owner of the business and is refused). If the shop has "staff sessions required" switched on, a live Admin session is also required.
- The old password / HQ-administrator-PIN sign-in is still in the server for now (no client screen uses it).

Deploy (Windows cmd, as in DEPLOY.md): unzip, robocopy, npm run check, then
  node --test tests\zip325-hq-admin-only.test.mjs tests\zip324-import-price-guard.test.mjs
  npm run deploy:fast      (org.js is a Pages function, so no router deploy)
Service worker version: zip-325. Open the app once so it updates.
Check: sign in as Admin on the main branch > Business HQ opens with no password. Check a staff member in: the HQ buttons are gone.
