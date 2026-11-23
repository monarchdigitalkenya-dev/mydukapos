# Shared public demos (zip 262)

## What changed
Visitors no longer get a demo shop of their own. There is **one fixed demo per product**, pre-loaded with sample data, at a fixed address:

| Demo | Address (root domain from `getRootDomain`) | App |
|---|---|---|
| Hospital HMIS | `demo-hospital.<domain>` | hospital |
| Hotel & Restaurant | `demo-hotel.<domain>` | hotel |
| Retail Shop | `demo-retail.<domain>` | shop |
| Hardware Store (kg, g, m, ft, L, pcs, decimals) | `demo-hardware.<domain>` | shop |
| Liquor Store (category + sub-category) | `demo-liquor.<domain>` | shop |
| Pharmacy | `demo-pharmacy.<domain>` | pharmacy |
| Production & Bakery | `demo-production.<domain>` | production |
| Salon & Services | `demo-services.<domain>` | services |
| Water Business | `demo-water.<domain>` | water |

Sign in as **Admin**, password **0000** (shown on the website with a Copy button).

## How it works
* `functions/api/_shared-demos.js` - the catalogue and `ensureSharedDemo()`. The shop records are fixed (`demo_<name>`), created once, `sharedDemo: true`, never expire.
* `functions/api/_demo-seeds.js` - pure generators (`buildDemoSeed(kind, now)`): deterministic (same ids every time), dates relative to "now". No base64 anywhere.
* **Idempotent + versioned seeding**: runs only when the demo was never loaded, when `SEED_VERSION` (`_demo-const.js`) is raised, or when the copy is older than 14 days (dates stay current). A normal visit costs one KV read for the seed mark.
* **Safe reset**: Owner Console -> Public Website -> *Shared live demos* -> **Reset** (or *Create / refresh all demos*) -> `POST /api/shared-demos`. It re-seeds that one demo id only, and refuses anything whose record is not `sharedDemo === true`, so it cannot touch a permanent shop.
* **Visitors cannot corrupt each other**: the server stores nothing for a shared demo (`pos-sync.js` acknowledges and drops every push; `requireValidLicense` answers `demo_readonly` for any other write endpoint). A visitor's edits stay in their own browser.
* **Client** (`src/shared/blocks/shared-demo.html`, all 7 apps): only on `demo-*` addresses *and* after `/api/license-status` confirms `sharedDemo`. After the first load of the sample the app stops pushing, polling and opening its live socket; a DEMO banner shows the password and **Reset demo** (clears that device's copy, reloads the original data).
* **Simulated, never live**: STK prompts return a simulated `DEMO-...` request that "succeeds" after a few seconds (`mpesa-stkpush.js`, `mpesa-status.js`); no SMS/WhatsApp/email can be sent because every non-sync write is refused for a demo.
* **No access beyond the demo**: a demo id resolves only to its own record; the Owner Console and every other tenant need their own sign-in. `0000` is the demos' password but is not reserved: from zip 326 a real shop may use it too and the server stores it like any other password.
* **Rate limit**: opening a demo is limited to 120 per IP per hour (`DEMO_OPEN_HOURLY_LIMIT`).
* **Pictures**: `demo-img/*.svg` (about 1 KB each) and `public-site/img/demo-*.svg`, cached for a week by `_headers`; `image` in the data is a short path, so nothing is stored per demo or per visitor. Regenerate with `node tools/make-demo-images.mjs`.

## Public website
* `public-site/index.html`: new **Live demos** gallery (`#demos`): card per demo with image, description, features, **Try Live Demo**, login instructions and a copy-password control. Hero / nav / pricing calls to action now point at it.
* `public-site/app.html`: the "Generate your demo" account form is replaced by the live-demo buttons for that product.
* `public-site/dashboard.html`: the generate-demo form is gone.
* **Removed**: the anonymous generator (`/api/public-demo` now answers 410 and reads/writes nothing) and the `generate-demo` action of `/api/demo-account` (410). The website's `register` no longer creates a shop.
* **Kept**: account creation (`register`, sign-in, password reset, verification), the dashboard, the Owner Console lead list, permanent-shop approval. The **in-app sign-up** still creates its trial shop together with the account (it is the account-creation flow of the apps, so it was not removed).

## Measured effect (not estimated) - `node tools/measure-demo-usage.mjs`
One visitor who opens the demo, loads it and rings up 20 sales, real server code over an in-memory KV and a SQLite D1 stand-in:

| | before (private demo shop) | after (shared demo) |
|---|---|---|
| Creating the shop + account | 17 KV reads, 17 KV writes | 0 |
| The session | 44 reads, 22 writes, 1 list, **180 D1 statements** | 3 reads, **0 writes, 0 D1 statements** |
| One-off, not per visitor | - | 5 writes + 6 reads to create/load a demo (at most once a fortnight) |

Not included in the numbers: the old client's background polling for a 7-day demo; the new demo client makes no state request after the first load (asserted by `tests/zip262-shared-demo-client.test.mjs`).

## Database
No new database, table, index or migration. Keys: `license:demo_<name>`, `slug:demo-<name>`, `pos-data:state:demo_<name>`, `shared-demo-seed:demo_<name>` (KV).

## Sample data notes
* Hospital: 24 patients (allergies, next of kin), 40 visits with SOAP + vitals + diagnoses (ICD-10), prescriptions that show **NA on the same prescription** (not stocked / out of stock), labs with reference ranges and a pending one, 4 admissions, appointments, patient notes, a live queue, beds/wards, medicine stock with batches and expiry, the 3 newest visits unpaid at the cashier.
* Hardware: items sold by pcs, kg, g, m, ft, L with decimal quantities. Liquor: every category from the brief, with a `subcategory` field (the apps have no sub-category screen, so the sub-category is stored on the item and the main category is what the counter filters on).
* Demos for any product without a self-service demo are not included.

## First time after deploy
Open Owner Console -> Public Website -> **Create / refresh all demos** (or just press Try Live Demo on each; the first click creates it). A web address `demo-<name>` must not already belong to another shop - if it does, the creation reports it and the other shop is left alone.
