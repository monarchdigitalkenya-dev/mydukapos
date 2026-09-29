# MyDukaPOS zip 152 — production audit repair

Every item is reported ROOT CAUSE / FILES / FIX / TEST / RESULT / REMAINING RISKS.
Nothing here was tested on a real phone, a real printer, or a live Cloudflare deployment (none is available in the build environment).
"Tested" means the automated jsdom / fake-KV test suite in `tests/`.

## 1. Checkout crash: sale lost, stock deducted (CRITICAL)
- ROOT CAUSE: zip 149 used `cardAmount` in checkout in hotel, pharmacy, services and production without declaring it. Checkout threw a ReferenceError after stock had been deducted and before the sale was saved.
- FILES: `hotel/`, `pharmacy/`, `services/`, `production/` `index.html`; new `runGuardedCheckout` in `src/shared/functions.js`, wrapped around checkout in all 7 apps.
- FIX: declared the variable. Added a guard so any checkout failure rolls stock back through the ledger and never leaves a half sale.
- TEST: `checkout-every-app`, `checkout-guard`.
- RESULT: passes. On the original zip the stock-deducted-no-sale state was reproduced.
- REMAINING RISKS: the guard covers exceptions. A tab killed mid-checkout is covered by the existing sales journal, not by this change.

## 2. Multi-device sales, stock, reference numbers
- FINDING: the existing design (server-stamped merge, stock ledger applied once, server-allocated till numbers) holds up.
- TEST: `multi-device-chaos` (4 devices, offline/online shuffles, stale reads).
- REMAINING RISKS: real network conditions, and Cloudflare KV eventual consistency beyond what the test simulates.

## 3. Disappearing product image and shot/tot config
- ROOT CAUSE: inventory merged whole-record, newest `updatedAt` wins. A device that only changed stock, or held a stale copy without the photo/pour setup (`image: null`), carried a newer stamp and erased those fields on the server and every other device.
- FILES: `functions/api/_merge.js` (`mergeInventoryRecord`, `INVENTORY_STICKY_FIELDS`).
- FIX: the newest record still decides everything it states. A sticky field it leaves empty keeps the older record's value. Nothing in the UI removes an item photo, so empty is never a deliberate clear.
- TEST: `inventory-sticky-merge`.
- REMAINING RISKS: the sticky field list is by name (image, imageUrl, imageKey, pourOf, bottleMl, shotMl, totMl, shotPrice, totPrice, pours, pourSizes, servings, keg). A field with a different name would not be protected.

## 4. Receipts
- Payment Method line, bold; split payments show Cash / M-Pesa / Card portions.
- Logo is rasterised to ESC/POS (GS v 0) for 58 and 80 mm on raw printers, so it physically prints.
- Business name shows exactly as the tenant entered it, with no auto suffix.
- TEST: receipt tests in `tests/`. Physical print was NOT tested.

## 5. Add Item screen
- UPLOAD IMAGE now sits in the form directly above ADD CODE (boxed, dashed). The left panel is gone. No camera. Full-width single panel.
- FILES: `index.html`, `hotel`, `hospital`, `pharmacy`, `production`, `services`.
- TEST: `zip132` (image survives the normal flow).

## 6. PWA / links
- `SW_VERSION` bumped to `zip-152` so installed apps pick up this release.
- `license-status` now sends `Cache-Control: no-store`, so a cached "expired" answer cannot be replayed.

## NOT DONE in this zip (be aware)
- General Shop bottle/shot/tot selling: the shop app has no shot/tot fields today (only the hotel bar has them). Not built.
- Store: Capture List restock, zero stock kept visible, atomic Store→Branch movement with destination and history: not changed.
- Sales-counter stock display: not changed.
- Real-device, printer, Android/PWA install, Cloudflare and 24h+ soak tests: not run.

## Test evidence
- Full automated suite (`npm test`, 1399 tests): 1398 passed on the first complete run. The one failure was the service-worker release stamp check, caused by my bumping only some stamps. All stamps now say `zip-152` and that check passes (27/27 in the affected files). `npm run check` passes.
- Multi-device chaos, 4 seeds: all converge. With the fake store serving old reads (as KV can for up to about a minute), the server briefly lacked some sales (seed 2026: 4 of 46) until the stale reads stopped, then every device converged. That is delayed convergence, not permanent loss. The test now proves this.
- The stale-read seeds can fail on a heavily loaded machine (timing), so run them alone.
