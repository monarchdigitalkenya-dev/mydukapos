# Daraja (M-Pesa STK push) - going live with production keys

Settings > Payment Gateway > Option B (Daraja). Needs the Admin password / a manager PIN every time (zip 247).

## What to paste
| Box | Paybill | Till (Buy Goods) |
|---|---|---|
| Environment | Production | Production |
| Consumer Key / Secret | from your **production** Daraja app | same |
| Shortcode | the Paybill number | the **Store / Head Office number** from your Safaricom go-live email |
| Passkey | the **production** Lipa Na M-Pesa passkey from the go-live email (not the sandbox one) | same |
| Transaction type | Paybill | Till Number |
| Till number | (hidden) | the Till number customers pay to. Leave empty only if it is the same as the Store number |

Then **Force a specific provider > Always use Daraja** (a saved Paystack key otherwise wins).

Pasting production keys over sandbox keys applies at once. Once production keys are saved, replacing them is held for `PAYMENT_CHANGE_COOLDOWN_MIN` minutes (default 60) and the owner is alerted - that is the zip 247 protection and is intentional.

## Cloudflare: let Safaricom's callback in
Safaricom POSTs the result to `https://<host>/api/pay-cb-stk?c=...&k=...` (zip 250: the address must NOT contain the words mpesa / m-pesa / safaricom - Safaricom's production system drops those; the old `/api/mpesa-callback` route is kept only for prompts sent before). For Daraja the sale is only marked paid when this callback arrives (the status poll can mark a prompt failed, never paid, because only the callback carries the M-Pesa receipt number).
If a customer pays but the till keeps waiting, Cloudflare is almost always blocking that POST:
1. Cloudflare dashboard > the domain > Security > Events: look for blocked requests to `/api/mpesa-callback`.
2. Security > WAF > Custom rules > Create rule: URI Path **starts with** `/api/pay-cb-` AND Request Method **equals** POST > Action: **Skip** (all remaining custom rules, Bot Fight Mode / Super Bot Fight Mode, rate limiting rules).
3. If Bot Fight Mode is on and cannot be skipped by a rule on your plan, turn it off for the zone while testing.
The same rule covers `/api/pay-cb-till-confirm` and `/api/pay-cb-till-validate` (direct Till / Paybill payments).

## Direct Till payments (customer pays the Till without a prompt)
Settings > Payment Gateway > **Register Till URLs**, once, after the production keys are saved. It registers the **Till number** (Till shops) or the Paybill, with neutral addresses (`/api/pay-cb-till-confirm`, `/api/pay-cb-till-validate`). Needs the **C2B** product enabled on your live Daraja app. Production registers a number's URLs once: "Duplicate notification info" means they already exist - delete them under URL Management in the Daraja portal, then press Register again (or email apisupport@safaricom.co.ke). Payments made BEFORE registering are never sent.

## First live test
1. Send a KSh 1 prompt to your own phone.
2. The till should show a prompt on the phone, then "paid" with the M-Pesa code within seconds of entering the PIN.
3. If the send fails, the red message now contains Safaricom's own text and error code (e.g. "Invalid BusinessShortCode [400.002.02]" = wrong Shortcode / Store number for this Paybill or Till).
