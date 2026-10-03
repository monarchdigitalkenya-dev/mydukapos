# Zip 120 — Paired devices (works offline), device list with app releases, stock-take approval, server-checked X/Z, daily shop health

Builds on zips 118–119. Everything here works **online and offline**. Nothing changes for any shop until you or the shop
switches it on.

## #6 Paired devices — the link alone is no longer enough (optional per shop)
**Why:** a shop was identified only by its link, so anyone who knew it could read or change the shop's data. Tills must sign
in with no internet, so the check is on **syncing**, never on signing in.

* **How it works.** Each device holds its own secret token, and the server keeps only its SHA-256. The device sends it on every
  call to the shop's server and on the live WebSocket (`functions/api/_device-auth.js`).
* **Two modes per shop:**
  * **Open** (the default) behaves exactly as before. Devices still pair themselves quietly in the background with the password
    they already hold, so they're ready.
  * **Paired devices only.** The shop-data endpoints refuse a device without a valid token (HTTP 401 `device_not_paired`). That
    covers sync, history, backups, payment and messaging settings, M-Pesa prompts, eTIMS, SHA, store, branches, print relay, the
    stock check and the day summary — 25 endpoints in all. Payment webhooks stay open, since Safaricom/KCB must reach them.
* **Pairing a new device.** The shop password once, **or a 6-digit pairing code** made on a paired device (valid 10 minutes, one
  use), so staff never need the password. Attempts are rate-limited (20 per shop per hour, `PAIR_HOURLY_LIMIT`).
* **Offline.** Signing in, selling and stock keep working offline in both modes. An unpaired device keeps its data, shows a
  pairing screen with **"Keep working offline"**, and syncs once paired. Its offline sales then arrive exactly once.
* **No lock-outs.**
  * Only a paired device (plus the password) can switch a shop to "paired only".
  * A device can't revoke itself.
  * The Owner Console can switch any shop back to open.
* **Settings ▸ 🔐 Devices & security**, in every app: this device's status, "Pair this device", a pairing code for a new device,
  name this device, every device of the shop with till / app release / last sync / revoke, and the on/off switch.
* **Tip:** after switching a shop to "paired only", check the device list for devices you don't recognise and revoke them. If
  the shop link may have leaked before, also change the shop password.

## #11 App-release monitoring
Every push says which release the device runs (`zip-120`, from the device-security block). The server keeps a per-shop
`deviceRegistry` (till, release, last seen), riding on the write that already happens, so there's no extra storage write. It is
shown in each shop's Settings and in the Owner Console. Devices on an older release are flagged ⚠.

## #7 Overselling
The till already refuses to sell beyond recorded stock, online and offline. Since zip 118 that figure is the server's confirmed
one plus this device's own pending sales. **New:** the Stock Take tab flags **items below zero** (two offline tills selling the
last unit) with a "Show only these" filter, so they get counted.

## #9 Stock-take approval
A stock take (bulk or one line) that writes off more than **KES 5,000 of missing stock at cost** needs the **management password
(or a Manager's PIN)** before it's applied. Aqua values tanks at the water cost per litre and materials at unit cost. The limit
is shown on the Stock Take tab and can be changed (itself password-protected; 0 = always ask). The check is on the device, so
it works offline.

## #8 X/Z Reports checked by the server
* New `GET /api/day-summary`: the server's own list of the day's sales (ids, count, gross, by payment method, **by till**).
* The X and Z Reports (and Aqua's) show **"✓ Server check: the server holds the same N sales"** or name exactly what's missing
  where, plus a **per-till table**.
* **Finalizing a Z Report online requires the device and the server to hold exactly the same sales.** Offline, the manager is
  told what it will be based on (as in zip 119).

## #10/#12 Shop health in the Owner Console, daily
* New **🩺 Health** tab. For every paying shop:
  * whether its stock agrees with its history (nothing applied twice, no figure overwritten)
  * items below zero
  * its devices: how many, older releases, silent for 3+ days
  * its pairing mode, with a button to switch it
  * its size, with a "move to its own database" suggestion above ~4 MB
* **Daily email:** the router Worker gets a daily trigger (07:40 Kenya time). Set `HEALTH_URL`
  (`https://mydukapos.store/api/owner-health`) and `ROUTER_SHARED_SECRET` on the **router Worker**, plus the same
  `ROUTER_SHARED_SECRET` on **Pages**, and every morning all shops are checked. You get an email **only when something needs
  attention**. It needs the Resend key already in Owner Console ▸ Settings; your owner login must be an email address. Without
  those settings the trigger does nothing.
* #12 itself (moving big shops to their own database) already existed in 💾 Storage. The Health tab now points to it.

## Tests added
* `tests/device-pairing.test.mjs`:
  * open mode unchanged, with background pairing
  * a stranger is refused read and write
  * an unpaired till keeps selling offline, then pairs with a code and its sale arrives once
  * revoke; a brand-new device pairs with the password; guessing is rate-limited
  * Aqua pairs the same way
* `tests/owner-health.test.mjs`: owner-only access, each problem type detected, the daily job only with the secret, the pairing
  switch.
* Stock-take approval and the below-zero alert, in `tests/stock-take.test.mjs`.
* Server day check plus Z refusal, in `tests/multi-till.test.mjs`.
