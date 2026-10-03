# Zip 130 — Pending items from earlier requests, covered

Nothing stored is changed or deleted. Zip 130 builds on zip 129 (connectivity).

## 1. Website / demo account sign-in no longer "forgets" you right after signing in
The same cause as the Owner Console problem fixed in zip 127:
* A website (demo) account session existed only as a KV record.
* KV takes up to a minute to reach other Cloudflare locations, so requests right after sign-in could be refused.

The fix:
* Sessions are now **signed** tokens (`d2.…`). Any location can verify them at once.
* The signing key is derived from the account's own password hash. Changing the password ends every session.
  * No global secret.
  * Nothing is moved into Cloudflare environment variables.
* Signing out still revokes a session everywhere (the KV record is still written and checked).
* Sessions from before this release keep working.
* A forged token is refused.

## 2. A past sale recorded now shows "Not sent yet" until the server has it
Previously, a sale with an older date was treated like an old imported record. It showed only "not confirmed", so the owner
could not tell it still had to be sent.
* **Every newly recorded sale** is tracked as *not sent yet*, whatever its date.
* **"Not confirmed"** is still used for a bulk import: more than 50 new records at once, dated 2+ days ago.
* An old record that is only "not confirmed" is never shown as "Retrying". Retrying means the device knows the sale is unsent.

## 3. Profits & Expenses includes older sales kept only in the device history
Daily Sales already read the local history (zip 128); Profits & Expenses did not. A period that reached back past the device's
working window showed lower sales and profit. The Profits tab now adds the history records for the chosen period, without
duplicates.

## 4. One "am I offline?" answer everywhere
Each app still had one or more places deciding "offline" with `navigator.onLine`, which is often wrong:
* the shop, Hotel, Hospital, Pharmacy, Production and Services apps;
* Aqua;
* the Owner Console.

They now ask the connectivity manager from zip 129 (`posNetOffline()`). They fall back to the browser's hint only if the manager
is missing.

## Tests
* `tests/owner-session.test.mjs`: demo sessions recognised where the KV record has not arrived; forged ones refused; old ones
  still work.
* `tests/hidden-sales.test.mjs`: the past-sale badge versus bulk import; Profits counting history sales.
* The full suite runs in the Kenya time zone.

## Deploy
`npm run deploy:router` is needed only if zip 129 is not live yet. Zip 130 itself changes only Pages files.
