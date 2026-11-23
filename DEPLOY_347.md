# Deploy zip 347 - LOGIN FIX: passwords that stopped working, and Owner Console resets that did not let people in
Covers: (1) the login now also checks the server's own copy of the password when the typed one does not match, so a reset reaches users even if their phone has not synced; (2) a temporary password pasted with a space or line break at the end now works; (3) FIXED the real cause of "reset undone": a device converting its OLD password right after a reset could put the old password back on the server; (4) password boxes no longer capitalise or auto-correct on phones. Everything from zips 345 and 346 is still included.
Apps changed: Shop, Hospital (HMIS), Pharmacy, Hotel, Production, Services, Water (shared parts). Service worker: zip-347.
**No new database migration.** Web + functions deploy only.
All commands are Windows cmd. Run them ONE at a time, in order: paste one line, press Enter, wait for it to finish, then the next. No File Explorer needed.
Nothing here was deployed by me to your live Cloudflare account.

┌─ PART A ─ START ─ unpack ───────────────────────────────┐
1.  mkdir C:\dev\zip347
2.  tar -xf "%USERPROFILE%\Downloads\ZIPNAME.zip" -C C:\dev\zip347
    (replace ZIPNAME.zip with the exact file name of the zip I gave you)
└─ PART A ─ END ──────────────────────────────────────────┘

┌─ PART B ─ START ─ copy into the work folder and lock the CORRECT account ─┐
3.  robocopy C:\dev\zip347 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
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
10. node --test tests\login-fix.test.mjs
    (the end must say: fail 0)
11. npm test
    (takes several minutes. Older known failures from earlier zips may still show. If a different test fails, STOP and send me its name.)
└─ PART C ─ END ──────────────────────────────────────────┘

┌─ PART D ─ START ─ back up the data ─────────────────────┐
12. npm run db:backup
13. npx wrangler d1 migrations apply mydukapos-ledger --remote
    ("Nothing to apply" is expected.)
└─ PART D ─ END ──────────────────────────────────────────┘

┌─ PART E ─ START ─ deploy ───────────────────────────────┐
14. npm run deploy:fast
15. npm run deploy:router
└─ PART E ─ END ──────────────────────────────────────────┘

┌─ PART F ─ START ─ check it on the LIVE site (use a TEST shop first) ─┐
16. Open the Shop once, then refresh once, so it updates to zip-347 (do this on every phone and till).
17. Owner Console > the shop > Reset password > choose "both". Write down the temporary password shown.
18. On a phone or till that has NOT been opened for a while, open the shop and type the temporary password. It must let you in (it can take a few seconds).
19. Try the same with a space after the password. It must also work.
20. Type a wrong password: it must say "Incorrect password".
21. After logging in, go to Settings and set your own new password.
└─ PART F ─ END ──────────────────────────────────────────┘

Beginner guide: docs/GUIDE_347.md. IMPORTANT: every device must open the app once online so it gets zip-347. If anything looks wrong after deploying, tell me the step number and what the screen said.
