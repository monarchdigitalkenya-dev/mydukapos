# Deploying an update (Windows CMD) — the same every time

Work folder: `C:\dev\mydukapos` (the clone). Replace `zipNN` with the folder you unzip the new zip into.

1. Unzip the new zip:       `tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_NN.zip" -C C:\dev\zipNN` (make the folder first: `mkdir C:\dev\zipNN`)
2. Go to the work folder:   `cd /d C:\dev\mydukapos`
3. Mirror the zip in:       `robocopy C:\dev\zipNN C:\dev\mydukapos /MIR /XD .git node_modules /XF package-lock.json wrangler.staging.toml`
4. Install (if tools changed): `npm install`
5. Consistency check:       `npm run check`            (must say "All apps match src/shared/")
6. See what changed:        `git status`   and   `git diff --stat`
7. Staging first (for bigger changes): `npm run deploy:staging`   (and `npm run deploy:router:staging` first if wildcard-router/ changed)
8. Live router (ONLY if wildcard-router/ changed): `npm run deploy:router`
9. Live site:               `npm run deploy`           (check + all tests + upload to PRODUCTION; branch is `mydukapos`)
10. Save to Git:            `git add -A`, `git commit -m "Zip NN: what changed"`, `git push`
11. Verify: `npx wrangler pages deployment list --project-name=mydukapos` -> newest row must be Production; open a client link and make a test sale.

Rollback: Cloudflare dashboard -> Workers & Pages -> mydukapos -> Deployments -> pick the previous Production deployment -> Rollback.
Only the changed files are uploaded (Cloudflare compares file hashes: "61 uploaded, 70 already uploaded"), so always take the WHOLE zip — never copy single files by hand.

Note: `wrangler.staging.toml` is excluded from the mirror on purpose. It holds YOUR staging KV id; copying the zip's version over it would put the placeholder back.
If you ever lose it: `npx wrangler kv namespace list` shows your namespace ids (staging is the one titled mydukapos_kv_staging).

## Zip 167 — Windows build fix
Only `.github/workflows/windows.yml` changed. `npm run deploy` is not needed for it, but deploy anyway (the version stamp changed). Then git push and run the **windows** workflow again.

## Zip 166 — counter, settle, service orders, receipt keys
No router change, no migration. `npm run deploy`, then rebuild the APK/EXE via GitHub Actions.

## Zip 165 — Owner Console + CRM fixes
No router change (`deploy:router` NOT needed). `npx wrangler d1 migrations apply mydukapos-ledger --remote` is safe to repeat (the new CRM "App sign-up / demo" source and the re-labelling of old sign-up leads are applied automatically by the server the first time the CRM opens). Then `npm run deploy` and rebuild the APK/EXE via GitHub Actions.
After deploying: Owner Console > Settings > Danger zone > **Reset ALL Sales, Bills & Link Income to 0**, then tick each permanent link's 💰 toggle with what was paid.

## Zip 153 — D1 (transaction database) — Windows cmd, in `C:\dev\mydukapos`
`wrangler.toml` in this zip ALREADY has the D1 database bound (`mydukapos-ledger`, id 12f9b35e-d4d9-468d-ac8c-2b3ff6b3848d), so there is no create step and no file to edit.
1. Create the tables once (safe to repeat):  `npx wrangler d1 migrations apply mydukapos-ledger --remote`
2. Deploy as usual (`npm run deploy`, or `npm run deploy:fast` if `npm test` already passed), then open `https://<your-domain>/api/health?deep=1` — it must say `"d1":true`.
3. Pages dashboard users (no wrangler.toml deploy): also add the binding under Settings -> Functions -> D1 database bindings, variable name `LEDGER_DB`.

## Zip 155 — no new migration
Nothing new to apply on D1 or KV. Use the usual steps above (`npm run deploy`). Then rebuild the Android APK / Windows EXE (GitHub Actions) to get the offline screen; the web changes are live as soon as you deploy.

## Zip 156 — deploy the ROUTER first
`wildcard-router/shop-store.js` changed, so in `C:\dev\mydukapos` run **`npm run deploy:router`** BEFORE `npm run deploy`. No new D1/KV migration.
Every permanent shop now moves to the database store on its first push (about 1.5 s extra, once). Demo links stay on KV.
Rebuild the APK and EXE via GitHub Actions: the Windows build is now a parallel matrix (8 apps, 16 installers).

## Zip 157 — MyDuka CRM (new) — Windows cmd, in `C:\dev\mydukapos`
1. `npm run deploy:router` is NOT needed this time (the router did not change).
2. Create the CRM tables once (safe to repeat; the server also creates missing tables by itself):  `npx wrangler d1 migrations apply mydukapos-ledger --remote`
3. `npm run deploy`, then open `https://mydukapos.store/crm/` and choose **Continue as owner** (you must be signed in to the Owner Console in the same browser first).
4. Move your old leads: CRM -> Settings -> **Import previous leads** -> *Check what will be moved* -> *Import now* -> *Verify counts*. The old data stays in KV untouched; the Owner Console Leads tab is gone.
5. Optional Cloudflare secrets (Pages -> Settings -> Variables and secrets), only for the features you use: `CRM_SESSION_SECRET` (long random text), `CRM_BASE_URL` (https://mydukapos.store), `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` (reply from the CRM inbox), `META_APP_SECRET` + `META_PAGE_TOKEN` + `META_VERIFY_TOKEN` (Meta Lead Ads). Inbound WhatsApp keeps using the existing `WHATSAPP_APP_SECRET` / `WHATSAPP_VERIFY_TOKEN`.
6. Website capture: POST JSON to `https://mydukapos.store/api/crm-lead` (see CRM_ARCHITECTURE.md).

## Zip 158 — receipt size + leftovers — Windows cmd, in `C:\dev\mydukapos`
No new migration and the router did not change: `npm run check`, then `npm run deploy` (no `deploy:router`). Rebuild the APK/EXE (GitHub Actions) to get the new receipt size screen on the native apps.
Then on each till: Settings -> Receipt -> **Adjust receipt size** -> pick 58 / 80 / Custom, set the letter size, check the sample, **Print test receipt**, **Save**.

## Zip 159 — hotel categories + import, Cloudflare efficiency, leftovers — Windows cmd, in `C:\dev\mydukapos`
1. `npx wrangler d1 migrations apply mydukapos-ledger --remote` (adds the write-fence table and CRM indexes; safe to repeat, and the server also creates them on first use).
2. `npm run check`
3. `npm run deploy` (no `deploy:router` — the router did not change). Then open `https://<your-domain>/api/health?deep=1` — it must say `"d1":true`.
4. Rebuild the APK/EXE (GitHub Actions) to get the hotel changes on the native apps.
5. Hotel: Inventory -> pick a type -> **Categories & assign** / **Import**. On the Sales Counter and Service Orders tap a category chip.
6. Optional Cloudflare dashboard steps (Smart Placement, cache rule for /icons/*, R2 lifecycle) are listed in `EFFICIENCY_REPORT_ZIP_159.md`.

## Zip 160 — reliability + real-browser fixes — Windows cmd, in `C:\dev\mydukapos`
No new migration and no router change: `npm run check`, then `npm run deploy`. Rebuild the APK/EXE (GitHub Actions) to get the fixes on the native apps.
Details: `CHANGES_ZIP_160_RELIABILITY.md`, `CHANGES_ZIP_160_BROWSER.md` (screenshots in `docs/screens-zip160/`).

## Zip 161 — fractional past sales, staff-link buttons, faster CRM — Windows cmd, in `C:\dev\mydukapos`
1. `npx wrangler d1 migrations apply mydukapos-ledger --remote` (adds the CRM speed indexes; safe to repeat — the server also creates them on first use).
2. `npm run check`
3. `npm run deploy` (no `deploy:router`).
4. Open `https://mydukapos.store/crm/` once while online so the new CRM app-shell cache installs (if anything looks stale add `?nosw=1` to the address to bypass it).
5. Rebuild the APK/EXE (GitHub Actions) for the native apps.
Optional (search speed-up, not required): `migrations-optional/0005_crm_search.sql` adds full-text search — see `CRM_PERF_ZIP_161.md` before applying (it stops `wrangler d1 export` from working).
Details: `CHANGES_ZIP_161_BUTTONS.md`, `CHANGES_ZIP_161_PASTSALE_HOTEL.md`, `CRM_PERF_ZIP_161.md`.

## Zip 164 — hotel Sales view + hide/show top bar — ALL-IN-ONE deploy (covers every zip you may have skipped) — Windows cmd
Migrations are cumulative and safe to repeat (0001 ledger, 0002 CRM, 0003 efficiency, 0004 CRM speed). The wildcard router changed in zip 156 and has not changed since; deploy it once so it is certainly current.
1. `mkdir C:\dev\zip164`
2. `tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_164.zip" -C C:\dev\zip164`
3. `cd /d C:\dev\mydukapos`
4. `robocopy C:\dev\zip164 C:\dev\mydukapos /MIR /XD .git node_modules /XF package-lock.json wrangler.staging.toml`
5. `npm install`
6. `npx wrangler d1 migrations apply mydukapos-ledger --remote`
7. `npm run check`
8. `npm run deploy:router`
9. `npm run deploy`
10. Open `https://mydukapos.store/api/health?deep=1` — it must say `"d1":true`; open `https://mydukapos.store/crm/` once while online.
11. `git add -A`, `git commit -m "Zip 164"`, `git push`
12. Rebuild the Android APK / Windows EXE (GitHub Actions); hard-refresh each app once (service worker `zip-164`).
Hotel: 💰 Sales button next to 🧾 Bills (day totals: Total / Cash / M-Pesa; staff see their own, admin sees all); ▲ Hide / ▼ Show for the top bar (stays as you left it).

## Zip 163 — no new migration
Nothing new on D1 or KV. Usual steps (`npm run deploy`), then rebuild the Android APK / Windows EXE (GitHub Actions) so the phone/PC apps get the same screens. After deploying, hard-refresh each app once (the service worker is `zip-163`).
What changed (see CHANGES_ZIP_163.md): sticky total + payment methods + Confirm bar in every module, owner-chosen payment methods (Settings), hotel order rows/categories/sub-categories, purchase packaging + weighted-average cost + measured selling + purchases report.

## Zip 162 — hotel Sales Counter, Services engine, leftovers — Windows cmd, in `C:\dev\mydukapos`
1. `npm install`
2. `npm run check`
3. `npm run deploy` (no `deploy:router`; no new migration).
4. Rebuild the APK/EXE (GitHub Actions) for the native apps.
5. Payment methods: since zip 163 this is **Settings → "Payment methods you accept"** in every module (the old hotel-only box is gone).
6. Services: existing shops stay in classic mode until the owner taps "Choose your business type"; nothing is migrated or rewritten.
Details: `CHANGES_ZIP_162.md`, `SERVICES_ARCHITECTURE.md`.

## Zip 168 — Sales Counter checkout workspace — no migration, no router change
1. `npm install`
2. `npm run check`
3. `npm run deploy`
4. Rebuild the APK/EXE (GitHub Actions); hard-refresh each app once (service worker `zip-168`).
Details: `CHANGES_ZIP_168.md`.

## Zip 169 — no migration file
1. `npm install`
2. `npm run check`
3. `npm run deploy`
4. Open `https://mydukapos.store/crm/` once while online (re-labels old sign-up leads).
Details: `CHANGES_ZIP_169.md`.

## Zip 170 — no migration
1. `npm install`
2. `npm run check`
3. `npm run deploy`
4. Rebuild the APK/EXE (GitHub Actions); hard-refresh each app once (service worker `zip-170`).
Details: `CHANGES_ZIP_170.md`.

## Zip 171 — no migration
1. `npm install`
2. `npm run check`
3. `npm run deploy`
4. Rebuild the APK/EXE only if you want it in the phone/PC apps; hard-refresh each app once (`zip-171`).
Details: `CHANGES_ZIP_171.md`.

## Zip 172 — no migration
1. `npm install`
2. `npm run check`
3. `npm run deploy`
4. Rebuild the APK/EXE only if you want it in the phone/PC apps; hard-refresh each app once (`zip-172`).
Details: `CHANGES_ZIP_172.md`.

## Zip 173 — no migration
1. `npm install`
2. `npm run check`
3. `npm run deploy`
4. `git add -A`, `git commit -m "Zip 173"`, `git push` (the push re-runs the Windows build); hard-refresh each app once (`zip-173`).
Details: `CHANGES_ZIP_173.md`.

## Zip 175 — no migration
1. `npm install`
2. `npm run check`
3. `npm run deploy`
4. Hard-refresh each app once (`zip-175`).
Details: `CHANGES_ZIP_175.md`.

## Zip 176 — no migration
1. `npm install`
2. `npm run check`
3. `npm run deploy`
4. `git add -A`, `git commit -m "Zip 176"`, `git push` (the push builds the new Windows app); hard-refresh each app once (`zip-176`).
Details: `CHANGES_ZIP_176.md`.

## Zip 177 — public website, SEO, sign-up hardening — no migration
1. `npm install`
2. `npm run check`
3. `npm run deploy`
4. `git add -A`, `git commit -m "Zip 177"`, `git push`; hard-refresh each app once (`zip-177`).
5. Optional Cloudflare variables (Pages → Settings → Variables and secrets) — all off/blank by default, nothing breaks without them: `VERIFICATION_REQUIRED=1`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_OTP_TEMPLATE` (+ `WHATSAPP_OTP_LANG`), `CONTACT_NOTIFY_EMAIL`, `TURNSTILE_SECRET`. See `SECURITY_AND_CONFIG_177.md`.
6. Open `https://mydukapos.store/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/offers`, `/faq`, `/terms`, then Owner Console ▸ 🏷️ Offers.
Details: `CHANGES_ZIP_177.md`.

## Zip 178 — menu import with sub-categories — no migration
1. `npm install`
2. `npm run check`
3. `npm run deploy`
4. `git add -A`, `git commit -m "Zip 178"`, `git push`; hard-refresh each app once (`zip-178`).
Details: `CHANGES_ZIP_178.md`. Menu file (sent separately): `Menu_import.xlsx` — Hotel / Restaurant ▸ Inventory ▸ ⬆️ Import.

## Zip 179
WhatsApp number required / email optional at sign-up; sign-in by number or email; STK push sales verify instantly. No new environment variables. See CHANGES_ZIP_179.md.


## Zip 180
Sales Counter: taller cart, Hold moved to the card header, Receiving Account hidden, Retail / Wholesale / Custom price menu on every module. No migrations, no new secrets. Deploy as usual (`npm run deploy`), then hard-refresh each app.


## Zip 185
- New additive D1 migration `migrations/0006_mpesa_claims.sql`: run `npx wrangler d1 migrations apply mydukapos-ledger --remote` (the table is also created on demand, so deploy order is not critical).
- Optional environment variables (all have safe defaults): `OWNER_SETUP_TOKEN`, `ACCOUNT_RECOVERY_STRICT=1`, `GATEWAY_CONFIG_HOURLY_LIMIT`, `BRANCH_CREATE_DAILY_LIMIT`, `BRANCH_DELETE_HOURLY_LIMIT`, `RESTORE_HOURLY_LIMIT`, `AI_CAPTURE_HOURLY_LIMIT`.
- The Pages Functions, the wildcard router (`npm run deploy:router`) and every app change in this zip, so run both deploys.
