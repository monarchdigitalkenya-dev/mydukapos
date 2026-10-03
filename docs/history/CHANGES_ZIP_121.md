# Zip 121 — Salted password & PIN hashes, clock-proof stock counts, older-tab safety

Builds on zips 118–120. Everything works **online and offline**, and **nobody can be locked out** by the upgrade.

## Salted, slow password and PIN hashes
**Why:** every device keeps a copy of the shop password's hash (and each staff PIN's hash) so that signing in works offline.
Until now that copy was a plain SHA-256. Anyone who got hold of it could recover a short password or a 4-digit PIN with a
lookup table in seconds. That includes a lost phone, and anyone with the shop link while the shop is "open".

* **The new form.** Hashes are now stored as `p2$100000$<salt>$<PBKDF2-SHA256>`: 100,000 rounds, with a salt unique to each shop.
  * Every guess now costs 100,000× more.
  * Nothing can be precomputed across shops.
  * Every device of a shop seals a given password to the same value, so devices never flip it back and forth.
* **No re-typing.** The new form is built from the old hash, so every device upgrades its stored hashes by itself. Sign-in
  accepts both forms (all 7 apps and the Owner Console).
* **Waits until it's safe.** A till still running an older release would not recognise the new form, so nothing is sealed until
  both of these hold:
  1. this device has run zip 121 for 3 days;
  2. the shop's device list shows every device seen in the last 14 days on zip 121 or later.

  Until then everything stays exactly as before.
* **"Stay signed in" carries over** the change; nobody is signed out by it.
* **Lost or revoked devices can't come back.** A lost or revoked device holds only the sealed hash, and in a
  **"paired devices only"** shop that is **no longer enough to pair again**. Pairing there, revoking, and switching the mode now
  need the password itself (or a pairing code). Open shops still pair their own devices quietly in the background, as before.
* **Old-form writers still work.** Password resets from the Owner Console and demo accounts still write the old form. The first
  device that syncs it seals it.
* **Cost:** about 0.1–0.2 s once per sign-in on a phone. Nothing else is affected.

## Stock counts from a fast clock
A device whose clock ran fast could date a stock count into the future. The server would then refuse every real sale made
"before" it until the date came round. The server now treats any movement time later than its own clock (+1 minute) as "now"
(`moveTime` in `functions/api/_merge.js`).

## Older tabs on the same device
A tab still open on an older release writes stock movements without this release's mark. Once the stock ledger is on, those
count as **pending** like this build's own, so the till never shows stock that ignores a sale it hasn't sent yet.

## Backup restore (behaviour, documented)
Restoring a backup re-sends the movements in it. The server applies each movement id **once**, so movements it already has
change nothing, and movements it never received are applied. This is the correct event-replay behaviour: a restore can't double
stock or undo a later stock take.

## Tests added
* `tests/sealed-hashes.test.mjs`:
  * server proof matching, whichever side is sealed;
  * the release gate: nothing is sealed while a zip-120 till is active, and the gate opens by itself later;
  * sign-in with sealed hashes (shop app and Aqua), including staff PINs;
  * a sealed hash can't pair a "paired only" shop, while the password can;
  * "Stay signed in" survives sealing.
* `tests/mixed-release-tabs.test.mjs`: older-tab movements are pending; old history is not.
* `tests/stock-ledger.test.mjs`: a count from a clock a day fast no longer blocks later sales (both backends).
