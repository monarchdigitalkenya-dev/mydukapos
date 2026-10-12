# Permanent Shops Backup & Restore (zip 259)

Owner Console -> **Permanent** tab -> **Download Permanent Shops Backup** / **Restore Permanent Shops Backup**. Owner session only (`/api/owner-backup`, `no-store`, nothing logged).

## Where a permanent shop's data really lives (checked in the code)
| Where | What | In the package |
|---|---|---|
| KV | licence `license:<id>`, subdomain `slug:<slug>`, licence index, `pos-data:state:<id>` + archives + mode flag, receipts, QR menus, till / M-PESA records, branch groups, ledger outbox ... | yes (every key that names the shop), licence/slug/index rebuilt on restore |
| D1 `LEDGER_DB` | every table with a `client_id` column (sales, payments, bills, returns, stock, orders, payroll, chama, LPG, till ...) - table layout is read from the live database and shipped in the package | yes |
| D1 `LEDGER_AUDIT_DB` | append-only audit rows | yes (restored first) |
| Durable Object `SHOP_STORE` | working state of "database" shops | yes |
| R2 `MEDIA` | product / menu / radiology / reference pictures | yes (tick "Include shop pictures"); pictures stored in KV travel with the KV keys |
| KV `demo-account:<email>` | the shop owner's website sign-in (salt + password hash) | yes (sessions are separate keys and are not) |
| D1 `OWNER_DB` | a mirror of the licence index | rebuilt automatically on restore |

## NOT in the package (by design - secrets, sessions, rebuildable)
Payment-gateway credentials (Daraja, KCB, Paystack, Pesapal, Co-op ...), SMS / SHA / eTIMS / e-mail / WhatsApp configuration, callback keys, device pairing, staff sessions and keys, owner sessions, OTPs, tokens, rate-limit counters, the 30 daily KV snapshot copies, demo shops, trashed shops, the platform owner account. The header of the file lists how many records of each secret kind were left out.

## Logins after a restore
- Website sign-in accounts keep their **current password** (salt + hash are restored; no plaintext is ever exported).
- Staff PINs and shop passwords are hashes inside each shop's data: **unchanged**.
- Sessions are not carried over: everyone signs in **once more**.
- Payment credentials are **not** carried over: each shop re-enters them (Settings -> Payment Gateway) and runs **Register Till URLs** again.
- The platform owner account is created again in the new deployment (first-run sign-up with `OWNER_SETUP_TOKEN`) - you need to be signed in as that owner to restore.

## Secrets / settings to configure separately in the NEW account (never in the package)
`PAYMENT_SECRETS_KEY` (+ `PAYMENT_SECRETS_KEY_OLD` if used), `STAFF_SESSION_SECRET` (if you set it), `ROUTER_SHARED_SECRET` (Pages and router Worker must match), `OWNER_SETUP_TOKEN`, `TURNSTILE_SECRET`, WhatsApp / SHA / UPCitemdb variables if used, `ROOT_DOMAIN`, `PAY_CALLBACK_ORIGIN`. Bindings: KV `mydukapos_kv`, D1 `LEDGER_DB`, `LEDGER_AUDIT_DB` (and `OWNER_DB` if used), R2 `MEDIA`, Durable Object `SHOP_STORE`/`SYNC_ROOM` (router Worker deployed), wildcard DNS + routing for `*.<root domain>`.

## Blockers / limits you should know before relying on it
1. **A restore needs the new deployment's resources to exist first** (KV, D1, router Worker for database-mode shops, R2). The preview refuses to proceed and says which one is missing.
2. **Payment credentials cannot move** (they are sealed with the old account's secret). Plan a short re-entry per shop.
3. **Safaricom**: Till/C2B URLs are registered per shortcode with the OLD hostname. The URLs are the same if the domain is the same; if the domain changes they must be re-registered (Safaricom allows registering once - ask Safaricom to reset/delete first).
4. The package holds customer and sales data. A very large deployment produces a large file (pictures are the bulk: untick them and copy the R2 bucket separately if needed). The browser builds the file in memory.
5. Restored ledger rows create fresh audit entries in the new deployment ("restored now"); the old audit rows are restored too, so both exist.
6. Shops are restored whole: it does not merge a shop into one that already exists under a different identity - that is a conflict you resolve (skip / overwrite).

## How to test safely (test deployment)
1. Create a throw-away Pages project + KV + D1 (+ router Worker if you use database shops) - **not** the production ones.
2. Sign in to the OLD console, Permanent tab -> **Download Permanent Shops Backup**. Wait for "Complete." (any "INCOMPLETE" means do not use the file).
3. Sign in to the TEST console (first-run owner sign-up), Permanent tab -> **Restore Permanent Shops Backup** -> choose the file. Read the preview (integrity, shops, status, blockers). Restore. Check the per-shop table says `ok`.
4. Open `https://<slug>.<test-domain>/?c=<id>` for a shop, sign in with the existing password / PIN, compare sales and stock with the old one.
5. Run the same restore again: every shop shows "Already here" and nothing is duplicated.
6. Delete the test resources.

## Real move (steps, split by deployment)
**Old deployment (do not change anything there):** step 2 above, keep the file safe. Optionally also Settings -> Storage -> database backups.
**New deployment:** create resources + secrets (list above) -> deploy -> point wildcard DNS / routing -> create the owner account -> Restore -> per shop: re-enter payment credentials, Register Till URLs, have staff sign in once.
