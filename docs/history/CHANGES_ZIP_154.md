# MyDukaPOS zip 154 — zip 153 plus the Owner Console apps and the D1 binding

Zip 154 contains everything in `CHANGES_ZIP_153.md` (read that first: D1 ledger, QR ordering, hotel POS, store transfers, General Shop leftovers) plus:

## 1. D1 database bound
- FILES: `wrangler.toml` (your file, with `LEDGER_DB` -> `mydukapos-ledger`, id 12f9b35e-d4d9-468d-ac8c-2b3ff6b3848d, now active), `DEPLOY.md`.
- RESULT: nothing to create or edit at deploy time; only `npx wrangler d1 migrations apply mydukapos-ledger --remote`.

## 2. Owner Console as an Android app and a Windows installer
- FILES: `native/apps.json` (8th app `owner`, `"fixed": true`), `native/android/app/build.gradle` (flavour + `BuildConfig.FIXED`), `MainActivity.java`, `native/windows/main.js`, `build.mjs`, icons, both workflows (8 apps / 16 installers), `native/README.md`.
- FIX: opens `https://<root domain>/owner/` directly; no shop link, no licence check (the console has its own login). Same signing keys.
- TEST: `node --check` only. The Android/Windows builds were NOT run here; the first GitHub run is the real test.
- REMAINING RISKS: for the owner only — do not publish it under Apps & Versions. The emulator check still only launches the Shop app.

## 3. Version stamps
- `SW_VERSION` / release stamps are `zip-154` in all apps, service workers and the device-security block. `npm run check` and `npm run lint` are clean.
- Test status is as in zip 153 (one full run, failures fixed and re-run; the full suite was not repeated after the fixes).
