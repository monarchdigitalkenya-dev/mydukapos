# Zip 155

## New
1. **Receipt stamp (all 7 modules)** — Settings → Receipts → "Receipt Stamp". Type text (box or oval, choose ink colour) or upload a photo of your stamp (paper becomes transparent). It prints just above the item lines, slightly tilted like a real stamp (angle and size adjustable). Works on screen, PDF, system print and thermal (raster).
2. **Bills lock (all 7 modules)** — Bills tab, admin-only switch, OFF by default. When ON: staff can only VIEW bills (Settle / Void / Edit / Carried are hidden and refused); the admin needs the admin password (then a 3-minute pass). Turning it off also needs the password.
3. **Delivery** — optional ID number and notes. The delivery receipt now prints a DELIVERY DETAILS block and a DELIVERY CONFIRMATION block with signature lines (client + delivery person). Two receipts print automatically: CLIENT COPY and DELIVERY PERSON COPY, each to be signed.
4. **Native apps (APK / EXE)** — a "Can't reach your shop" screen with automatic retry replaces a blank page when there is no internet; "Use a different shop link" is on it.

## Fixed
5. **Logo and receipt settings now carry to every device, including the phone/PC apps.** Cause found: the Owner Console pushed blank defaults before its first pull and overwrote the shop's logo, footer, payment details, tab locks etc. Now settings are time-stamped per field (Owner Console + shop apps), and the server never lets an unstamped blank replace a shop's saved value.
6. **A new Owner Console device that pushed before its first pull marked itself "up to date" and never loaded the shop's data.** Fixed.
7. Safety: the server only holds back a BLANK, unstamped setting (a fresh-device default). A filled-in edit is never dropped, and a device with no baseline now gets one after an "unchanged" pull, so its first edit is stamped. The Owner Console leaves unchanged settings out of its push until it has applied its first pull.
8. Stamp, bills-lock and receipt settings are synced (`SETTINGS_NEED_STAMP_FIELDS` in `functions/api/_merge.js`).

## Persistence / balance audit (items 7 and 8)
New test `zip155-nothing-lost`: change price + quantity, make a cash sale and a bill, refresh with the server down and up — price, qty, sales and bills are all still there; stock = opening + every movement; ledger integrity passes. Existing suites (stock-take sync, e2e-revert, bill-settle, hidden-sales) also pass.

## D1
Already on D1: ledger, Store (warehouse), QR orders. Shop working state stays on KV for now: it is protected by the stock ledger and forward-only merge rules, and moving live money data was NOT done blind in this zip. Recommended next step (zip 156): move `salesLog` and `bills` to D1 tables with KV kept as fallback.

## Not included / limits
- The print relay sends text only (no stamp / logo). Thermal printing directly and system print carry both.
- Delivery payment (POD) is not blocked by the bills lock, so delivery agents can still collect.
