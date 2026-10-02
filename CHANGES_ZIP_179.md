# Zip 179

## 1. Sign-up: only the WhatsApp number is required
- Website form (`public-site/app.html`) and the sign-up form in all 7 POS apps: **WhatsApp number required, email optional**. A wrong-looking email is refused (not silently ignored); blank is fine.
- Server (`_account.js`, `demo-account.js`): an account with no email is stored under `<number>@phone.mydukapos.invalid` (never mailed). Numbers are normalised (`0712…`, `+254…`, `712…` are the same person) and one number = one account.
- **Sign-in accepts the WhatsApp number or the email** (website dashboard and API). Works for every account, old or new.
- Phone-only accounts: the dashboard shows the number instead of an email; email verification is refused with a clear message (use WhatsApp); "forgot password" explains they should message us on WhatsApp (no email to send to). POS device recovery-email linking is skipped when no email was given.

## 2. Login online and offline
- The till password is checked on the device, so it works offline, and the phone-only change does not touch that. Covered by `tests/login-online-offline.test.mjs` (14 tests) and the website dashboard keeps the sign-in when offline.

## 3. STK push showing "unverified" — cause and fix
- **Cause:** the app never marked an STK sale as verified itself. Every sale started "not verified" and only turned green when a background lookup (`/api/mpesa-verify`) found the receipt in the server index. Until then (callback a few seconds late, lookup delayed by the backoff, device briefly offline) the Daily Sales banner said "M-Pesa payments not verified".
- **Fix** (`mpesa-verify.html`, all apps): when the STK status poll confirms the payment (the shop's own signed Safaricom callback), the receipt is remembered; the sale carrying that receipt for ≤ that amount is marked verified at once (`source: stk-confirmed`), once per receipt. A typed code is still only proof after M-Pesa confirms it.
- Test: `tests/zip179-whatsapp-signup.test.mjs`.

## 4. Order ticket / receipt: nothing may sit above the first line (system print)
- Measured the ticket and the receipt in print layout in all 7 apps: the app's own layout puts the first line at the top edge, so the extra space comes from the page around it. Hardened that:
  - While a receipt / order ticket / report prints, the page body is flattened (no flex column, no `min-height:100vh`, no bottom padding for the floating buttons, no margins), so no screen layout can add paper above or below the slip.
  - The ✕ close button no longer prints (it was printing at the top-right of receipts in Water, Hotel, Hospital, Pharmacy, Production and Services).
  - A logo / QR that has not loaded yet is counted when the page length is measured (a receipt with a logo could spill onto a second page).
- Still true: the page can never be shorter than the roll is wide (zip 170/175, so the printer does not turn the ticket sideways), so a short ticket on an 80 mm roll is a 80 x 80 mm page. That blank length is at the END of the ticket, not the top. If your printer driver still shows space above, tell me the printer model and the paper size chosen in the Chrome print window.

## 5. Verification is not offered and never forced (set it up later)
- Nobody is ever blocked: `generate-demo` only refuses unverified accounts when `VERIFICATION_REQUIRED=1`, which is not set.
- The dashboard's "Verify your account" box (email / WhatsApp code) is now hidden unless the secret/variable `SHOW_VERIFY_UI=1` is set, so no half-configured WhatsApp button can show an error.
- When you are ready: finish WhatsApp (template approved, token, phone ID), set `SHOW_VERIFY_UI` = `1`, test, and only then (optional) `VERIFICATION_REQUIRED` = `1`.

## 6. Zip 180 — Sales Counter: cart first, price menu on every module
- **Cart is clearly visible**: the cart list is now at least 230px tall (150px on short screens) and the payment area is tighter, so several lines show at once.
- **Hold sale / Held** moved out of the cart area into the checkout card header (small pill buttons next to the item count).
- **Receiving Account** is hidden on the Sales Counter in every module. Sales go to the default account.
- **Price is a real button on every module** (Shop, Water, Pharmacy, Production, Services, and now Hotel and Hospital): click it and pick **Retail**, **Wholesale** (greyed "not set" if the item has no wholesale price) or **Custom amount**. The chip shows the current tier. The management-password and minimum-price rules still apply.
- Customer phone label now shows "Customer phone (optional)" correctly.
