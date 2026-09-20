> **DECISION (owner): server-verified logins are NOT going to be built.** The tills must sign in and keep working with no
> internet, and a login that has to be checked by the server can't do that. This file is kept only as a record of the
> exposure (a shop's link is its only server-side credential) and of what was done instead. What ships now — none of it
> needs the server at sign-in time: per-shop hourly SMS / M-Pesa caps, `pos-sync` CORS limited to your own domains, the
> last writer IPs per shop in the Owner Console 💾 Storage tab, size guards, and real SHA-256 for local password hashing.
> If you ever want stronger protection that still works offline, the option to revisit is a per-shop secret key stored on
> each paired device (checked by the server on sync only, never at sign-in).

# Sync authentication — design & rollout plan

**Status: design only — the login/session part is NOT built. Shipped since this was written (zip 24): `Access-Control-Allow-Origin: *` removed from `pos-sync` (own domain family only), per-shop hourly SMS / M-Pesa caps, a trail of the last writer IPs per shop (Owner Console 💾 Storage tab), and a real SHA-256 fallback for password hashing. Everything below about tokens and sessions is still design only.** It changes how every user logs in and touches ~25
endpoints, so it should be built against a staging copy, not shipped blind to live shops.

## The problem (verified in the code)

A shop is identified **only by its link** — the subdomain (`georgehardware.mydukapos.store`) or `?c=<id>`. There is no
credential on the API. `functions/api/_license.js → requireValidLicense()` checks that the link is *active*, never *who is
calling*. So anyone who knows or guesses a link can call, with no login:

| Endpoint | What an anonymous caller can do |
|---|---|
| `pos-sync` GET / `sync-ws` | Read the whole shop: sales, customers, staff, **password & PIN hashes** |
| `pos-sync` POST | Overwrite any of it (inventory, staff, password hash → take over the shop) |
| `backups` | Download/restore daily snapshots |
| `sms-send`, `mpesa-stkpush` | Send SMS / trigger M-Pesa prompts using the shop's configured credentials |
| `print-relay`, `receipt-settings`, `till-payments`, `payment-accounts`, `store`, `branches`, `cross-branch-sale`, … | Read/alter shop-level data |

Passwords are also plain unsalted SHA-256 (`hashPassword` in each app) and the hash is synced to every device, so anyone
who reads it can recover a 4-digit PIN instantly.

**Already reduced (deployed with zip 5):** a push can no longer blank the password hashes / business name
(`NEVER_BLANK_FIELDS` in `pos-sync.js`). That fixes accidental damage; it does *not* stop a deliberate caller.

## Target design

1. **Server-held credentials.** New KV record `auth:<clientId>` (separate from the synced state, never returned by any
   GET): per-account `{ role, staffId, salt, hash }` using PBKDF2/scrypt with a per-account salt.
2. **Sessions.** `POST /api/session` `{ account, password }` → server verifies → returns a signed token
   (`HMAC-SHA256`, secret in Pages env `SESSION_SECRET`) carrying `{ clientId, role, staffId, exp }` (e.g. 12 h, refreshed
   while active). Sent as `Authorization: Bearer …`; the WebSocket passes it as a query param on the upgrade.
3. **Split the read.** Login pickers need the staff *names* before anyone has signed in. Add `GET /api/pos-login-info`
   → `{ businessName, staff: [{id, name}] }` only. Full `pos-sync` GET/POST and the ~25 link-only endpoints require a
   valid token whose `clientId` matches the link.
4. **Role checks server-side.** Staff tokens can't call admin-only endpoints (backups, payment-accounts, gateway/SMS
   config, staff/branch management) — today those rules exist only as hidden buttons.
5. **Offline still works.** After a successful online login the device caches a *locally salted* verifier so the till opens
   with no signal, exactly as now; sync simply waits until it can obtain a token.
6. **Remove secrets from synced state.** Drop `pwHash`, `adminPwHash` and staff `pinHash` from `collectSyncPayload` /
   `applyRemotePayload` once every app version in the field uses sessions.

## Rollout (so no live shop is locked out)

1. **Staging first.** Create `mydukapos-staging` (separate Pages project + KV namespace); run the jsdom smoke tests and a
   manual login/sync/print pass on every app.
2. **Per-shop flag.** `authMode: 'legacy' | 'enforced'` on the license record. `legacy` = today's behaviour (default).
   Turn `enforced` on for your own demo shop, then one friendly shop, then everyone.
3. **First-login migration.** The first admin login after an app update sends the password once to `/api/session`; the
   server creates the salted credential from it (staff PINs migrate the same way on their first login). No password resets.
4. **Grace period, then enforce.** After all shops are `enforced`, delete the hashes from synced state and reject
   token-less calls.

## Decisions needed from you

* Session length (12 h suggested) and whether staff sessions should end at clock-out.
* Whether to enforce per-shop (safest) or all at once.
* Do you want a Cloudflare staging project set up? Everything above depends on being able to test against one.

## Smaller hardening that can ship independently

* Restrict `Access-Control-Allow-Origin: *` on `pos-sync` to the shop's own origin (blocks other websites reading a shop's
  data from a visitor's browser; doesn't stop direct calls). Needs a check that no app legitimately calls across origins.
* Rate-limit `sms-send` / `mpesa-stkpush` per shop per hour and alert the owner on spikes.
* Log every non-GET `pos-sync` call's source IP/country for later forensics.
