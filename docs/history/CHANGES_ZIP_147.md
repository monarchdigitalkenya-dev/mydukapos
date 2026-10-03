# Zip 147 (147b): Root-cause repair (connectivity, missing sales, waiter orders)

Zip 147 includes zips 131–146; zip 146 made several tills' sales all reach the server. Only bugs are fixed here: no new modules, APIs,
tables or storage, the architecture is unchanged, and offline selling is unchanged.

## 1. "Working internet, but the POS says offline / server refused" (Owner Console too; "Guest fails, my profile works")

**Root causes, each reproduced before the fix:**

| # | Cause | Effect | Reproduced |
|---|---|---|---|
| C1 | "No internet" was decided by two **outside** sites (gstatic.com, 1.1.1.1) whenever the POS health check did not answer. Many networks block or intercept those sites (ISP / office / DNS filters). | One slow or blocked health check: **"Offline — no internet"** while the POS site itself was reachable. | Real Chromium, real shop app: health check blocked, site reachable, outside sites blocked → the previous code shows `offline`; now `backend_unavailable` ("your internet works, the POS server is not answering"). `tests/connectivity-real.browser.test.mjs` fails on the old code and passes now. |
| C2 | When a request failed, the message code **started** a connectivity check and read its verdict immediately, before the check had finished. | "Could not reach the server — **check this device's internet connection**" on any hiccup, with working internet (apps and Owner Console). | Code path; fixed in both copies. |
| C3 | Every **permanent** shop (every paying client, and the Owner Console's own shop) is created in "own database" mode (the ShopStore Durable Object in the router Worker) whenever the binding exists. The code never checked that the database actually answers. When the router Worker isn't deployed or is out of date (the standard deploy steps say to *skip* `deploy:router`), **every** sync failed, and pos-sync reported that as **503 "server busy — sending again in a moment"** with an empty detail. | The dot stayed on "Syncing…" or "Sync problem" for good. Sales never reached the server, other tills and the Owner Console never saw them, and nothing said why. Demo shops (not in database mode) worked, which made it look random or profile-dependent. | Local wrangler (real Pages Functions, database Worker unreachable): permanent shop → every `/api/pos-sync` 503 "busy", dot stuck on "Syncing…"; demo shop on the same server → green. |
| C4 | Cloudflare security challenges (Bot Fight Mode / WAF / Security Level: `cf-mitigated: challenge`, HTML 403) were not recognised. The service worker answered a challenged page load with the cached app, so an **installed** app could never pass the challenge. | "Server refused", "link not active" or "offline" for as long as Cloudflare kept challenging that browser. A fresh profile (Guest) has no clearance cookie, while a regular profile often already has one, so Guest and profile behaved differently. | Real Chromium with the real service worker: challenge page → the old code shows the cached app; now the challenge page is shown and can be passed. |

**Why Guest vs a regular profile can differ.** A Guest window starts with no storage, no cookies (including Cloudflare's clearance
cookie), no service worker and no cached copy of the app, so it always runs the newest code on a first-ever session. C3 hit every
freshly signed-in session on a permanent shop. C1 and C2 turn any slow first check into "no internet". C4 hits a browser without
a clearance cookie. **None of the app's code depends on a Chrome account.** This sandbox cannot reach mydukapos.store (its proxy blocks it),
so production's Cloudflare settings could not be inspected directly. The new diagnostics (below) report the real cause from each
device.

**Fixes:**
* `src/shared/blocks/connectivity.html` (every app and the Owner Console):
  * before "offline", the app's own site is asked (`/favicon.ico`, which the service worker never serves). If it answers, the state is "server not answering", never "no internet";
  * a Cloudflare challenge gets its own state ("security check", tap the dot to clear it);
  * **diagnostics**: any state other than online is reported once per cause to the Owner Console's 🐞 Errors tab, with what the health check got (status, content type, cf-ray, time), whether the site and the outside sites answered, and the browser, PWA and release. Reports made offline are queued and sent later.
* `functions/api/pos-sync.js`: an unreachable shop database answers `503 shop_db_unavailable` with the real reason (logged, and noted for the Owner Console) instead of "busy". The till says so in plain words and keeps every sale queued.
* `functions/api/_license.js`: a new permanent shop starts in database mode **only if the database answers**; otherwise it uses standard storage, which works.
* Owner Console **💾 Storage** tab: "⛔ N shops cannot sync — their database is not answering: run `npm run deploy:router`".
* All 8 `sw.js`: a Cloudflare challenge page is shown, not replaced by the cached app. Release stamp `zip-147`.
* `netFailReason` / `ownerFailReason`: never "check your internet" unless the manager has actually found no internet.

## 2. "The sale printed, but it is not in Daily Sales"

**Root causes, reproduced in `tests/sale-durability.test.mjs` (A and B fail on the old code):**

| # | Cause | Effect |
|---|---|---|
| S1 | A tab the "only one tab" guard had stopped could still complete a sale, e.g. an M-Pesa confirmation that arrived after another tab or window of the app was opened (such as a staff link opened from the till). The guard **silently drops** that tab's saves and the journal skips it, yet the receipt printed. | Receipt printed; after reopening, **the sale was gone**. |
| S2 | `salesJournalDurable` answered **"saved on this device" without checking** for a sale the journal had never seen. | The receipt said "✓ Sale saved" for an unsaved sale. |
| S3 | Storage full **and** no IndexedDB journal (blocked, private mode): the receipt printed anyway, with a small warning. | A receipt for a sale stored nowhere. |
| S4 | (zip 146) Several tills saving at the same moment overwrote each other on the server. | Sales missing on *other* tills and in the Owner Console. |

**Fixes (as revised in 147b, at the owner's request):** the receipt **always prints at once**; a queue never waits on storage. A sale
that isn't stored anywhere durable yet is **saved and sent again automatically** in the background: free up room and save the list
again, then the journal (IndexedDB), then the server. Retries run after 2 s, 5 s, 10 s, then every 15 s, and at once when the
connection returns, until the sale is stored. A small bar shows while any sale is unsaved, and closing the app asks first. The sale is
in the sales list (and Daily Sales) from the moment it is made, so it is never hidden. A stopped tab can't complete a sale
(`tabCanSell`), because that tab can't save anything. The durability check now reads storage back instead of assuming.

**Also fixed (found while testing 147b):** "Check for missing sales", "Fetch from the server" and "Repair sync" reset the sync marker to
fetch **everything**. But the push of unsent changes that runs first set the marker again, so the fetch asked only for changes, and a
sale the server had but the device had lost **did not come back**. This was intermittent: it happened only when something was waiting
to send (it failed 1 in 8 runs; 12 of 12 now pass). A requested full fetch now stays full. Daily Sales already reads the one sales list
by business date (Kenya time). Idempotency is unchanged: stable sale ids, merge by id, zip 146's server check, and confirmation through
`/api/sync-have`.

## 3. Waiter orders (hospitality)

**What made it complicated (the causes):**
1. "New order" **sent the waiter to the Sales Counter** to build the order. The Waiter role has no Sales Counter, so a waiter either couldn't take an order at all, or had to be given the cashier's screen.
2. A one-time migration ("give every existing staff member the Sales Counter") **re-ran for every staff member created afterwards**, because new staff were never marked. It also re-added the Sales Counter after the Admin unticked it. Waiters kept getting the Sales Counter. Reproduced in `tests/waiter-orders.test.mjs`: fails on the old code, passes now.
3. "Settle" sent the **customer's bill to the kitchen printer**, and printed nothing when kitchen tickets were off.
4. The waiter's screen carried cashier and supervisor tools (move/split/merge, rush, history, QR inbox, scan box, station settings) and a second "Open Tabs" list.

**Now (the same module, the same order engine, no new tables or APIs):**
* **Orders tab**: table / room, customer, type → tap menu items (quantities, notes) → **📤 POST ORDER**. This goes through the same path as the Sales Counter's "Add This Order to Tab": saved against the waiter and the table / room; the kitchen and bar each get their slip (**no prices**; order number, time, waiter, table, items, quantities, notes, station), routed by the existing station settings.
* **📋 Orders** opens the side panel (**drag its edge to resize**; the width is remembered). It shows **only the waiter's own orders** (all orders only with the existing "see every order" permission), each with **UPDATE ORDER** (add / remove / exchange / note: only the change prints; history kept; no duplicate lines or charges; 🖨️ reprint the order) and **SETTLE**.
* **SETTLE** prints the **customer's bill** on the receipt printer: prices, total, "NOT PAID — please pay the cashier", and the shop's **own payment details** from Settings ▸ Receipt (Paybill / Till / Send Money — nothing hard-coded). **No payment is recorded**; the cashier takes it as before (🧾 Bills / Take payment), producing exactly one sale. The cash drawer never opens for an unpaid bill.
* Waiters no longer see the cashier and supervisor tools; cashiers, supervisors and the Admin keep every one. The Waiter role preset is the Orders tab only.

## Tests
* New: `tests/connectivity-real.browser.test.mjs` (real Chromium: fresh/Guest and installed profiles, blocked health check, Cloudflare challenge, really offline, back online); `tests/sale-durability.test.mjs` (A–D); `tests/waiter-orders.test.mjs` (roles, the full waiter → cashier workflow, cashier unchanged).
* Real Pages Functions (local wrangler) + real Chromium: Owner Console in a normal profile (sign-up), a **Guest** profile, **another** profile and **Android Chrome** (Pixel 7 emulation), all with the outside test sites blocked. Every one: signed in, **Online**, green, synced, links created, no API errors. With the previous code the same run showed "Sync problem" (every sync 503).
* Full suite: see the report.

## Deploy
Run **`npm run deploy:router` this time**: permanent shops keep their data in the router Worker's database, and the Owner Console's Storage tab now lists any shop whose database isn't answering. Then `npm run deploy`. Installed apps update on their next open.
