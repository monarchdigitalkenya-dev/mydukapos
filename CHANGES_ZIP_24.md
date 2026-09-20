# Zips 24 - 44 — what changed

## Aqua POS (water): each site has its own bulk tank
* Production and every Shop branch have their own tanks. Refills, sales and bulk orders draw only from their own site.
* Existing water stays with the Shop; Production / new branches start with an EMPTY tank (record a delivery, or set
  "Level now"). Level corrections are logged in the refill history.
* Tanks sync per record (`pos-sync.js`), so a stale device at one site can't overwrite another site's level.

## Server: size guard, compression, abuse limits
* `pos-sync`: refuses a shop > 24 MB (raw) with a clear 413 message (the apps now show it); shops >= 6 MB are stored
  gzipped automatically (lossless); push reply is slim; size + last writers (IP/country) kept in KV metadata.
* Owner Console -> 💾 Storage: every shop's size, alerts (tab badge), Measure / Compress / Uncompress, "Compress all large shops",
  and a list of shops that hit the SMS / M-Pesa hourly caps.
* Per-shop hourly caps: SMS 1500 recipients, M-Pesa prompts 60 (env `SMS_HOURLY_LIMIT`, `STK_HOURLY_LIMIT`).
* CORS on `pos-sync` limited to the shop's own domain family (no more `*`).
* Backups of big shops are gzipped too.

## Apps
* 413 "too large to sync" notice (all 8 apps). Password hashing: the 32-bit fallback is now real SHA-256.

## Tests / docs
* New: water tanks, storage/size/compression/CORS/rate-limit, owner Storage UI, 413 handling, SHA-256, two-device sync,
  and money invariants through the real checkout of 6 apps. Test boot wait cut from a flat 1.2 s to ~0.45 s.
* `STAGING_SETUP.md` (exact steps), updated `SCALE_PLAN.md` / `SYNC_AUTH_DESIGN.md`.

## Zip 25 additions — storage
* **Device storage compression** (all 9 apps, `src/shared/blocks/storage-compress.html`): big localStorage values are stored
  compressed in 60,000-char slices (lz-string). Measured ~8x smaller on real sales data; a sale recompresses only the last slice.
  Failed saves roll back; "storage full" drops the regenerable `:prev` copies and retries; the Settings meter shows REAL usage.
  Existing (uncompressed) data is read as before and compressed on its next save.
* **Delta push:** sales, stock movements, returns, expenses, attendance, admin activity, dispatch and trade credits are sent as
  new/changed records only (the server already merged by id). First push after opening the app still sends everything.
* **Server limits re-measured:** memory, not KV's 25 MiB, is the ceiling (~6-8x raw size per push). Defaults are now 4 MiB "Large",
  12 MiB refused, 8 MiB auto-compress.
* **Archive old history** (Owner Console -> Storage): move records older than N days into a verified gzipped archive; download or
  restore it later. This is what actually shrinks a shop.

## Zip 26
* **Server-verified logins: dropped** (sign-in must work offline). `SYNC_AUTH_DESIGN.md` now records that decision and what was done instead.
* **Less copy-paste:** `tools/promote-identical.mjs` moved 49 functions that were identical in every app that had them into
  `src/shared/` (shared functions 673 -> 723). It only moves a function when it is provably safe (same normalised source everywhere,
  declared once, in the same script block as the shared region). Run `node tools/promote-identical.mjs --dry` to see what's left.
* `checkoutCart` is still 8 different copies on purpose: they differ by real features (card payments and promotions exist only in
  Shop, gas refills only in Shop/Services/Production, due dates in Services/Pharmacy...). Unifying it needs hook points and broader
  tests first; the money tests added in zip 24 are the start of that safety net.

## Zip 27 — storage is never the client's problem
* **Automatic server archive:** when a push would leave a shop at 80% of the size limit, the server archives old history in the same
  request (keeps the newest 90 days, or 60/30/14/7 if more is needed, to get under 60%), writes a verified gzipped archive, and keeps an
  index of archived ids so a device that re-sends old records can't bring them back — while a back-dated NEW record is never dropped.
* **Automatic device archive** (all 8 shop apps): at 80% of the device's storage (or the instant a save fails for lack of room) the oldest
  history moves to an IndexedDB archive first, and only then leaves the everyday lists; the failed save is repeated. Nothing is removed if
  IndexedDB isn't available. Settings shows a small "older history was moved…" line with a Download button.
* **No storage messages for staff:** removed the "device is low on storage" toast, the 80% warning, the "optimised photos" toast and the
  "too large to sync" toast; a 413 no longer shows as a sync error. Only an ADMIN is told, and only if nothing at all could be freed.
* Owner Console: "Large" shops need no action (info line only); only a REFUSED shop gets a red badge. Automatic archives are labelled.
* Trade-off (by design): after an archive, tills and phones show only the recent history in reports until an archive is restored (server:
  Owner Console -> Storage -> Archives; device: the archive is kept in the browser and can be downloaded).

## Zip 28 — the long-term fix: a per-shop database (opt-in)
* `wildcard-router/shop-store.js`: SQLite-backed Durable Object per shop. Rows instead of one JSON record -> no size ceiling, nothing archived away.
* Merge rules moved unchanged into `functions/api/_merge.js`; both backends verified equal by side-by-side tests.
* `pos-sync` routes a shop to its database when the owner moves it (Owner Console -> Storage -> 🗄️); `/api/history` serves any date range, paged.
* Migration is verified, reversible, keeps the old record as a rollback, and pauses pushes (503, devices retry) only while it runs.
* Devices merge a recent-window pull with the history they already hold (`preparePulledPayload`, all 8 apps).
* Not built / untested: see `SCALE_PLAN.md` (status after zip 28) and `STAGING_SETUP.md` (database section). Nothing changes for any shop until you move it.

## Zip 29
* **Older history on new devices:** background fetch from `/api/history` (`hydrateOlderHistory`), bounded and once per install; fetched records are marked
  acknowledged so they aren't pushed back. The database now tells devices where the recent window starts (`_hotFrom`).
* **Instant sync for database shops:** the server sends a bare poke over the WebSocket; all 8 apps pull when they get one. Older cached apps ignore it.
* **CORS:** `functions/api/_middleware.js` removes `Access-Control-Allow-Origin: *` from every API response for other websites (own domains, subdomains and localhost still work).
* **Staff login links:** an "Open" button next to Copy/Link in every app.
* **Aqua POS stock requests:** confirmed working end to end (request -> Production bell with who asked -> dismiss) and now merged per record on the server so two tills' requests both survive.

## Zip 30
* **🧪 Test the database** (Owner Console -> Storage): runs the per-shop database through a whole shop's life on a throw-away copy on the REAL Cloudflare runtime and
  reports every step. It is the quickest way to find out whether anything my Node stand-in imitated behaves differently there.
* **Stock-revert fix:** a device that re-sends an earlier inventory record (a retry after a lost reply) can no longer put an old stock count back; a real stock
  edit is unaffected. Fixed once in the shared merge, so it holds for both storage backends; proven by tests that fail without the fix.
* Deliberately NOT done: delta pull in the apps. The database path has not yet been proven on real Cloudflare; adding more untested client logic on top of it first
  would make any staging failure harder to pin down. Do it after the self-test is green and one staging shop has run for a few days.

## Zip 31 — "I changed it, refreshed, and it was back"
Reproduced end to end (`tests/e2e-revert.test.mjs`: a real app + the real server code) and fixed two causes that existed before the zips above:
1. **Old copy overwrites a setting.** ~40 settings (receipt text, VAT rates, tab locks, loyalty tiers, hotel tables/rooms, ...) were one whole value each and the LAST PUSH
   WON, so a till that hadn't refreshed put back what another till had just changed. Now each till stamps the settings it actually changed (`_fieldTimes`); the server
   replaces a stamped setting only with an equal-or-newer stamp. Same rule in both storage backends (`functions/api/_merge.js`, `wildcard-router/shop-store.js`).
2. **A pull landing on an unsent edit.** For ~1 s after an edit (300 ms wait + send), a poll or live push could apply the server's older copy over it, losing it for good.
   Now a device sends its unsent changes FIRST and only then applies anything from the server; if it can't send them it keeps them and skips that pull. Failed pushes
   are retried by the poll with a growing pause (4 s .. 1 min), so a refused shop doesn't re-send itself every few seconds.
Also checked: plain edits (price, stock) survive a refresh online, offline, refreshed-at-once and with pushes refused.
Deploy note: old cached apps don't stamp settings, so a setting changed from an OLD app can lose to a stamped value until that app updates (they update on their own within a day or so).
If clients on zip 24+ with big shops report reverts, ALSO check the Owner Console Storage tab for "refused" shops — a refused push looks like a revert.

## Zip 33 — deployment config
* `wrangler.toml`: live KV namespace id filled in; every environment variable/secret the server reads is listed in comments (none are stored in the file).
* `wrangler.staging.toml`, `wildcard-router/wrangler.staging.toml`, `npm run deploy:staging|deploy:router|deploy:router:staging`: a staging deploy is made from a temporary copy
  with its own KV namespace and its own Durable Objects, and refuses to run if it would use the live KV id.
* **Internal files are no longer public.** `wrangler pages deploy .` uploads the whole folder, so the live site could serve `tests/`, `src/`, `tools/`, `*.md` (including the design notes),
  `package.json` and `wrangler.toml`. The top-level middleware now answers 404 for them; every app, icon, manifest, service worker and the public site is unaffected (`tests/internal-paths.test.mjs`).
* Checked with Cloudflare's own bundler: the router Worker (with the ShopStore class) and all Pages Functions compile.

## Zip 36 — Owner Console storage tools
* **🖼️ Shrink photos** (per shop): the usual reason a shop is huge is product photos stored inside items (a phone photo can be 500 KB+). The Owner Console lists a shop's big photos,
  shrinks them in the browser (max 400 px, JPEG) and sends only smaller ones back, in small batches; every device accepts them (new stamp) and a stale device can't put the big ones back.
  Works for single-record and database shops.
* **🗄️ Move all to database**: moves every single-record shop one after another (each verified, each with a rollback copy); skips shops over 10 MB (shrink photos first) and reports failures without stopping.
* Data left behind by deleted links is no longer listed in the Storage tab.

## Zip 37
* Shrink photos is memory-light for very large shops (24 MB+): decoded copies are released early, the write uses KV's own write-time stamp to detect a device push that landed meanwhile (no second
  24 MB download), and the result is written plain when it fits (no extra gzip copies). Tested, including the "push lands meanwhile -> refuse, never overwrite" case.

## Zip 38
* Storage tab lists PERMANENT links only: demo links, deleted links (leftover data) and the owner's own account never appear in the list, the alerts, the totals, the rate-limit list or "Move all to database".

## Zip 39
* **Pharmacy now has the same sign-up as the Shop** (it was the only module still on the old one): full name, business, phone, email and ONE password with Log In / Sign Up on first open, claimed-link
  auto-login, and one Change Password (sets the till AND management password to the new one). Existing users are untouched: their two stored passwords keep working until they use Change Password.
  All 8 modules are now checked by a test to have identical sign-up fields and the unified Change Password.
* **Permanent = database.** A NEW permanent link starts in its own database; a demo link that is confirmed as permanent is moved into the database with all its data (verified, rollback copy kept; if the move
  fails the link is still made permanent and stays a single record). Demo links stay single records.
* **Every link is measured automatically** in the Storage tab (idle shops with no size yet are measured in the background, one at a time; active shops record their size on every save).
* **"Who's logging in?"** list is no longer torn down and rebuilt when the background sync lands and nothing changed.

## Zip 40  (DEPLOY THE ROUTER FIRST: `npm run deploy:router`, then `npm run deploy`)
* **Deleted things stay deleted.** A bill settled and removed from the list, a debt, supplier, inventory item, delivery zone, recurring expense or offer that is deleted on one device
  is now sent to the server as an explicit deletion marker (tombstone). A stale device can't bring it back, other tills drop it, a brand-new device never sees it, and it survives a refresh.
  Safety net: a list that suddenly loses most of its records is treated as a reset, never as mass deletions. Existing shop databases are upgraded in place (`del` column).
* **A push can no longer hide another device's change.** After pushing, a device used to mark itself "up to date" even when the server had merged in a change from another device it had
  not seen; that change stayed hidden until someone else pushed. The server now reports what it held before the push and the device pulls when it missed something.
* **Owner Console gets both fixes** (it has its own older sync code): a settled/removed bill stays gone; a push can't hide another device's change.
* **Owner income model.** Making a link permanent adds nothing to sales or bills (no amount prompt, no placeholder bill). Under each PERMANENT link (open the link's detail) a 💰 toggle opens
  "Money agreed / Money paid": the paid amount is logged as income; any balance becomes a bill with agreed/paid/balance details, settle in full or in part, and a 🔔 Remind admin button.
  Recorded once per link (the toggle then shows On and locked).
* **Payment reminders** reach the admin of that link as a banner in the POS (all 8 apps; admin only; stays until OK), delivered with the license check (~30 s) and acknowledged back to the owner ("seen").
* **🖼️ Shrink all photos** button in the Storage tab: every permanent link, one after another.

## Zip 41  (Hotel/Restaurant/Bar only — deploy the SITE, no router change)
* **Dishes always sell.** Ingredient stock / missing recipes never block a dish or mark it out of stock. Ingredient stock may go below zero (shown as "short by X"); a void puts back exactly what was taken.
* **Inventory "Used" column** (next to Qty Remaining): what dish sales have consumed of each ingredient, from the recipe as it was at the time of the sale. Sales add, voids subtract, never shown below 0.
* **🍳 Kitchen tab** (right after Sales Counter, assignable to staff): Shelf Life (days, default 1), Servings Prepared (optional batches: log / correct / close out), Servings Sold (automatic, always tracked;
  today's sales when nothing is prepared), Servings Left (= Prepared - Sold, "Untracked" when nothing prepared). Multi-day batches stay active until they expire or are all sold; a finished pool is closed
  when new portions are logged. Voids (sale, un-void, whole tab) re-credit Sold, Left, Used and ingredient stock.
* Stored as small 'kitchen' entries (delta 0) in stockMovementLog: no schema change, syncs between tills like any log, ignored by stock reports and server stock reconciliation.
* Not backfilled: Used and Sold count from deployment onward.

## Zip 42  (Hospital app: variable dosing + dosage instructions + sectioned receipt. Deploy the SITE only.)
* **Variable dosing** on a box/pack item that is also sold by the piece (Add item form and the item's edit window): `Allow selling loose pieces`, base unit name, minimum pieces per sale, allowed dose packs
  ("4, 6, 12, 24" or labelled "Child Dose=4, Full Pack=24"). A quantity is valid when it is at least the minimum and is made of allowed packs (8 = 4+4, 10 = 4+6). The first loose add is the minimum
  dose, +/- step through allowed quantities, typing an invalid quantity is refused with the allowed packs listed, quick-select dose buttons sit under the item, and checkout re-checks every piece line.
  "Whole boxes only" removes loose sale entirely. Stock is still counted in base units (6 from a 24-tablet box opens one box and leaves 18 loose).
* **Dosage instruction** (optional, e.g. "1 x 3 for 5 days") under every stocked item in the cart with quick chips; stored on the sale line and printed as `--> Dose: ...` on the on-screen, printed and
  USB/Bluetooth receipts (shared receipt builder; only appears when a line has one).
* **Sectioned receipt**: when a sale has both hospital fees and dispensed items they are listed under "SERVICES & HOSPITAL FEES:" and "DISPENSED MEDICATIONS:" (Hospital only; other apps unchanged).
* Not in this zip: patient bill aggregation / unified counter payment, lab-test pricing, pharmacy-app parity, dispensing labels, a Department column for services.

## Zip 43  (Hospital: visit references + the cashier's patient bill. DEPLOY THE ROUTER FIRST (`npm run deploy:router`), then the site.)
* **Tests made deterministic.** The deletion / missed-change / kitchen two-till tests waited fixed times for timers; on a busy machine (the whole suite runs in parallel) they could fail although the app
  was right, which stopped `npm run deploy`. They now await pushes/pulls directly and poll for the few asynchronous things.
* **Every hospital visit gets a reference** (V260921-4F2K), shown on the visit form and after saving. A patient-billed visit files what it costs as UNPAID charges under that reference — consultation fee,
  procedures / nursing / other fees (picked from the Services list, new rows on the visit form), lab tests (priced from the Services list by name) and the medicines prescribed (with dose-pack quantity and
  dosage). Nothing is charged and no stock moves at the visit. "💵 Take payment now" on the visit form keeps the old immediate sale.
* **Sales Counter -> 🏥 Patient bill**: type the reference, patient number or name (or tap the waiting list) and the whole bill loads into the cart (dosage, dose packs, fees). One payment (cash, M-Pesa,
  card, split) pays it all; stock comes out with that sale; every line is marked paid; a paid lab test shows "💳 Paid — ready for sample". Refused if the cart is busy or stock is short. Put on Pay Later
  the lines are marked billed (not loadable twice). Voiding the sale reopens the bill; restoring it closes it. Receipts carry "Patient Ref:".
* Tests requested from the Laboratory tab get their own reference and go to the cashier.
* Services list has a Department column (Consultation, Laboratory, Radiology, Procedures, Nursing / Ward, Dental, Pharmacy, Other).
* New synced collection `patientCharges` (one small record per line; merged per record on both storage backends).
* Not built: dispensing labels, insurance split at the counter (institution visits keep their account flow), Pharmacy-app parity.

## Zip 44
* **Pharmacy Sales Counter now has the dosage box too** (Hospital had it since zip 42): an optional dosage under each stocked item in the cart with quick chips (1 x 3, 1 x 2, 2 x 3, 1 x 1), saved on the
  sale line and printed as `--> Dose: ...` on the on-screen, printed and USB/Bluetooth receipts. Tested end to end in both apps. (Dose-pack rules and the cashier patient bill remain Hospital-only.)
