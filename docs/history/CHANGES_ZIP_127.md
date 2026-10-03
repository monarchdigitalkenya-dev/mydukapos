# Zip 127 — Completed sales can no longer disappear; sync you can see; honest Audit; Owner Console sign-in fixed

Builds on zips 118–126. Nothing was rebuilt. No stored data is changed or deleted by this release. Every change works
online **and** offline.

## 1. How a printed sale could go missing — what the code showed
I followed a sale through the code: cart → checkout → saved on the device → sent to the server → Daily Sales / reports / receipt
/ audit. The checkout itself is sound: the sale is written to the device **before** the receipt is shown, and **no** sync path
drops a sale that exists only on the device (the pull keeps local-only records; the server merges sales by id). The losses came
from what happens **around** it:

| # | Root cause | Effect | Proof |
|---|---|---|---|
| 1 | **Device storage full.** The sales list is saved in the browser's localStorage (about 5 MB). When it was full (item photos, long history), saving the new sale **failed silently**. The sale lived only in memory, the receipt printed, and when the app was closed (offline, or before the sale reached the server), the sale was gone. | printed, then vanished after a restart | test *ROOT CAUSE: storage full* — before this release **0 sales** after the restart |
| 2 | **A crash in the middle of saving** a large sales list could leave it unreadable at the next start. The app then started with an empty list. | several sales missing at once | test *the list lost on the device* |
| 3 | **"Today" worked out from the UTC date.** The dashboard's *today's sales and revenue*, the day report, the eTIMS log and the eTIMS retry compared the sale's **UTC** date with the local date. A sale made **between midnight and 3 a.m. Kenya time** counted under the day before. | "some of today's sales are there, a few aren't" | test *TEST 9* |
| 4 | **Device time zone set wrong** (a PC left on UTC). Daily Sales used the device's own calendar, so that till filed early-morning sales under the previous day, and showed other tills' sales on the wrong day. | the same sale on different days on different tills | test *TEST 9* |
| 5 | **Device clock wrong** (a flat battery resets the date). The sale was dated by the wrong clock, so it was not under "today" at all. | a sale "missing" from today | test *a device whose clock is wrong* |
| 6 | **The automatic storage archive** could move an old sale that had **not reached the server yet** off the device, and it was then never sent. | an old unsent sale never synced | guard in `storage-and-photos` |
| — | Already fixed: the app open in two tabs (zip 125), Daily Sales stuck on an old date or filter (zip 124), the busy server (zip 123). Pay-Later bills live in 🧾 Bills until paid (by design; Daily Sales says so). | | |

## 2. The fix: every completed sale is durable before its receipt prints
**New shared block `sales-journal` (all 7 apps).**
* **Two copies.** Every completed sale is saved to the sales list as before. At the same moment it is also saved to this device's
  **journal**: IndexedDB, a separate and much larger store, written with "strict" durability. Stock changes, returns and expenses
  are journaled too.
* **What each journal entry records:**
  * the sale's unique id, receipt number, sale time, **business date**, cashier, device, items, prices, discounts, payment
    method and total;
  * its sync status, when it was created, the last send attempt and when it reached the server.
* **The receipt waits for a saved sale.** It prints only once the sale is saved (on the device, in the journal, or on the server).
  This takes milliseconds. Only a device with no room anywhere asks before printing ("print anyway?").
* **The receipt screen says it plainly:** "✓ Sale saved (ref) — it is in Daily Sales, and is sent to the server automatically.
  Closing this screen never cancels it."
* **Missing sales come back.** When the app starts, any sale this device completed that is not yet on the server and is missing
  from the list is **put back** and sent. The Audit gets one line: "Sales recovered on this device".
* **Deliberate removals stay removed:** reset, demo purge, delete voided sales and the legacy Pay-Later move tell the journal.
* **Tidying.** An entry becomes "on the server" only when the server has accepted **that version** of it (a push answered OK,
  or the server's copy seen in a pull). It is tidied 45 days later.
* **Ids and duplicates.** The same ids are used as before, so retries never duplicate (the server merges by id).

**States of a sale:** *completed* (in Daily Sales at once, offline too) → *⏳ not sent yet* → *🔄 sending* / *⚠ retrying* → *✓ synced*.
A network failure only changes the sync state, never whether the sale exists.

## 3. Daily Sales shows every sale, and where it is
* **A badge on every sale:** ✓ synced, ⏳ not sent yet, 🔄 sending, ⚠ retrying. Unsynced sales are listed like any other.
* **A summary line**, e.g. "2 sales listed here are saved on this device and not on the server yet — sent automatically", with
  **↻ Send now**.
* **🔎 Check for missing sales** compares:
  * this device's list;
  * its journal;
  * the printed receipts;
  * the automatic archive;
  * the **server**, for the chosen day.

  One tap fixes what it finds: **Put them back**, **Show archived here**, **Fetch from the server** or **Send now**. It also lists
  sales made while the clock was wrong, with their correct date.
* **One business date everywhere:** Kenya / East Africa time (EAT, UTC+3), whatever the device's time zone.
  * It applies to Daily Sales, the dashboard, Reports, X/Z, the eTIMS log and the day report.
  * On a device already set to Kenya time nothing changes.
  * A device can opt out with `pos_business_tz = 'device'`.
* **Wrong device clock:** it is detected from the server's time on every sync. New sales are dated by the correct time, and a
  banner asks to set the device clock.

## 4. Receipt: "Cancel / Save"
The receipt's **Cancel** button now reads **Cancel / Save** (all 7 apps). It closes the screen. The sale was already saved
before the receipt appeared. Closing never cancels or deletes it: it stays in Daily Sales and Sales History with its receipt.
To reverse a sale, **void** it in Daily Sales (audited, as before).

## 5. Audit: business events only
* **Removed from the Audit:** "Sync: send failed", "server busy", "retry" and "sent" lines. They are technical and stay in
  **Settings ▸ 🔐 Devices & Security ▸ Sync diagnostics**. The data stays queued and is retried automatically, as before.
* **Added:** one **"Synced to the server"** line per batch of **new** records that reached the server, e.g. "3 sales, 2 stock
  changes — R-00041, R-00042 …".
  * A retry never adds a second line: each record is announced once, when it first reaches the server.
  * "Sales recovered on this device" and "Synced to this device" are also shown.
  * Stock conflicts resolved by the server still show.

## 6. Sync until it works
Unchanged from zip 123 and verified again: a failed send is retried by itself, with backoff (busy: 2–10 s; offline or refused:
4–15 s), until it goes through. Unsynced data is kept across restarts, and the journal now adds a second copy. Nothing is ever
removed from the queue because a request failed. A successful sync never deletes the sale.

## 7. ⬇️ Sync to this device (Settings ▸ 🔐 Devices & Security)
A new button, with step-by-step progress:
1. **Is this device allowed to sync?** A "paired devices only" shop asks an unpaired device to **pair first** (password or
   pairing code); security is not weakened.
2. **Sends this device's unsent sales first**, so nothing on it can be overwritten.
3. **Fetches the whole shop** from the server. The merge is by id: nothing is duplicated, and newer local changes are kept.
4. **Fetches older history.**
5. **Checks today's sales against the server** and reports the result, e.g. "3 sales received. Today matches the server".

If it fails, it says why and tries again by itself (up to 5 times). A "Synced to this device" line goes to the Audit.

Also fixed in pairing: a device that had **just** paired could be refused for a moment while the shop's device list spread across
Cloudflare. It then **threw away its new token** and asked to pair again. The server now re-reads the list before refusing, and a
device keeps a token issued in the last 3 minutes.

## 8. Owner Console: no more false "Sign in as the owner"
**Causes found:**
1. **Session not yet visible.** An owner session existed only as a KV record, and KV takes up to a minute to reach every
   Cloudflare location (and caches "not found"). Right after signing in, requests landing elsewhere were refused.
2. **Network hiccup at start-up.** A moment without a connection when the console opened **deleted the saved session**.
3. **Staff links.** Opening a **staff link** on the owner's device **deleted the owner's session**. From then on the console opened
   quietly in staff mode, and every owner tab said "Sign in as the owner to see this".

**Fixes (one mechanism for every owner-only endpoint: `requireOwnerAuth`):**
* **Signed sessions.** Tokens are signed (HMAC-SHA256, keyed from the owner account's own secret data), so every location
  verifies them at once.
  * Signing out revokes the session.
  * A password change ends older sessions.
  * Sessions from before this release keep working.
* **Offline is not "signed out".** A missing answer never deletes the session: the console opens as the owner and checks again
  later. Only three clear "not valid" answers from the server end it, and then the **sign-in form** opens with "Your owner
  session has ended".
* **Every owner request is double-checked.** An "Unauthorized" answer (errors, health, storage, links, leads, website…) is
  checked first. If the session is valid, the request is sent again.
* **Staff pages** never send the owner's token and say "Owner only". They no longer delete the owner's session.
* **Checked across the apps:** the shop apps sign in with offline password/PIN hashes (no server session), so they cannot show
  this error.

## Storage and migrations
* **No schema change and no data rewritten.** The journal is a new, separate IndexedDB database (`pos_sales_journal`). Existing
  sales, ids and receipt numbers are untouched.
* **First run:** each device journals the last 3 days of the sales it holds (as "not confirmed"). These are confirmed by the
  first successful sync.
* **Where things live:**
  * **Completed sales:** on the device (sales list + journal) until the server confirms them; the server is then the shared copy.
  * **Stock, payments, receipts:** as before. Payments and receipts are part of the sale record.
  * **Sync queue:** the device's unsent changes plus the journal.
  * **Audit:** built from the records themselves, plus the new sync-success list.

## Tests added
**`tests/sales-journal.test.mjs`** (13 tests):
* the root-cause reproduction (storage full → sale survives the restart);
* TEST 1 online sale → print → Daily Sales, synced exactly once, one audit line;
* TESTS 2–4 offline sale → listed at once → restart → still there → online → synced exactly once;
* TESTS 5, 6, 12, 13 server failing: kept, retried, no audit noise, repeated sends never duplicate, one sync line;
* TESTS 7, 8 rapid sales, each printed → all in Daily Sales, reports and after a restart;
* TEST 9 Kenya business date across midnight;
* wrong device clock;
* deliberate removals stay removed;
* an unreadable list is recovered;
* "Cancel / Save" never cancels;
* all apps carry the journal;
* TEST 14 "Sync to this device": two devices, no duplicates, nothing lost; paired-only respected.

**`tests/owner-session.test.mjs`** (5 tests):
* TEST 10 (server and console);
* TEST 11 (non-owner stays refused; a staff page says "owner only");
* no connection at start-up keeps the owner signed in;
* a really-ended session shows the sign-in form.

**One existing test changed:** `multi-till` checked that the Audit **shows** send failures and retries (zip 119). Per this
brief it now checks the opposite: the Audit shows the successful sync and the stock conflict, the failures stay in the
technical sync journal.

**Also checked in a real Chromium browser:**
* the device filled up, a sale made, the page reloaded: the sale is back, and the Audit says "Sales recovered on this device";
* the receipt's "Sale saved" line, the Daily Sales badges and summary, and Settings ▸ Devices & Security, at phone width.

**Full suite: 1125 of 1125 pass.**
