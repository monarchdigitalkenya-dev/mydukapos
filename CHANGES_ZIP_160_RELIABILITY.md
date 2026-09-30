# Zip 160: reliability leftovers of zip 159

Tests: `tests/zip160-reliability.test.mjs`. Shared code changed in `src/shared/functions.js` (synced with `npm run sync`).

## A. A device booted from old storage stamped every synced record as fresh
**Was wrong.** The per-record "what did this device change?" snapshot for the master-data lists (customers, suppliers, bills, debts, offers, contracts,
staff shifts, tables/rooms, tabs, categories, ...) was only ever taken after a push or a pull. A device that had been asleep for weeks started with an
EMPTY snapshot, so `stampDirtyExtraSyncedFields` saw every record as "changed" and set `updatedAt = now` on all of them at its first push. The app
pushes once before it pulls, so those stale copies looked newer than the server's: a delete tombstone made by another till was overridden and the
deleted customer/bill came back (reproduced in the test on `index.html` and `production/index.html` before the fix).
**Now.**
- The baseline of those lists is taken once the page has finished loading (`snapshotInventorySync` schedules it; `water/index.html` does the same after
  its own boot snapshot), so a record edited after boot is a real edit (stamped now) and a record merely carried from old storage is not.
- `stampDirtyExtraSyncedFields` / `stampDirtyInventory`: if no baseline exists yet they take it and stamp NOTHING. Records keep their own `updatedAt`, so
  the server's newer copy or tombstone wins; only genuinely edited records get a new stamp.
- `pushNow`: the first push of a session, on a device with nothing unsent and no pull yet, is preceded by one pull (waits for a pull already in flight,
  gives up after 8 s, and a failed or offline pull just lets the push go ahead, unstamped). A device with unsent work (a sale made offline) skips this,
  so selling and pushing offline-first is unchanged. `window.__pullOkOnce` is set by any successful pull.
- Test: two devices against the real server. A deletes a customer; B (old storage, offline at boot) sells offline, edits another customer offline, comes
  back, pushes first. Tombstone survives, B's sale arrives, B's real edit wins, an untouched record keeps its original `updatedAt`.

## B. Unfenced server writers
**Was wrong.** Only `pos-sync` and `kvMergeUpdate` claimed a slot in the D1 write fence. Owner restore / archive / restore-archive / compress / photosSet /
move-back, the password reset (`writeState`) and `seedInitialState` wrote `prev.ver + 1` from their own read. If that read was stale the version was lower
than the fence's, and the next device push waited and answered 503 busy (self-healing within 120 s).
**Now.** New `writeStateFenced` in `functions/api/_state-store.js` (same options as `writeStateText`). It waits for the copy to be at least the fence version,
checks the record still is the one the caller read (version and write time), claims the next slot and writes with the fence version; on any mismatch it writes
NOTHING and returns `null`. Callers re-read and retry (restore, seed, archive, restore-archive, move-back, compress, reset password) or answer the usual 409
"busy" (photosSet). `writeState` uses it and throws `code: 'fence_busy'` (owner-lock retries). No D1, `WRITE_FENCE=0` or a failing fence query fall back to
exactly the old write. Paths converted: `_backups.js restoreBackup`, `pos-sync.js seedInitialState`, `owner-lock.js resetPassword`, `owner-storage.js`
compress/uncompress, photosSet, migrate-back (unmigrate), archive, restoreArchive. `branches.js` and `demo-account.js` reach the state through `seedInitialState`.
Database (Durable Object) shops were never affected and are unchanged.
Tests: fence version equals stored version and the next push is accepted for each path; a save landing between read and write is kept (reset password,
archive); stale read refused; no D1 / `WRITE_FENCE=0` / failing fence behave as before.

## C. Returns
- **Sets.** `restockReturnedItem` now treats a `type:'set'` item with `setComponents` like a produced item: its COMPONENTS go back, scaled by the returned qty,
  using what the sale line really used (`componentsUsed`), falling back to `setComponents`. The set's own qty is not raised. Damaged puts nothing back. A set
  with no components behaves as before. A void after a partial return gives back only the rest (existing `voidRestoreItems`).
- **Tickbox.** Production Returns / Exchange screen: "Put the finished item back on the shelf instead of its materials" (default off, with a one-line
  explanation). Shown only for a produced item (has a recipe, not a variant, not cross-branch) in Good condition; hidden and cleared for other items, for
  Damaged, and by "reset". Ticking sets `selectedReturnItem.reusableFinished = true`, which the plain return, the exchange and the pending exchange all pass on.
  Only the production module has produced items in its returns (water's `productionRecipe` uses another shape and is untouched).

## D. Hotel name sort (note only, hotel/index.html not touched)
The category code in `hotel/index.html` already sorts by `hospCatNameCmp` (a cached `Intl.Collator(undefined, {sensitivity:'base', numeric:true})`, lines
~34714-34720, used at ~34850, 35042, 35270), which is the requested comparison. What still uses plain `localeCompare(b.name)` (not category code, so left
alone): `hotel/index.html` ~21015 (suppliers list) and ~25990 (`srcs.sort` by category then name). Switch those two to
`localeCompare(b, undefined, { sensitivity: 'base', numeric: true })` if you want them consistent.

## E. Refill log cap
`mergeRefillLogs(a, b, cap, info)` (client and server) reports how many oldest entries the 500 cap dropped; the tank gets `refillLogTruncated` (at least that
many; the max of both copies and the merge, never summed, so re-merging does not inflate it). Tanks under the cap get no field. Additive, no shape change.

## Limitations
- The extras baseline is in memory. An edit made in an EARLIER session that never reached the server and was never stamped is indistinguishable from an old
  record after a reload, so it keeps its old `updatedAt` and loses to a newer server copy (the boot flush still sends it; no data invented or lost by stamping).
- The pull-before-first-push gate only runs when the device has no unsent work and delays that first push by one pull (max 8 s).
- `writeStateFenced` needs D1 to protect anything; without it the callers keep their old compare-then-write checks.
- Not exercised on real Cloudflare or devices; all evidence is jsdom + fakes (KV, D1, Durable Object).
