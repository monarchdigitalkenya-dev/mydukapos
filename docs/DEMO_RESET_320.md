# Hourly reset of the sample shops (zip 320)

## 1. What was found in the code before anything was changed

| Question | Answer from the code |
|---|---|
| How are the demos created? | `functions/api/_shared-demos.js`: one fixed shop record per product (`id demo_<key>`, address `demo-<key>`), created by `ensureSharedDemoRecord` with `sharedDemo: true`. Sample data comes from the pure generators in `_demo-seeds.js` and is stored with `seedInitialState`, the same path a real shop's setup uses. Re-seeded when `SEED_VERSION` changes or after 14 days. |
| How do demo links differ? | `clientLink()` gives `https://demo-<key>.mydukapos.store/<app>/?c=demo_<key>`. Each demo has its own sub-domain, so its own browser origin. |
| How is a demo identified? | Server: `record.sharedDemo === true`. Client: the `shared-demo` block runs only on a `demo-` host (or `?c=demo_`) and engages only after `/api/license-status` returns `sharedDemo: true`. Before zip 320, an offline visit "behaved as a normal app". |
| Shared storage? | The apps keep one shop per browser origin (keys like `pos_inventory`, not namespaced per shop). On a demo sub-domain that origin holds only that demo. On a shared address (e.g. `x.pages.dev/?c=…`) the same keys can hold a real shop. Server: demos are read-only. `requireValidLicense` refuses writes (`demo_readonly`), and `/api/pos-sync` acknowledges a demo push without storing anything (`stored: false`). |
| Offline mode | Service worker per app; everything lives in localStorage (compressed by the storage block), plus IndexedDB `pos_sales_journal` (sales safety copy), `pos_local_archive` (old days) and `svc_photos`. Unsent work is tracked by keys in localStorage (`pos_dirty_seq` / `pos_acked_seq` and the push state). |
| Baseline | Authoritative: the server's seed (`buildDemoSeed`, deterministic). Before zip 320 there was no copy on the device; the manual Reset cleared everything and pulled again (online only). |
| A gap found | The older name-based address path (`pickUniqueSlug`) could give a real shop named "Demo …" a `demo-…` address. So the address alone is not proof. Closed in two ways: the reset also needs the server's confirmation, and that path no longer produces `demo-` addresses. |

## 2. How a sample shop is identified (enforced in the reset path itself)

Both must be true, checked on every reset attempt (`confirmed()` in `src/shared/blocks/demo-reset.html`):

1. The page's host starts with `demo-` (the block exits at once otherwise; it defines nothing on a normal shop).
2. `sd_confirmed` on this device names this exact host and exactly the matching demo id: address `demo-<key>` ↔ shop id `demo_<key>`. It is written only when `/api/license-status` answers `sharedDemo: true` with that id, and removed when it answers anything else.
   - Real shop ids are random tokens with no `_` (`randomToken`, or `[a-z0-9]` fixed ids from Get my own link), so they can never match.
   - `sharedDemo: true` is set in one place only: `ensureSharedDemoRecord`.
   - No endpoint copies request fields onto a shop record.

Not used as evidence: sample products, shop names, being offline, or a `?c=` parameter.

## 3. Deadline (stored and enforced offline)

- `sd_reset_meta = { host, deadline, startedAt, lastSeen, resets }` sits in localStorage, separate from the shop's records and never part of the baseline or of a restore.
- The first hour starts when the sample first arrives on this device (baseline captured). Each reset starts a new hour.
- It is checked:
  - in `<head>`, before any app script reads data;
  - every 15 s;
  - when the page becomes visible, gets focus, comes back online or is restored from the back/forward cache;
  - on the first tap or key press after the hour, which is swallowed so the old data is never used.
- Reloading does not move the deadline.
- A device clock set back more than 5 minutes behind the last check counts as expired.

## 4. How the original sample is restored

- **Baseline:** `sd_baseline` = every key of this origin right after the first pull, with its host. It is validated before use: right version, this host, contains the catalogue.
- **Restore:**
  1. Remove every key of this origin except the reset's own and two device preferences (theme, a pending "get my link" request).
  2. Write each baseline key back and read it back.
  3. Delete this origin's `pos_sales_journal`, `pos_local_archive` and `svc_photos`. The delete requests are made before anything on the page can reopen them.
  4. Clear session storage.
  5. Write the new deadline last.
- At start-up the restore happens in place before the app loads. On an open page it blocks the screen, restores and reloads.
- **Interrupted:** the deadline is still expired, so the next check restores again from the same baseline (idempotent).
- **No or bad baseline:** online, this device's copy is cleared and the sample is pulled again from the server, and a new baseline is kept after that pull. Offline, the demo is blocked with "Connect to the internet once to restore", and nothing is deleted.

## 5. Sync and stale offline data

- Once engaged, the demo sends nothing (shared-demo block).
- The server stores nothing for a demo (`demo_readonly`; pos-sync answers `stored: false`). Test `zip262-shared-demos` already proves a pushed "evil" sale is not stored.
- The device's unsent-work keys are replaced by the baseline's, so nothing old is queued after a reset. Test 9 watches the network after a reset and sees none of the old edits sent.

## 6. Files

| File | Change |
|---|---|
| `src/shared/blocks/demo-reset.html` (new) | The reset: eligibility, baseline, deadline, checks, restore, blocking screen. Placed in `<head>` right after the storage block in Shop, Hotel, Pharmacy, Production, Services, Hospital and Water (`tools/lib.mjs` entry). |
| `src/shared/blocks/shared-demo.html` | Saves or removes the server's confirmation; keeps the baseline after the first pull; the banner's Reset uses the same restore; on a shared address (`?c=demo_`) Reset no longer clears all storage. |
| `functions/api/_license.js` | `pickUniqueSlug` never produces a `demo-` address for a real shop. |
| `tests/zip320-demo-reset.test.mjs` (new) | 11 tests (below). |

## 7. Tests (real Shop app in jsdom; the server's licence answer simulated; isolated data)

| Required check | Where |
|---|---|
| 1, 2, 3 exact sample back (products, prices, stock, sales, expenses, debts, payments, customers, supplier debts, settings) | test "1-3, 6, 15" |
| 4 offline longer than 60 min resets on reopening | same test (reopened offline after the hour) |
| 5 an open demo resets by itself (15-s check, first tap) | test "5, 7" |
| 6 a reload does not restart the hour | test "1-3, 6, 15" |
| 7 repeated resets: no duplicates | test "5, 7" |
| 8 interrupted reset recovers; bad baseline is safe (offline blocked, nothing deleted; online re-pull) | test "8" |
| 9 stale edits never sent after reconnecting | test "9" |
| 10, 11, 12 normal shops: unsynced sales, stock, debts and settings unchanged; reopening and tapping never reset (normal address, a real `demo-shop` address the server does not confirm, a `?c=demo_` link on a shared address) | three "10-12" tests with a before/after snapshot |
| 13, 14 two demos independent; another demo's baseline is rejected | test "13, 14" |
| 15 works with no connection | tests 1-3 and 8 run with the network off |
| The block sits in every app's head before any app script | structure test |

Results: `zip320-demo-reset` 11/11 pass. The existing demo tests (`zip262-shared-demo-client`, `zip262-shared-demos`, `zip281-demo-heal-and-bar-sale`, `zip305-demo-film`) all pass with it: 32/32 together, before the structure test was added.

## 7b. Re-check: normal shops in every app (`tests/zip320-normal-shops-untouched.test.mjs`)

- **Setup:** all 7 apps were opened as a real shop with unsent work, in three situations:
  1. on the shop's own address;
  2. on an address starting with `demo-` that the server says is not a demo;
  3. on a shared address opened with `?c=demo_retail`.

  Each time, the reset's own data was planted on the device: a stale confirmation, an hour long over, and a baseline that would empty the shop if it were used.
- **What was watched:** every call that can delete something (localStorage and sessionStorage `clear` / `removeItem`, IndexedDB `deleteDatabase` / `databases`).
- **What was triggered:** focus, page shown, back online, a tap, a key press, an explicit `check` and `restoreNow`, then a reopen.
- **Result:** 21 of 21 pass. No record changed, nothing was cleared or deleted, the page was never blocked, and the shop was never eligible.
- **Control:** the same watchers on a confirmed sample shop do record the reset (keys removed, `pos_sales_journal` deleted), so the "nothing deleted" result is real.
- **Not affected by the reset:** the server change is only `pickUniqueSlug` for new shops named "Demo …", which now get `shop-demo-…`. The `_store-d1.js` change is zip 318's Move. `license-status`, `pos-sync`, the shop database and the router are unchanged.

## 8. Limits

- A browser page cannot stop someone who clears the site's data, edits the page's code, or keeps moving the device clock forward and back. What protects the shared sample itself is the server: demos are read-only, so nothing a visitor does ever reaches another visitor or the server.
- The reset needs one online visit to capture the baseline (the sample is downloaded on that visit anyway).
- A `?c=demo_…` link opened on a shared address is not reset automatically, because its storage could hold a real shop. Public demo links always use the demo's own address.
