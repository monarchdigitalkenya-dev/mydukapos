# Deploy zip 334 - Staff: many registration numbers, 1.5 MB documents with auto-shrink, staff info download (includes everything up to 333)

All commands are Windows cmd. Run them one at a time, in order. Each PART has a clear START and END.
Nothing here has been deployed or tried on your live Cloudflare account - the tests ran on a test copy only.

What is new:
1. **Registration numbers:** on each person's Personal tab (and when adding staff) a box where you can add as many numbers as you want - National ID, Passport, Driving licence, Employment ID, Staff/payroll ID, KRA PIN, NSSF, SHA, NHIF, Work permit, Professional licence, extra Phone numbers, or "Other" with your own label. All optional.
2. **Documents:** maximum 1.5 MB. Choose a PDF or photo(s): photos become one PDF; a bigger PDF is shrunk automatically. View and Download are PDF.
3. **Download staff info:** "Download staff info (PDF)" on a person; "Download staff list (CSV)" on the staff list.
4. Employment type (permanent / contract / intern) and full-time / part-time were already in the system and are unchanged.

Service worker version: zip-334. A new table (pr_emp_numbers) is created automatically the first time staff is opened; step 12 below also applies it by hand (optional, safe to repeat). Only Pages needs deploying (no router deploy).
Included from zip 333: Daily Sales payment totals and the Aqua raw-material varieties (see DEPLOY_333.md for what to try).

## PART A - START: unpack the zip
1. mkdir C:\dev\zip334
2. tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_334.zip" -C C:\dev\zip334
## PART A - END

## PART B - START: copy into the work folder (keeps the wrangler files already pointing at your account)
3. robocopy C:\dev\zip334 C:\dev\mydukapos /E /XF wrangler.toml wrangler.noroute.toml *.old-account /XD node_modules .git
   (robocopy exit codes 0 to 7 are success - only 8 or higher is an error)
4. cd /d C:\dev\mydukapos
5. node tools\switch-account.mjs --kv e34ec52d47f44f899a0daeb3fcf54a08 --ledger 5cb41a51-8b84-46f3-b152-1f6ef3668143 --audit b5d57318-63ee-4b12-98ab-50cbcadf8763 --owner f505cb96-d38a-4f6c-bb0c-6f6f59857d02 --pages-host mydukapos-3ao.pages.dev
6. node tools\switch-account.mjs --show
   (must print: Router forwards shop addresses to: mydukapos-3ao.pages.dev - if not, STOP)
## PART B - END

## PART C - START: check, test and deploy
7. npm install
8. npm run check
   (must say: All apps match src/shared/. then cards in sync then owner pro in sync)
9. node --test tests\zip334-staff-details.test.mjs tests\zip334-staff-details.browser.test.mjs
   (the end must say: fail 0. The test that shrinks a big PDF needs the pdfjs-dist package and is skipped on your PC unless you run: npm install --no-save pdfjs-dist@3.11.174 )
10. npm test
   (several minutes; end must say: fail 0 - if a test fails, STOP and send me its name. Known older failures from before zip 327: menu-import wording, zip180, zip254)
11. npm run deploy:fast
12. (optional, safe to repeat) npx wrangler d1 execute LEDGER_DB --remote --file=migrations\0018_hr_numbers.sql
## PART C - END

## PART D - START: use it (try on a TEST shop first)
13. Open the app once so it updates to zip-334 (close and reopen if it still shows the old version).
14. People > Staff > All staff > tap a name > Personal: scroll to "Registration numbers & contacts". Press "Add a number", pick the kind, type the number. Add several, including two phone numbers. Press Save personal details; reopen the person - they are all still there.
15. Documents tab: pick a phone photo (several are fine). Name it, Save. It is saved as a PDF under 1.5 MB. Preview and Download it.
16. Documents tab: pick a PDF bigger than 1.5 MB. It is shrunk before upload (needs internet).
17. On the person: "Download staff info (PDF)". On the staff list: "Download staff list (CSV)" - open it in Excel; each kind of number has its own column.
## PART D - END

## Honest limits
- Not tried on a live phone or on live Cloudflare - only in a phone-size test browser.
- A PDF over 1.5 MB is rebuilt from page pictures, so text in the shrunk copy can't be selected or searched. A small PDF is stored exactly as it is. Shrinking needs internet (a helper library is fetched); if it can't be fetched you are told, nothing is half-saved.
- Photos are accepted as JPG / PNG / WebP. Some iPhone photos are HEIC; if the browser can't read one, you are told to switch the camera format to "Most Compatible" or upload a PDF.
- Documents that are already saved and bigger than 1.5 MB stay as they are; only new uploads and replacements are limited.
- The Settings limit for staff documents is now between 0.5 and 1.5 MB (it used to allow up to 10 MB).
- Only people with the staff-record right see the numbers; the audit log records how many numbers were saved, never the numbers themselves. Pay figures appear in the info PDF/CSV only for people who may see pay.
- There is no "download all documents in one go" yet - the staff info PDF lists the documents on file; each file is downloaded from the person's Documents tab.

Rollback (Pages): Cloudflare dashboard -> Workers & Pages -> mydukapos-3ao -> Deployments -> previous Production deployment -> Rollback.
