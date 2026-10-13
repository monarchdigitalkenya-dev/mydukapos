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

## Secret keys and billing (zip 267, optional, locked with your passphrase)
The download dialog has **Include secret keys** (ticked by default) and asks for a passphrase of at least 10 characters (typed twice). With it the file also carries, for every permanent shop:
payment-gateway, SMS, SHA, eTIMS and image-search credentials, **callback keys** (so URLs already registered with Safaricom / Paywave keep working), device pairing and staff signing keys. Plus **Include prices, discounts and the payment ledger** (Billing settings, offers and use counts, ledger / audit / payment markers); the referral-code index is rebuilt from each shop's record.
- The secrets are locked in the browser (PBKDF2 + AES-GCM) before they reach the file. **Nobody can recover a lost passphrase.**
- Gateway and SMS records are sealed in KV with `PAYMENT_SECRETS_KEY`; they travel opened and are **sealed again with the new deployment's key**, so the new key may differ.
- Restore asks for the passphrase; a wrong one stops everything before any change. Billing data never overwrites what the new deployment already has (use counts keep the larger number).
- Untick the box for the older, secret-free file. Anyone holding the file AND the passphrase can use the shops' payment accounts: store both separately.

## NEVER in the package (sessions, caches, rebuildable)
Staff / website / owner sessions, the owner account itself, OTPs, pairing codes, rate-limit counters, tokens and daily KV snapshot copies. They are counted in the file header so nothing is silently missing.

## Logins after a restore
- Website sign-in accounts keep their **current password** (salt + hash are restored; no plaintext is ever exported).
- Staff PINs and shop passwords are hashes inside each shop's data: **unchanged**.
- Sessions are not carried over: everyone signs in **once more**.
- Payment credentials and callback keys **are** carried over when the file was made with secret keys included; otherwise each shop re-enters them and runs **Register Till URLs** again.
- The platform owner account is created again in the new deployment (first-run sign-up with `OWNER_SETUP_TOKEN`) - you need to be signed in as that owner to restore.

## Secrets / settings to configure separately in the NEW account (never in the package)
`PAYMENT_SECRETS_KEY` (+ `PAYMENT_SECRETS_KEY_OLD` if used), `STAFF_SESSION_SECRET` (if you set it), `ROUTER_SHARED_SECRET` (Pages and router Worker must match), `OWNER_SETUP_TOKEN`, `TURNSTILE_SECRET`, WhatsApp / SHA / UPCitemdb variables if used, `ROOT_DOMAIN`, `PAY_CALLBACK_ORIGIN`. Bindings: KV `mydukapos_kv`, D1 `LEDGER_DB`, `LEDGER_AUDIT_DB` (and `OWNER_DB` if used), R2 `MEDIA`, Durable Object `SHOP_STORE`/`SYNC_ROOM` (router Worker deployed), wildcard DNS + routing for `*.<root domain>`.

## Blockers / limits you should know before relying on it
1. **A restore needs the new deployment's resources to exist first** (KV, D1, router Worker for database-mode shops, R2). The preview refuses to proceed and says which one is missing.
2. **Payment credentials move only in a passphrase-locked file** (see above). A record already unreadable on the old side (its key lost) is flagged and cannot be opened.
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

## Platform settings (zip 268)
With *Include prices, discounts, payment ledger and platform settings* ticked the file also carries the deployment-wide settings: website text and marketing, catalogue, offers, app releases, demo duration, storage settings, owner messages, WhatsApp ad numbers and the purchase index. With a passphrase it additionally carries the Gemini key pool and the e-mail sender settings. Restore never overwrites a setting the new deployment already has.

## Migration-day runbook (in this order)
1. **Old console**: Permanent tab -> Download Permanent Shops Backup, keep *secret keys*, *platform* and *pictures* ticked, choose a passphrase, wait for "Complete." Keep the file and the passphrase apart. Do not change anything on the old deployment from now on.
2. **New Cloudflare account**: create the Pages project from the zip, the KV namespace (`mydukapos_kv`), D1 `LEDGER_DB` (+ audit DB), R2 `MEDIA`, the router Worker and bindings; set secrets `PAYMENT_SECRETS_KEY` (any >= 24 random characters; it may differ from the old one), `ROUTER_SHARED_SECRET` (same on Pages and the Worker), `OWNER_SETUP_TOKEN`, `STAFF_SESSION_SECRET` if you used it, Turnstile secret if used. Point `ROOT_DOMAIN` / the wildcard route at the new project.
3. **New console**: first-run owner sign-up with `OWNER_SETUP_TOKEN`, then Permanent tab -> Restore, pick the file, type the passphrase, read the preview, restore, wait for "All restored shops verified".
4. **Check**: open two shops by their permanent links, sign in with the old password / PIN, open Till and Billing, send a test STK.
5. **Daraja / Paywave**: if the domain is unchanged the registered callback URLs keep working (callback keys travelled). If the domain changed, register the Till URLs again from each shop.
6. **Switch DNS** last; keep the old deployment untouched for a week as a fallback.
