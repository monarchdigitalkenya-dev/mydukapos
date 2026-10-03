# Zip 159 fixes: Aqua tank refill log merge, produced-item returns

## 1. Aqua tank `refillLog` lost entries when two tills refilled at once
**Was wrong.** `tanks` is merged per record, newest `updatedAt` wins. Litres were safe (cell ledger, `currentVolumeLiters`), but `refillLog` is
a plain array on the tank record, so the losing till's appended entry vanished, on the server and in `preparePulledPayload` on the client.

**Now.** The log is the union of both copies by entry id, oldest first, newest 500 kept.
- New shared helpers `refillEntryId` and `mergeRefillLogs` (src/shared/functions.js) and the same two in functions/api/_merge.js ("line for line").
- Entries already carry `id: genSaleId()`. A legacy entry without an id gets the deterministic id `rf-legacy-<hash>-<len>` from timestamp, litersAdded,
  cost, supplier and servedBy, so two devices agree on it and it never duplicates. The id is written onto the entry when merged.
- Server: `mergeRecordsById(..., 'tanks')` keeps the newest record for every other field and replaces its `refillLog` with the union. A deleted tank stays deleted.
- Client: `preparePulledPayload` unions the local tank's log into the pulled tank's log (same pattern as the loyalty-token merge).
- Backward compatible: no data shape change (only added ids), tanks without a log are untouched, old clients keep working.

## 2. Returning a PRODUCED item restocked the finished item instead of its materials
**Finding.** Selling an item with `productionRecipe` (`deductStockForSaleUnit`) takes only the MATERIALS off the shelf and never touches the item's own
qty; a void (`restoreEntriesForVoid`) puts those materials back, and `voidRestoreItems` (zip 158) already scales them for units returned earlier.
A return called `restockReturnedItem`, which raised the finished item's `qty`: stock nothing ever consumed and no sale ever draws on, while the
materials stayed lost. A later void then gave back only the un-returned share, so the returned share was never restored anywhere.

**Decision.** The brief said to restock the finished item only if it has a tracked finished-goods qty. For produced items it does not: sales never
decrement it, so a "tracked qty" would only accumulate returns. So a return follows the void rule.
- Condition "Good" (the existing Returns / Exchange / pending-exchange choice, unchanged): the materials of the returned units go back, scaled by the
  returned qty. Per-unit amounts come from what the original sale actually used (`componentsUsed` on the receipt line, so short-material flooring and
  per-line recipe overrides are honoured); a sale without that record falls back to the item's `productionRecipe`.
  Each restore is a stock movement ("Returned "X" (materials restored)"), so the server ledger explains the shelf.
- Condition "Damaged": nothing goes back, as before.
- Finished item `qty` is not raised. Escape hatch for a future UI checkbox: `sel.reusableFinished === true` restocks the finished unit exactly as before.
- Non-produced items, variants, sets and other modules are unchanged (no `productionRecipe`, no change in behaviour).
- Void after a partial return is now consistent: return gives back its share, void gives back the rest, nothing twice.

## Tests
tests/zip159-fixes.test.mjs (server union in both push orders, legacy ids, cap 500, tombstones, client pull, client/server id parity, produced item
return, Returns-screen path, Damaged, ordinary item, reusableFinished, recipe fallback).

## Limitations
- The cap drops the oldest entries beyond 500 per tank (the 500 newest are kept on every device).
- No new UI for "reusable finished good": the existing Good/Damaged choice drives it and `reusableFinished` is API-only for now.
- Set items (`type: 'set'`) returns still restock the set item itself (not in scope).
