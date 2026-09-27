# Zip 131 — Final check: no sale is ever hidden

Every way a sale can leave the sales list was traced, in all 7 apps and on the server:
* saves, pulls and the live socket;
* the device archive;
* the server merge and archive;
* resets, purges and deleting voided sales;
* the Daily Sales filters and ids.

Four gaps were found and closed. No stored data is changed.

## 1. A pull could wipe unsent sales (shop, Hotel, Hospital, Pharmacy, Production, Services)
A shop that runs on its own database lists only the records it holds. Until its first sale reaches the server, its answer has
**no sales list at all**. Each app applied a missing list as "no sales" (`salesLog = []`), which removed sales this device had
not sent yet. For example: a sale made while a pull was on its way, or a till offline since before the shop's first sale.

**Fix:** a missing list is now treated as "not sent", never as "empty". This device's own records are kept, and they are sent
as usual. The same protection covers stock changes, returns and expenses. Aqua was already safe.

## 2. The sales journal now puts a lost sale back at once
Previously, a sale missing from the list was only restored at the next start-up. Now, if a save ever leaves out a sale the
server has not got yet, the journal puts it back straight away.
* It only does this when the sale was **not** removed on purpose. Reset, demo purge and deleting voided sales still work.
* Moving a sale to the device archive is not affected either.

## 3. The device archive keeps old sales the server has not confirmed
When a device fills up, it moves its oldest history into its own archive. It already kept back unsent sales. It now also keeps
back older sales the server has never **confirmed** it holds, because those are what gets sent.
* The first sync confirms them (the zip 129 "does the server already have it?" check, or the upload itself).
* After that they can be archived as before.

## 4. Stronger sale ids
The server combines sales by id. Ids were the time in milliseconds plus 6 random characters: about a 1 in 2 billion chance that
two tills making a sale in the same millisecond would share an id, and one sale would replace the other. Ids now carry 10 random
characters, using the browser's cryptographic random source where available. The format and all existing ids are unchanged.

## Checked and found safe
* **Server merge:** combines by id and never drops a sale. A sale older than the server's archive cutoff is dropped only when
  that exact sale is already in the archive, and `/api/history` reads it from there.
* **Deliberate removals** (reset, demo purge, delete voided, unpaid sales moved to Bills) each record the removal, so only those
  stay removed.
* **Daily Sales:**
  * it filters only by date range, the payment method chosen and the search box;
  * broken dates and item lists were handled in zip 128;
  * older history is included (zips 128 and 130).
* **Branch view:** another branch's sales are shown only when that branch is selected (by design).

## Tests
`tests/no-hidden-sale.test.mjs` (9 tests):
* the database answer without `salesLog`;
* all six apps keep unsent sales through such a pull;
* a lost sale restored mid-session;
* a deliberate delete not undone.

**7 of the 9 fail without this release.**

`tests/auto-archive.test.mjs` now checks that unconfirmed old sales stay until the server confirms them.

## Deploy
Pages only: `npm run deploy`. `npm run deploy:router` is needed only if zip 129 is not live yet.
