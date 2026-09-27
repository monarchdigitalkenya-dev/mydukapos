# Zip 143 — System-wide audit: roles, Owner Console connectivity, no reverts, security, scanners

Zip 143 includes zips 131–142. Every fix below was reproduced on Zip 142 first (a test that fails there and passes here), then the
whole suite was run again.

## 1. Staff see only the tabs they were given — the Sales Counter included
* The Sales Counter was "always included": for staff it could never be locked. A staff member NOT given it still landed on the till
  at start-up (button hidden, till showing), and a barcode scanned on any tab opened it.
* Now it is a tick-box role like every other tab, in all 7 apps and the Owner Console (🔗 Generate Link):
  * a staff member lands on the **first tab they were given**, never on one they were not;
  * a scan, "add to cart" from a booking / prescription / production screen, or a Gas-Refill switch-off never opens the till for
    someone without it (they are told why);
  * a staff member with **no tabs** sees "No tabs have been given to your account yet — ask the admin", not a tab's contents;
  * a **Secondary Admin** (given Settings sections) now sees the ⚙️ Settings button — it was always hidden, so the feature could not be used;
  * the owner / admin is unchanged: every tab, and the till can never be locked for them.
* Existing staff keep what they had (they were already migrated once to have the Sales Counter ticked). Owner Console staff are
  migrated once the same way. After that, unticking sticks.
* Wording changed: "Allowed tabs (tick every tab this person may use — including the Sales Counter)". The user guides say the same.

## 2. Owner Console "connect to the internet" with working internet — the causes
1. **The licence check (every 30 s) took any server hiccup as the licence answer.** A 5xx or a Cloudflare error page made the console
   (and every POS app) lock with "This link isn't recognized" or, with an older saved checkpoint, "This device is offline … connect to
   the internet". Only a real licence answer is believed now; a hiccup keeps the last real answer. `license-status` answers 503 when
   storage fails instead of crashing.
2. **Every failed request said "check your connection"** — a server error, an ended session, a rate limit, a slow endpoint. Now the
   message says what happened: offline (checked by the connectivity manager), *the server had a problem (error 500) — your internet
   works*, *your session has ended*, *too many requests*, *the server took too long*. Same in the 7 POS apps (~190 messages).

## 3. No reverts
* **Owner Console (own shop):** an edit not yet on the server (inside the 300 ms before its push, a push on its way, or a push that
  failed) was overwritten by the next 7-second pull — the edit "reverted". Now a pull is applied only when everything this device
  changed has reached the server; otherwise the change is sent first. Reproduced on Zip 142 ("New name" → "Old name"); fixed.
* The POS apps already had this protection (tests `e2e-revert`, `stock-take-sync`, `two-devices`) — all still pass.

## 4. Security
* **Stored XSS into the Owner Console (critical).** `escapeQuotes` only escaped `'`. A shop's business name, a client's name or a
  public website / WhatsApp lead containing `"`, `\'` or `&#39;` ran script in the owner's browser (where the owner session lives).
  The console now uses JavaScript + HTML escaping inside handlers and `escapeHtml` in `value="…"`. The shared POS helper had the
  `&#39;` hole too — fixed.
* **Forged payment confirmations.** Anyone who knew a shop's id could post a fake C2B/KCB "payment received" and make a made-up M-Pesa
  code pass `/api/mpesa-verify`, or mark an STK prompt paid. Callback URLs now carry a per-shop secret key.
  **Backward compatible:** a shop keeps working exactly as before until its URLs carry the key — STK prompts get it automatically;
  **press "Register Till URLs" once** (Settings ▸ Payment Gateway) to protect till/paybill (C2B) payments; KCB: save the KCB
  settings once and give KCB the new IPN URL shown there.
* **Wrong-password limit** on the owner sign-in, website/demo account sign-in and recovery password checks (only failed attempts
  count; per IP and per account per hour).
* **image-proxy** needs a valid shop link (it was open to the internet) and checks every redirect.

## 5. Barcodes
* Scanned digits no longer land in the field that had the cursor (cash tendered, quantity, price) as well as adding the item.
* A slower scanner (Bluetooth on Android) or a code typed by hand + Enter in the Sales Counter search adds the exact item.
* **Aqua POS had no scanner handling at all** (Settings said it did) — added.
* Online lookup: 4-second limit per source, results cached for every shop (the free 100/day UPCitemdb allowance is not spent twice),
  codes validated; a slower answer for an earlier scan can no longer fill in the item scanned since, or replace a name typed meanwhile;
  offline goes straight to manual entry. The lookup never sets VAT — the toast now asks to check the VAT class.

## Deploy
`npm run deploy:router` is **not** needed (no Durable Object changes). `npm run deploy`.
After deploying: shops that take till/paybill payments should press **Register Till URLs** once.
