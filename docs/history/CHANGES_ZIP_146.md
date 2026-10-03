# Zip 146: Offline/online, the green dot, and sales across several devices

Zip 146 includes zips 131–145.

## The four guarantees, each proven by an end-to-end test
These tests use the real apps and the real sync server code (`tests/guarantees.test.mjs`). Nothing is called by hand: each device only gets the browser's own "online" event.

| # | Guarantee | Test |
|---|-----------|------|
| 1 | The app works offline and online | Sell online, lose the internet, sell 3 more, close and reopen the app with no internet: all 4 are there and in Daily Sales. Shop and Hotel. |
| 2 | With internet, the dot is **green** | Green when connected. Black when the internet goes. Green again **by itself** when it returns, even on a slow line (server takes 5 s) and even when the phone wrongly says "offline". |
| 3 | Sales never disappear from the sales record | The offline sales survive the reopen, reach the server when the internet returns, and a pull from the server never removes them. No sale is stored twice. |
| 4 | Several devices: every device gets every sale | Three devices sell online, then all three sell offline at the same time, then come back online together. Every device ends with all 9 sales, shown in Daily Sales, with none duplicated. The server holds all 9. |

## Bug found and fixed (guarantee 4)
**Several tills coming back online together lost sales on the server.** Shops on standard storage save by read, add, write. When
three tills reconnected at the same moment, each read the shop, added its own offline sales and wrote it back, so the last write
won. The other tills' sales were gone from the server. Those tills had been told "OK", so they marked the sales as sent, showed a green
dot and never sent them again. The other devices therefore never received them. This was reproduced and failed before the fix: the server
kept 3 of 9 sales.

Fixed twice over. Each fix alone makes the test pass, and both are tested separately:
* **Server: check after writing** (`functions/api/pos-sync.js`). After saving, it reads the shop back. If a record this push carried
  is missing (another till's save landed on top), it merges again and saves again, up to 5 times. Only saves that carry sales, stock
  changes, returns or expenses are checked. They take about 0.2 s longer; every other save is exactly as fast as before.
* **Device: ask the server** (`schedulePushVerify` / `verifyPushedRecords`, all apps including Aqua). About 4 s after a push that
  carried sales, stock changes, returns or expenses, and again about 30 s later, the device asks the server (`/api/sync-have`)
  whether it holds each one. Anything missing goes back to "waiting to send" and is sent again, however it was lost. The sales
  journal marks it pending again (`salesJournalUnconfirm`), so it is never shown as "all sent" while it is missing. A record the
  server keeps refusing is re-sent at most 5 times, so this can never become an endless loop.

Shops already moved to their own database (Durable Object) save one push at a time and were not affected. The device check covers
them too.

## Also fixed
* **The build check now catches a missing shared function.** A shared function that calls another shared function the app does not include
  now fails `npm run check`. Before, such a call inside a `try { }` slipped past the lint and would have silently broken every
  push. This happened during this work and was caught by the tests. The new check found one latent case in the shop, hotel,
  hospital, production, services and pharmacy apps (`stockIntegrityCheck` → `aquaCellKey`), which is now included.
* Tests: two existing tests assumed the server answers the instant the data lands. They now wait for the device's own "done". The
  harness gains `closeWhenIdle`, so a test never closes a page in the middle of its sync.
* Release stamp `zip-146` in all 8 `sw.js` files and the app, so installed apps update on their next open.

## Deploy
`npm run deploy` only. There is no router change, so `deploy:router` is not needed.
