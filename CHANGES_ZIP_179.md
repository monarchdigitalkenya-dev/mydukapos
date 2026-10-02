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
- **AquaPOS inventory**: a Wholesale Bale's quantity is now editable directly (halves allowed). The edit is applied to the real stock source: the bale's own bottle count (tracked bales), the linked Sealed Bottle (linked bales, loose bottles kept), or its own quantity. Custom/Executive bales stay made-to-order.
- **Zip 181**: the Sales (and Hotel Bills) buttons moved into the Product Search header; their row is gone so the cart is taller. Hotel's Table / Room picker is now one compact row.
- **Zip 182 — display scale**: on desktop screens (1100px and wider) every POS app is drawn at 80%, like pressing Ctrl and minus twice. Phones, tablets and printing are untouched. To change it, open the app once with `?zoom=90` (or `?zoom=100` to switch it off) on the address; the choice is remembered on that device.
- **Zip 182 — AquaPOS bales**: bale cart lines now have the Retail / Wholesale / Custom price menu. Retail follows the quantity tiers; Wholesale uses the new "Wholesale price / bale" field in the bale's inventory sub-row. A hand-picked price is kept when the quantity changes; picking Retail goes back to automatic tier pricing.
- **Zip 183 — AquaPOS stock edits and removals that "came back"**:
  1. A stock edit made while the **All Sites** view was selected was never saved (that view is a sum and is not written back), so the figure snapped back and the Sales Counter still showed no stock. Edits made there now go to the Shop's own stock.
  2. The bale **Edit pop-up** now takes a quantity for every Standard bale (it was locked for linked and bottle-tracked bales); it is applied to the bale's bottle stock / linked bottle.
  3. Removing an item (or any record) could be forgotten if a sync finished a moment later: the removal was never sent to the server, so the next pull brought the item back. Pending removals are now kept until they are sent. This fix is shared, so it applies to every module.

## Zip 184 - conservative full audit (nothing redesigned)
Fixed (each the smallest change; every other finding is listed in the audit report, not touched):
- Sync: a push whose reply was not JSON (captive portal / proxy answering 200) was marked "sent" before the reply was read, so a sale could stay unuploaded. The reply is now read first (functions.js pushNow). Test: tests/zip184-push-nonjson.test.mjs.
- Sync: a pull failing fast with a non-timeout error retried every 300 ms forever; now it shows the error state and the normal 7 s poll retries.
- Shop checkout: a cross-branch cart line also deducted this branch's own same-coded item (never restored on void). Only local lines deduct now.
- Shop checkout / exchange: split payment rejects negative cash or M-Pesa amounts.
- eTIMS: zero-rated (Z) items were sent to KRA as 16% standard; now sent as the zero-rated bracket.
- image-proxy: SVG no longer proxied (script ran on the shop origin); sandbox CSP + nosniff added.
- paystack-webhook: constant-time signature compare.
- Performance: the product-photo grid is no longer torn down and rebuilt when a cart tap produces identical output.

## Zip 185 - the "deliberately not changed" items, the apps/consoles that were not audited, and the receipt time
Sign-in is untouched: no login, hash, pairing or staff-session code was edited, and no sync reply changed what it carries for sign-in
(the hashes still travel to devices because offline sign-in needs them - see "Decision" below).

### Receipts
- Receipt / bill / exchange receipt date and time now come from the SHOP's time zone (East Africa unless Settings says otherwise), not the clock of the
  phone or PC that printed it (a bill printed 04:28 for a 14:28 sale). `bizReceiptStamp` (shared). Test: tests/zip185-receipt-time.test.mjs (passes under any device zone).
- Right edge cut off / lines on top of each other on thermal paper: the app's own print output was reproduced in a real browser at 58 mm and 80 mm and is clean,
  so those two symptoms come from the printer side. Check (Settings > Receipt / this device's printer): the paper width matches the roll, run "Paper width test",
  and for a printer that holds fewer characters than 48 choose "Custom" and enter its printable width (e.g. 72 mm for 64 mm of head). The relay now also prevents the
  same print job being started twice (services).

### Server security (functions/api)
- Forged payment notices: callbacks for an unknown/unlicensed shop id are ignored; STK callbacks need a pending prompt this shop sent (or a valid key);
  new shops get all four callback keys; bodies capped. Shops created before keys still accept unsigned C2B / KCB confirmations (a real one cannot be told from a
  forged one without a secret in the URL) - to close that: click "Register Till URLs" again (Daraja C2B) and re-save the KCB settings, then give KCB the new IPN URL.
- Account recovery: replacing an existing recovery email needs the current password; login throttling on every password check; link/unlink/change-password are
  device-guarded; unified "Incorrect email or password" for unknown emails; the app's Unlink button now asks for the password. `ACCOUNT_RECOVERY_STRICT=1` requires it for every unlink.
- Gateway settings, branch create/delete and backup restore: manager session required when staff sessions are enforced; hourly/daily caps (env tunable).
- KCB IPN key masked for non-managers when staff sessions are enforced; sessions issued before a password reset are refused; owner sessions issued from now on last 30 days;
  optional `OWNER_SETUP_TOKEN` for first owner signup; device guard on sms-inbound GET, etims-config DELETE, mpesa-stkpush GET; AI-capture rate limit; OTP attempt counting; business name capped.
- Public/owner side: reserved sub-domains (www, owner, admin ...) can no longer be registered; owner "extend" validates hours; CRM log no longer prints query tokens;
  public site escapes image sources / server text and no longer signs out on a 5xx; /api/hit only counts real pages; contact form strips line breaks.

### Sync server
- M-Pesa code can no longer be attached to two sales at once (atomic claim in D1; table `mpesa_claims`, migration 0006 - additive, also created lazily).
- Deleted customers, staff, offers, sites, delivery agents, patients and resources can no longer be revived by a stale till (inventory/categories excluded on purpose).
- Server stamp never goes backwards (KV + shop database); a stock count without a time no longer corrupts stock; counts are never dated in the server's future;
  a re-sent archived movement is dropped; sale edits reverse stale ledger payment rows; cross-branch sale availability check and write are now one step; outbox drop counter; migration needs two quiet reads.
### Client sync
- One push at a time (follow-up push runs after), re-stamping after the in-flight wait, "synced" only when nothing is unsent, collection inside the try block,
  storage retry fixes, socket flap back-off + 15 s flush limit, new items' movements travel in the same batch, `markBulkDelete` for deliberate bulk deletes.

### Money (all POS apps; each fix has a before/after number in tests/zip185-*-money.test.mjs)
- Credit-bill sales now book their cost of goods (payment lines carry `costShare`), profit no longer overstated; bill VAT is split by the real categories.
- Delivery fee is owed on pay-later delivery bills and is counted in Daily Sales; bill reminders / SMS / Deliveries total use the full bill total.
- Offers: saved item lines sum exactly to the amount charged; flat offers cannot push a total below 0; custom quote lands exactly on the quoted total.
- X/Z gross/discount/net are consistent; negative cash/M-Pesa amounts are rejected on every split; fractional returns of weighed goods; exchange credit capped at what was paid;
  exchange no longer pretends to allow negative stock; cross-branch lines never deduct this branch's stock; round2 is half-cent correct.
- App-specific: AquaPOS (All-Sites checkout/hold-release/import, bottle-tracked restock, delivery capture keys, bale half returns, bulk-order deposit/cost, bill void), Hospital (visit medicine
  lines, institution payments, unvoid, refunded void), Pharmacy (prescription stock check, variant stock), Production (BOM floor epsilon, item-code rename, double-tap checkout, materials returned on exchange void),
  Services (job parts stock movements, booking/job/bill status, double relay jobs).
### Performance
- Only the open tab is redrawn after a sale; product-photo grid skips identical redraws and debounces search; one offer evaluation per cart render; fewer forced layouts on clicks;
  customer display / pulled lists skip identical writes (apps where it was safe).

### Decision (sign-in)
- Password / PIN hashes still reach devices through the sync reply: that is how a till signs in with no internet, so removing them would break offline sign-in. Mitigations in place: salted hashes (sealed),
  typed-password proof required for staff sessions / pairing in paired mode / revoke, rate limits. To stop link-only access to a shop's data and hashes, switch the shop to "paired devices only" (Settings > Devices)
  after every till has paired.

### Zip 185 — receipts (added late)
- Receipt/bill/exchange date and time now use the shop's time zone (`bizReceiptStamp`), so a till whose clock/zone is off no longer prints 04:28 for 14:28.
- New per-till **Characters a line** (Auto / 32 / 42 / 44 / 46) under Settings ▸ Receipt ▸ "THIS device's printer paper". Many "80 mm" heads print only 42 characters, which cuts off the right edge (TOTAL, time, VAT AMT). Pick 42 on such a till. Width test now includes a 42 ruler.
