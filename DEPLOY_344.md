# Deploy zip 344 - everything from this chat
Covers (zips 340 + 341 + your Bluetooth printer fix): (1) patient age entry, (2) Maternal & Child Health menu, (3) Consultation workspace, (4) Store Move (4 ways) and fill-the-existing-item fix plus "Match extra items to sizes", (5) M-PESA Agent app (Shop), (6) HMIS look fixes.
Apps changed: Shop, Hospital (HMIS), Hotel, Pharmacy, Production, Services, Water (shared parts), server code (functions/api/_perm-guard.js, _merge.js, pos-sync.js). Service worker: zip-344.
**No new database migration.** Web + functions deploy only.
All commands are Windows cmd. Run them ONE at a time, in order: paste one line, press Enter, wait for it to finish, then the next.
Nothing here was deployed by me to your live Cloudflare account.

┌─ PART A ─ START ─ unpack ───────────────────────────────┐
1.  mkdir C:\dev\zip344
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_project_344_85609.zip" -C C:\dev\zip344
    (replace mydukapos_project_344_85609.zip with the exact name of the zip I gave you)
└─ PART A ─ END ──────────────────────────────────────────┘

┌─ PART B ─ START ─ copy into the work folder and lock the CORRECT account ─┐
3.  robocopy C:\dev\zip344 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; only 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
    (must print: Router forwards shop addresses to: mydukapos-3ao.pages.dev. If not, STOP - do not deploy.)
7.  npx wrangler whoami
    (must show the Cloudflare account that owns mydukapos-3ao.pages.dev. If different: npx wrangler logout, then npx wrangler login, then run this step again.)
└─ PART B ─ END ──────────────────────────────────────────┘

┌─ PART C ─ START ─ check and test ───────────────────────┐
8.  npm install
9.  npm run check
    (must say: All apps match src/shared/, then cards in sync, then owner pro in sync)
10. node --test tests\zip344-mpesa-guard.test.mjs tests\zip344-age-entry.test.mjs tests\zip344-store-move.test.mjs tests\e2e-revert.test.mjs
    (the end must say: fail 0)
11. node --test tests\zip344-mpesa-agent.browser.test.mjs tests\zip344-consultation.browser.test.mjs tests\zip344-match-strays.browser.test.mjs
    (the end must say: fail 0. Needs Playwright; without it these are skipped, not failed)
12. npm test
    (takes several minutes. Older known failures from earlier zips may still show. If a different test fails, STOP and send me its name.)
└─ PART C ─ END ──────────────────────────────────────────┘

┌─ PART D ─ START ─ back up the data, then the database step ─┐
13. npm run db:backup
14. npx wrangler d1 migrations apply mydukapos-ledger --remote
    ("Nothing to apply" is expected.)
└─ PART D ─ END ──────────────────────────────────────────┘

┌─ PART E ─ START ─ deploy ───────────────────────────────┐
15. npm run deploy:fast
16. npm run deploy:router
└─ PART E ─ END ──────────────────────────────────────────┘

┌─ PART F ─ START ─ check it on the LIVE site (use a TEST shop first) ─┐
17. Open each app once so it updates to zip-344.
18. Store tab > Move: try all four ways. Store to Inventory adds to the existing item and size (no new item).
19. Inventory > "Match extra items to sizes" clears old "Item (XL)" duplicates.
20. Hospital > open a patient > Consultation: check allergy/vitals header, SOAP, Save draft, Save & send to cashier once.
21. Shop > Money > M-PESA Agent > Settings: type opening cash and float, Save. Record one deposit, one withdrawal, then Reconciliation & Closing.
└─ PART F ─ END ──────────────────────────────────────────┘

Beginner guide: docs/GUIDE_340.md. If anything looks wrong after deploying, tell me the step number and what the screen said.

Printer note: the Android app (native/android) has the Bluetooth fix (no BLUETOOTH_SCAN needed on Android 12+). The Windows web deploy above does not rebuild the Android APK; rebuild/reinstall the APK on the POS terminal to get the fix.
