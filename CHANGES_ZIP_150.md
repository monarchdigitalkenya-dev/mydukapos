# Zip 150: installed app "This link no longer exists" / permanent link "trial has ended"

Two reports: (1) after a user installs the web app it says "This link no longer exists"; (2) some permanent links say the demo trial has ended.

## Cause 1 — installed app loses the link token
A shop on a `?c=<token>` link (no subdomain) is identified ONLY by that query string. An installed app opens at the manifest's
`start_url` (`./?source=pwa`), which cannot carry a per-shop token, so `/api/license-status` got no client id -> `not_found` ->
"This link no longer exists". Shops on a subdomain (`name.mydukapos.store`) were never affected: the address itself names the shop.
* FIXED (index.html, hotel, hospital, production, pharmacy, services, water): the token is kept in localStorage
  (`pos_link_token:<app path>`) the first time the `?c=` link is opened, and used when the app is opened without one.
  Not done on a shop subdomain (nothing to fix there, and adding a token would change that shop's password salt, `hashSalt`).

## Cause 2 — one link's saved licence answer applied to another link
`pos_license_checkpoint` was ONE key per address, with no record of which link it belonged to. Links opened on the same address
(every `?c=` link shares `mydukapos.store`) overwrote / read each other's checkpoint, so when the licence server could not be
reached, a permanent link could be told a demo's countdown had run out ("Your free trial has ended (offline estimate)").
* FIXED (`src/shared/functions.js`: saveLicenseCheckpoint, estimateLicenseOffline): the checkpoint records its link; an estimate is
  only made from the checkpoint of the SAME link. A checkpoint from another link, or an old one with no record, is ignored (no estimate
  rather than a wrong one). Effect: one link's offline estimate is kept at a time on a shared address.

## Not changed / worth knowing
* Owner Console (`owner/index.html`) has its own licence code and is not touched.
* If the message "trial has ended" appears WITHOUT "(offline estimate)", the server itself answered `expired` for that link: check that
  link's record in the Owner Console (type/expiry), that is not a client-side problem.
* Best for installs: give each shop a subdomain link. Each subdomain is its own address, so installs and saved data never mix.
* Verified: `npm run check` (in sync); every inline script of the 7 apps parses; token and checkpoint logic exercised in a Node sandbox.
* NOT run here: `npm test` (no jsdom offline). New test `tests/link-token-and-checkpoint.test.mjs` needs `npm test` on your machine.
