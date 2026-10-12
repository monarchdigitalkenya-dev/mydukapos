# Till Payments (zip 259)

Money a customer pays straight to the shop's M-PESA Till (no STK push), received by the Daraja **C2B** confirmation callback and linked by a cashier to a bill or an M-Pesa sale.

## Flow
1. Customer pays the Till. Safaricom POSTs the confirmation to `/api/pay-cb-till-confirm?c=<shop>&k=<key>` (`mpesa-c2b-confirmation.js`). The key is checked; an unsigned post is parked in KV for 30 days and never listed.
2. One row is inserted into D1 `till_payments` (`INSERT OR IGNORE`, key `(client_id, code)`). A repeat from Safaricom changes nothing. Stored: code, amount, Safaricom payment time (EAT), name, bill reference, masked phone hint, received time. Not stored: the raw body, shortcode, org balance, full phone (v2 sends it hashed - dropped).
3. Sales Counter -> Till Payments calls `GET /api/till-payments?status=&before=&limit=` (newest first by payment time, 25 per page).
4. Match -> Apply calls `POST /api/till-payments {action:'apply', code, targetType:'bill'|'sale', targetId}`. The server claims the code in `mpesa_code_claims`, then flips UNLINKED -> APPLIED once. Only if that succeeded does the till record it: a bill goes through the app's own bill-settlement code (balance, status, instalment record, tokens, e-TIMS), a sale gets the code as its verified M-PESA receipt. If the local step fails the server link is released (`action:'release'`).
5. Retention: APPLIED rows older than 180 days are deleted (bounded, at most once a day per shop, on a list call). UNLINKED rows are never deleted. `ledger_gateway` (append-only) keeps the received-payment record; the bill / sale keeps the code.

## Cost
No new service or binding. One small table, a primary-key insert per callback, indexed reads only when the screen is opened (plus one when the Sales Counter loads, for the badge). No Safaricom polling.

## What the owner must have in place (production)
- Daraja app with the **C2B** product enabled for the live Till; production credentials saved in Settings -> Payment Gateway (server side only).
- **Register Till URLs** run once. Safaricom registers URLs once per shortcode; to change them the registered URLs must first be deleted/reset through Safaricom. Production C2B registration/activation may need Safaricom approval (Daraja "Go Live", C2B enabled on the shortcode).
- Cloudflare WAF custom rule: URI path starts with `/api/pay-cb-` + POST -> Skip (see `DARAJA_GO_LIVE.md`).
- Registration uses C2B **v1** by default. For v2 set the Pages secret `DARAJA_C2B_VERSION=v2` and register again (the phone number then arrives hashed, so the list shows no phone hint).
- Migration is optional: `migrations/0013_till_payments.sql` (the server also creates the table on first use).

## Not covered
A QR/guest order is linked through the sale that pays for it (the existing QR `confirmPayment` flow); a Till payment is not applied to an order directly. A payment is applied whole to one bill or sale (no splitting one payment across several).
