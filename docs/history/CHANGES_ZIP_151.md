# Zip 151: sales made on one device did not reach the other device

## Symptom
Sales rung up on device A and device B: each device showed only its own sales.

## Cause found (client, all apps)
After a device pushes, the server answers with `prev` (the server's time before that push). `pushNow()` uses it to decide "another
device changed something that I have not seen -> pull it". The rule was `data.prev > heldUpTo && heldUpTo > 0`. A device that had
NEVER pulled (new device, cleared browser data, sync marker reset, a tablet that sold before its first pull finished) has
`heldUpTo === 0`, so the rule said "nothing missed", moved its marker to the merged time, and every later pull answered "unchanged".
The server had merged both devices' sales; that device just never asked for them.

Reproduced against the real server code (functions/api/pos-sync.js) with two simulated devices: before the fix the new device saw
only its own sale, after the fix both devices see both.

## Fix
`heldUpTo > 0` removed from the rule (src/shared/functions.js `pushNow`, copied identically into index, hotel, hospital, production,
services, pharmacy) and the same in water/index.html (`held > 0`, its own push code). A brand-new shop (prev = 0) still does not
trigger a pull.

## Test
`tests/first-pull-after-push.test.mjs` (plain Node, no jsdom): checks the rule taken from the shared source, and runs two devices
against the real server.

## Not changed
* owner/index.html has its own copy of the rule (Owner Console data, not shop sales).
* If, after this, two devices STILL show different sales, they are not on the same shop: open Settings on both and compare the link
  (`?c=` token or subdomain). A different link is a different shop and never shares data (see CHANGES_ZIP_150).
* NOT run here: `npm run check` and `npm test` (no jsdom/acorn offline). Run both before deploying.
