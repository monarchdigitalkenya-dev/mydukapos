# Zip 133 — Cloudflare R2 for every module's pictures, the 🔔 approvals badge, "not collected" without a reason, the hospitality audit

No stored data is changed or deleted.

## 1. Pictures in Cloudflare R2, for all modules
**One media service** (`functions/api/_media.js` + `/api/media`) for every app:
* **product / menu photos** in the shop, hotel / restaurant / bar, pharmacy, hospital, production, services and Aqua apps;
* **radiology images**;
* **reference images** for the custom orders coming in the next phases.

**Storage:** R2 bucket `mydukapos-media`, binding `MEDIA`. Until the bucket exists, the same code keeps pictures in KV. After R2
is switched on, anything stored in KV is still read.

**Product photos leave the synced item list.** Until now each photo was stored inside the items as text, travelled with every
sync and filled the device. Now, whenever a device is online:
* each photo is uploaded once, and the item keeps only a short address;
* the id is the photo's own fingerprint, so a retry stores nothing twice;
* an edit made meanwhile wins;
* this runs automatically on every device, in the background; nobody has to do anything;
* the service worker of every app keeps each photo on the device after its first load, so photos still show **offline**;
* a photo never loaded on a device shows a plain "photo" placeholder instead of a broken image.

**Security:**
* **Storage keys carry the shop**, so a shop can never read another shop's pictures.
* **Uploads need the shop's licence and a paired device.**
* **Files are checked by their real signature** (JPEG, PNG or WebP only, no SVG or disguised files), with size limits per kind.
* **Radiology and reference images are private:** they are served only to a paired device and never cached publicly.
* **Product photos are served with `nosniff` and a locked-down CSP.**

**Radiology** uses R2 too. Images uploaded by zip 132 are still shown.

## 2. Hospital
* **✖ Not collected:** the reason is now optional.
* **🔔 Badge on 💵 Cashier Shift:** the number of void, discount and refund requests waiting.
  * Managers see what waits for them, from any device.
  * Cashiers see their own requests.
  * A manager gets one toast when a new request arrives.

## 3. Hospitality OS — the audit
`HOSPITALITY_GAP_ANALYSIS.md` maps every part of the master prompt against what the Hotel / Restaurant / Bar app already does:
✅ implemented, 🟡 partial, ❌ missing, ⚠️ needs fixing. It also sets the delivery plan: the order engine first, then kitchen / bar
routing, secure QR ordering, the pool / pool-table / facility engine, hotel, custom orders and events, then roles and reports.

## Deploy — R2 needs one extra step, once
Create the bucket once, before `npm run deploy`:
```
npx wrangler r2 bucket create mydukapos-media
```

## Tests
`tests/zip133.test.mjs` (10 tests):
* R2 storage per shop: idempotent, cacheable, isolated;
* the file-signature and size checks, and the KV fallback;
* radiology on R2 plus old images;
* photo offloading in the shop, hotel and Aqua apps;
* an edit meanwhile wins, and an old server is left alone;
* the service worker rule in all 8 apps;
* the optional reason, and the badge.

Plus the full suite.
