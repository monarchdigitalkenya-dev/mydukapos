# Zip 129 — Connectivity: never stuck "Offline" with working internet; sales sync even on a weak line

Scope: connectivity and sync only. Sales, stock, receipts, reports, tax, audit and sign-in are unchanged, and no stored data
is changed.

## 1. Root causes (traced in the code, reproduced in tests)
| # | Cause | Effect |
|---|---|---|
| 1 | **The first push after the app opened carried the device's whole history** (every sale, stock change, return and expense it holds). Nothing was known to be on the server until one push had succeeded. On a weak mobile line that upload took longer than the 40 s limit, was cut, and was retried **in full**, again and again. | "Retrying… sending…" for ever. No new sale reached the server. **Reproduced:** on zip 128 a sale made on a slow line never reaches the server; with zip 129 it arrives in about 3 s. |
| 2 | **A pull only runs after the device's unsent changes have been sent**, which protects local edits. With cause 1 the send never succeeded, so the pull never ran. The pull was the only thing that set the dot back to "Online". | **OFFLINE, permanently, with working internet.** |
| 3 | **The "is there internet?" probe used the heaviest endpoint** (`/api/pos-sync`: licence lookup, device check, shop data) with a 4–6 s limit. | A slow answer, or a busy line during a big upload, was reported as "Offline". |
| 4 | **Answers from the server were shown as "Offline":** 403 (licence), 413 (too large) and other 4xx. | "Offline" for problems that were not about the internet. |
| 5 | **Several places decided "offline" on their own:** `navigator.onLine`, the browser's offline event, each sync function. | Conflicting states. |

**Checked and not a cause:**
* **Service worker:** it never touches `/api/`.
* **CORS:** the apps call their own origin with relative URLs.
* **Addresses:** no localhost, HTTP or old API addresses in any app.
* **Caching:** the router Worker applies none.

## 2. One connectivity manager: `window.PosNet` (new shared block `connectivity`, in all 7 apps and the Owner Console)
* **States:**
  * `online`;
  * `checking`;
  * `offline` (this device has no internet);
  * `backend_unavailable` (internet works, the POS server is not answering; retried);
  * `auth_required` (the server answered 401/403: pairing or licence);
  * `config_error` (the server refused, e.g. the shop is too large).
* **The check:**
  1. `GET /api/health` (new: no licence, no shop data, writes nothing, `Cache-Control: no-store`, also for Cloudflare's CDN).
     An answer means the POS is reachable.
  2. Only if that fails: an independent internet probe (opaque requests to Google and Cloudflare). If it answers, the state is
     `backend_unavailable`; otherwise `offline`.
  * `navigator.onLine` is only a hint.
  * Each probe has its own time limit, and a hung check never blocks the next one.
* **Failures are checked, not believed:** a failed sync request is only a reason to **check**. It never sets "offline" by
  itself. A success reported while a check is running wins over that check.
* **Everything reports to it:** `markSync`, `probeServer` and the sync functions (Aqua and the Owner Console's own copies too)
  report to the manager. 401/403 → `auth_required`, 413 → `config_error`, 5xx/429 → busy (retried). Features that only need
  "is it worth trying the network?" use `posNetOffline()`.
* **Automatic recovery, with no refresh, restart or sign-in.** It is triggered by:
  * the browser's online / offline events;
  * the app coming back on screen, focus, `pageshow` and `resume` (PWA);
  * a network change (Wi-Fi ⇄ mobile data);
  * waking from sleep (a gap in the timers);
  * a tap on the dot;
  * a retry with backoff while not online: 2 s, 4 s, 8 s, 15 s, then every 30 s. A heartbeat runs every 60 s while online.

  The moment it is online again, waiting sales are sent and the shop is fetched.
* **Nothing about connectivity is stored.** Every start begins with a real check.

**The dot** keeps its style (green / orange / black) with a plain-language title:
* "Online — everything is on the server"
* "Online — Syncing…"
* "Online — Sync problem…"
* "Offline — this device has no internet…"
* "Your internet works, but the POS server is not answering right now. Retrying automatically…"
* "Connected — this device must be paired…"

Tapping it re-checks and says which of these applies. Black still shows only if it lasts (no flash on a blip).

## 3. Sales that sync: "check whether the server already has it, then send only the rest"
* **`/api/sync-have` (new).** Before the first push of a session, the device asks which of its records the server already holds,
  and in which version: a business version that client and server compute identically. Those are never uploaded again, whether
  this device or another one pushed them. Nothing is written.
  * Database shops answer through a new read-only `/have` operation in the shop database, so **`npm run deploy:router` is
    needed**. Until it is deployed, the batching below still does the work.
* **Pulls count too:** records the server sent in a pull are marked as on the server as well. The sales journal (zip 127) also
  counts: a sale it saw accepted is not re-sent.
* **Batches:** whatever is really missing goes in batches (150 sales, 400 stock changes …; newest first). The next batch goes
  as soon as the last one is accepted.
  * A batch that times out, or that the server calls too large, is halved (down to 1/16), and it grows back once pushes succeed.
  * While batches remain, the device still counts them as unsent, so Z Reports and the pull safety rule stay correct.
* **Ids:** the same ids as before. The server merges by id, so nothing is ever duplicated.

## 4. Cloudflare
* **`/api/health`:** a Pages Function, no-store, reachable through the wildcard router (which does not cache).
* **Workers Logs** are turned on for the router Worker that every shop's traffic passes through (`[observability]`, 5%
  sampled). "The POS said Offline at 10:14" can then be checked against what reached Cloudflare and what status came back. Raise
  the sampling rate to 1 while investigating.
* **No other Cloudflare products were added**, and no cache rules changed. There is only one origin, so a load balancer would add
  nothing.

## 5. Tests
**`tests/connectivity.test.mjs` (13 tests):**
* the health endpoint (TEST 9);
* sync-have, where client and server agree on versions;
* TESTs 1, 2, 15: online at start, whatever an earlier session thought;
* TESTs 3, 4: offline, then online by itself;
* recovery with **no** browser event;
* TESTs 7, 8, 10, 12: server unreachable → "server unavailable", never "offline", retries, back online;
* TEST 11: 401/403 → sign-in needed, not offline;
* a failed request alone never sets offline;
* TESTs 5, 6, 13, 14: network change, back on screen, wake from sleep, pageshow;
* `navigator.onLine` wrong;
* every app carries the manager;
* **the root-cause reproduction** (it fails on zip 128);
* a 700-sale backlog sent in batches until done.

**Also:**
* **Real Chromium** (network cut and restored with Playwright): online in 17 ms, offline in 0.3 s, back online by itself in
  0.3 s, online again 1.5 s after the server came back, and online at once after a refresh.
* **Updated tests** (requirement changes):
  * `delta-push`: the first push is no longer the whole history;
  * `hotel-fixes`: the dot test has a real network to switch off.
* **Time zone:** `npm test` now runs in the Kenya time zone, like the tills, so a test about "today" means the same day at any
  hour.

## Not verifiable from here
The production Cloudflare deployment and its logs cannot be reached from this environment. After deploying, check:
1. `https://<shop>.mydukapos.store/api/health` answers `{"ok":true…}` with `cache-control: no-store`.
2. The Workers Logs of `mydukapos-wildcard-router` show `/api/health` and `/api/sync-have` with status 200.
