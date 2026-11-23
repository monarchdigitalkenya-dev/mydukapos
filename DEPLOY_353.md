# Zip 353 - HMIS brought up to date (from the hospital-only build, zips 351-373)

Everything below is in the Hospital app (`/hospital/`). Branding, colours, logo and the other apps' look are unchanged.

## What the Hospital app gained
- Lab pay gate: results cannot be entered until the lab test is paid; lab tests are matched to the lab catalogue (price + name).
- Ward and bed on inpatient admission; Patient history (printable) and Medical history tab; Emergency fee 300 in the price list.
- Consultation is picked from the Price List (no second service); visit draft autosaves, including SOAP notes; pop-ups open on top of each other correctly.
- Silent printing (no about:blank page) and a minimum print size of 10 pt; 80 mm visit-summary slip and sick-off sheet.
- Staff: click a name to edit every detail; every tab (including new ones such as Price List) can be given to any role.
- Kenya starter catalogue (medicines, services, lab, imaging), Services Catalogue, Price List, 429 ICD-10 categories, referral hospitals, typing dropdowns, prescribing safety checks, edit/remove of preloaded lists, AI insights (needs your Gemini key), Patient Bills pop-up, Patient Database, 16 clinical forms.
- Staff chat (new table `0020_chat.sql`), staff photo + five employment types (self-creating side table, nothing to migrate).
- No public website or Website Management tab (this is the HMIS only).

## Left out on purpose
Cherish Healthcare logo/theme/splash, the domain redirect (hmis.<domain>), the standalone-only 404 for the Owner Console.

## Deploy
Run the usual routine (unpack, robocopy, switch-account, npm install, npm run check). **New migration 0020**: `npx wrangler d1 migrations apply mydukapos-ledger --remote`. Then `npm run deploy:router` is not needed; `npm run deploy:fast`.

## Zip 353 - a demo for every service business
New public demos (password 0000) beside the existing salon one, each with its own price list, customers, vehicles/devices and jobs at different stages:
demo-services (Salon & Spa), demo-carwash, demo-phonerepair, demo-garage, demo-barber, demo-laundry, demo-cleaning, demo-electronics, demo-tailoring.
They appear in the demos gallery automatically (17 demos in all). After deploying, open Owner Console > Website > Shared live demos and press "Create / refresh all demos": the seed version was raised so every demo refreshes.
No new migrations. Normal shops are untouched: the sample-job code only runs on a demo address.
