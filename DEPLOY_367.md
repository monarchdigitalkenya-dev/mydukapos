# Zip 367 - HMIS in-patient adjustments; plus everything in zip 366 and earlier

## What is new (Hospital / HMIS)
- Consultation: the Disposition / Outcome / Patient-type section is gone (admit from the main menu instead).
- Main menu: "Wards & Beds" is now **INPATIENT (ADMISSION)**. Tap ✏️ on a ward to rename it (Male ward, Female ward, Paediatric ward ...). Beds and the Admit Patient area are unchanged.
- **📁 Patient file** (was "Chart"): consultation (vitals, diagnosis, SOAP, treatment, services), lab and radiology are collected automatically, plus ward notes, medicines given, meals, bed history and the bill. **Print** and **Download** buttons; discharged patients' files are in Discharge History.
- Inside a patient: tabs **File, Account, Meals, MAR, Services, Lab, Radiology, Clinical notes, Bed & leave**.
- Meals can be edited or removed. "Charges" is now "Services".
- **No payment in the ward.** Tap **📤 Send to cashier**: the accumulated bill goes to the cashier (Sales Counter -> Patient Bill), who collects it and prints the receipt, statement or invoice.

## Deploy
All commands are Windows cmd. Run them ONE at a time, in order.

PART A - unpack
1.  mkdir C:\dev\zip367
2.  tar -xf "%USERPROFILE%\Downloads\mydukapos_hmis-inpatient_367_11131427.zip" -C C:\dev\zip367

PART B - copy and lock the CORRECT account
3.  robocopy C:\dev\zip367 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
    (exit codes 0 to 7 are success; 8 or higher is an error)
4.  cd /d C:\dev\mydukapos
5.  node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6.  node tools\switch-account.mjs --show
7.  npx wrangler whoami

PART C - check and test
8.  npm install
9.  npm run check
    (it must say: All apps match src/shared/)
10. node --test --test-concurrency=1 tests\zip367-inpatient.test.mjs
    (the end must say: fail 0 - takes a few minutes)

PART D - back up, database, deploy
11. npm run db:backup
12. npx wrangler d1 migrations apply mydukapos-ledger --remote
    (no new migration: it should say there is nothing to apply)
13. npm run deploy:router
14. npm run deploy:fast

PART E - after deploy
15. Each device: hard-refresh once (Ctrl+F5); installed apps update on their next start.
16. Hospital > INPATIENT (ADMISSION): tap ✏️ on Ward 01 and rename it (e.g. Male ward).
17. Admit a test patient, then open them: try the 📁 File tab (Print and Download), Lab, Radiology and Clinical notes.
18. Account tab: tap **Send to cashier**, then open the Sales Counter > Patient Bill - the bill is there. Nothing is paid in the ward.

## Notes for the clinic
- A patient admitted BEFORE this update keeps working: any ward payment already on file stays and can still be reversed; Discharge still works.
- At discharge to the patient, the bed & nursing balance now waits at the cashier (it used to be recorded as paid immediately).
