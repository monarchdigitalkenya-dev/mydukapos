# Zip 123 — Syncing with several devices at once: no more "the server refused or was busy"

Builds on zips 118–122.

## The cause
A shop that has not been moved to its own database is kept as **one storage record** in Cloudflare KV, and KV accepts about
**one write per second** to the same record. So when a phone and a computer saved within the same second, the second save was
refused. The server then **crashed** on that refusal instead of handling it. The device showed "Sync: send failed — the server
refused or was busy" and waited up to 15 s before trying again. In the same situation two saves could also overwrite each
other on the server.

This was reproduced in a test with the real 1-write-a-second limit: the zip 122 server crashes with `KV PUT failed: 429`.

## The fix: server
1. **Wait and write again, keeping both.** If the write is refused because another device's save just landed, the server waits
   a moment, **re-reads the shop and merges again**, so the other device's save is kept too. It then writes again, up to 4
   attempts.
2. **Never a crash.** Anything unexpected is answered with **503 "busy, try again in 2 s"** (with `Retry-After`), which every
   app handles by itself.
3. **Multi-device shops move to their own database automatically.** A shop with **2+ devices active in the last day**, or whose
   save just had to wait for another one, is moved to its own database (`shop-store.js`). There, every device's save is taken
   one after another, with no per-second limit and nothing overwritten.
   * The move is verified and the old record is kept, exactly like the Owner Console's "Move to database".
   * It is tried at most once every 6 hours.
   * If it can't be done, the shop stays as it is and step 1 still protects it.
   * A save that was already on its way during the move is brought across too (`_migrate.js` re-checks after a short wait).
   * Paying shops were already moved when their link became permanent. This covers older links and demo links.
4. Shops already in their own database: a failed call to the database is retried once, then answered "busy".

## The fix: every app (Shop, Hotel, Hospital, Pharmacy, Production, Services, Aqua)
* **Retries automatically, fast.** A "busy" answer is sent again **by itself** after a short random pause, up to 3 times in a
  row. The random pause means the two devices don't collide again. After that, it keeps sending again by itself every 2–10 s
  until it goes through. Nobody has to do anything, and nothing is lost: the server applies each sale and stock movement once.
* **Tap the sync dot to sync now.** It sends and fetches immediately (hover text: "tap to sync now").
* **Calmer messages.**
  * A busy server for a few seconds keeps the dot on "syncing" (orange). Only a problem that lasts a minute shows as a problem.
  * The Audit log gets **one** line per episode ("the server was busy — kept on this device, sending again automatically in
    a few seconds") and one when it succeeds ("sent automatically after an earlier failure — nothing lost"), instead of a
    "send failed" line for every attempt.
* The urgent saves (password changes, etc.) get the same automatic retries before reporting a problem.

## Tests added (`tests/sync-busy.test.mjs`)
* Three devices saving in the same second under the real limit: all succeed and all three sales are kept. This test fails on
  zip 122.
* Storage failing outright: a clean 503 "busy" with `Retry-After`, never a crash. This test also fails on zip 122.
* A shop with two devices moves to its own database by itself, nothing is lost, and then four simultaneous saves all succeed.
* The app: a 503 "busy" is sent again by itself within seconds, logged at most once, and nothing is lost.
* A phone and a computer, both running the real app, selling at the same time under the real limit:
  * all 6 sales reach the server;
  * both devices end up with all 6;
  * stock goes 50 → 44, each sale counted once.
