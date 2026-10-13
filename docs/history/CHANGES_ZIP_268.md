# Zip 267 - Licensing, subscriptions, offers and referrals

Everything in zip 266, plus the billing system. **Nothing changes for any customer until the owner sets a launch date.**

## Where things live (all KV; no new tables, so no migration)
| Key | What |
|---|---|
| `billing-settings:v1` | the ONE pricing source, launch date, kill switch, grace, allowances, referral rules |
| `billing-offers:v1` | discounts / codes |
| `license:<id>.billing` | one shop's subscription: agreed price, paid-through, add-ons, history (60), rewards (50), referral code. **Absent = exempt.** |
| `bill-ref:<ref>` | idempotency marker for one payment event |
| `bill-evt:` / `bill-aud:` | the owner's ledger and audit trail, newest first |
| `bill-refcode:<CODE>` | referral code -> shop |
| `bill-pay:<id>` | a renewal / add-on payment in progress |

Code: `_billing-core.js` (pure rules, no imports), `_billing.js` (storage and flows), `_pay-owner.js` (paying into the owner's gateway), endpoints `billing-terms` (public prices and quotes), `billing-renew` (a shop's own plan), `owner-billing` (owner only). Shared UI block `my-plan` in every POS app; the Billing tab in the Owner Console.

## Defaults (editable under Billing -> Pricing)
New link or branch link KES 3,000 once. Subscription KES 400 per 31 days per shop. Extra branch KES 1,000. Bundle of 3 branches KES 3,000. 5 staff places KES 500 (shared across branches). Included: 3 branches (the main shop counts as one) and 5 staff per branch. Grace 3 days.

## Decisions taken (change them in Billing if you disagree)
* A branch bought as a link costs the same as a new link (your answer); the extra-branch KES 1,000 and bundle are for adding branches inside a subscribed shop.
* A branch bought by a shop that predates billing stays exempt with it; a branch of a subscribed shop follows the main shop's plan and counts as one more licensed branch.
* The plan is exactly 31 days per cycle (12 Oct -> 12 Nov holds because October has 31 days; other months drift against the calendar).
* A renewal inside grace continues from the paid-through date; a shop already paused starts again from now.
* A referral reward is a discount on the referrer's next renewal (or an add-on). A shop that predates billing has nothing to discount, so its reward waits; it is never forced onto a subscription.
* Referral rewards are OFF until the owner turns them on.
* The old `includedDays: 60 / monthlyFee` website fields and the zip 263 Prices tab are replaced by Billing. The public site reads the same source.

## Rollout
1. Deploy. Open Owner Console -> Billing. Review Pricing; open Launch & exempt shops and read "Who is affected".
2. Optional: press "Mark existing shops exempt on record" (additive; the shops are exempt either way).
3. Save a launch date (Nairobi time). Links whose payment is confirmed on/after it start a subscription.

## Rollback (nothing is deleted)
* Billing -> Launch -> **Switch billing off** (clears the launch date): no new subscriptions, nobody blocked, within 30 seconds.
* Or untick **Block shops whose paid period and grace have ended**: subscriptions are tracked and shown but never block.
* Every licence, payment, price snapshot, reward and shop record stays. Per shop: Suspend / Reactivate, Complimentary, Exempt.

## Server enforcement
`requireValidLicense` (43 endpoints) returns `subscription_suspended` for a subscribed shop past paid-through + grace, only when billing is live and blocking is on. No per-request writes; one cached 30 s read of the settings, only for a shop that has a billing record. `license-status` and `billing-renew` stay reachable so a paused shop can always pay. A device's queued sales are never discarded.

## Independent review and what it changed
A separate reviewer read the billing code cold. Confirmed and fixed (each has a regression test in `tests/zip267-billing-flows.test.mjs`): a branch made with Add Branch never got a plan; group sync overwrote a branch's own history, rewards and referral code and an edit made on a branch could overwrite the main shop's; a reward could be spent by two payments; a retry could add a branch, time or an offer use twice; two overlapping requests could make two shops for one payment (now the shop id is derived from the purchase); a failed upgrade could leave a permanent shop with no billing; a double-clicked manual confirmation counted twice; offer limits were checked only when quoting; a payment for a shop on hold was silently absorbed; public price/code checks were not rate limited; and a phone number alone could attach a purchased link to someone else's shop (it now needs that shop's Admin password).

## Unresolved / known limits
* **Staff allowance is shown and sold but not enforced.** Staff live in each shop's own synced data and are added offline; blocking them server-side needs a router change. The owner panel shows use for shops in the default storage mode (n/a for shops moved to their own database).
* If Safaricom/Paywave deliver both an STK result and a Till confirmation for one payment, the older money ledger may count it twice (pre-existing).
* The shared client index (`license-index:v1`) is one JSON list rewritten on every save; two simultaneous saves can lose one entry (pre-existing). The licence records themselves are not affected.
* The "you may already have a shop" question still tells a visitor that a phone number or email belongs to a customer (the shop is never named); attaching now needs the Admin password.
* KV has no compare-and-set: two simultaneous callbacks for one payment could race; the idempotency marker is checked as late as possible and a failed save withdraws it so a retry completes.
* No live payment was made in testing; Paywave/Daraja behaviour was exercised with simulated gateway replies.

- **Permanent Shops Backup now carries secrets and billing (optional, passphrase-locked).** Download dialog: *Include secret keys* (gateway, SMS, SHA, eTIMS, callback keys, device and staff keys; locked in the browser with PBKDF2 + AES-GCM, passphrase >= 10 characters) and *Include prices, discounts and the payment ledger*. Gateway/SMS records are sealed again with the NEW deployment's `PAYMENT_SECRETS_KEY` on restore; a wrong passphrase aborts before any change; billing data never overwrites the target's; referral-code index rebuilt. Package version 2 (version 1 files still restore). Test: `tests/zip259-shop-backup.test.mjs` (real Chromium, different keys on both sides). See `docs/SHOP_BACKUP_RESTORE.md`.
