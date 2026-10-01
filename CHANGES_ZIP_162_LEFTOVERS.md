# Zip 162: leftovers of zip 161

Tests: `tests/zip162-photo-grid-qty.test.mjs`, `zip162-stock-dust.test.mjs`, `zip162-past-sale-services.test.mjs`, `zip162-crm-paging.test.mjs`,
`zip162-owner-push.test.mjs`, `zip162-water-fresh-device.test.mjs`, `zip162-workflow.test.mjs`. Shared code in `src/shared/functions.js` (synced).

## 1. Quantity left on photo cards
- Every Sales Counter photo card (all modules with `#item-image-grid`, water has none) and the hotel Orders menu cards show a small pill: "12 pcs left" (unit omitted for pcs, `formatQtyDisplay` + `unitLabel`),
  amber at or below `LOW_STOCK_THRESHOLD`, and the price turns red with "Out of stock" at 0. Nothing for unlimited services; recipe services (hotel dishes) show what the recipe can still make (`getServiceAvailableQty`), never "out".
  Never negative, live (re-rendered with the grid), dark-mode readable (`html[data-theme="dark"]`), no overflow at 360 px (checked in Chromium, light and dark).
- New shared `gridStockInfo`, `gridStockPillHtml`, `setShowItemQtyLeft`. Per-device Settings toggle "Show quantity left on photo cards" (default ON, `localStorage pos_show_item_qty`) next to the Photo Grid toggle.

## 2. Fractional checkout dust
- New shared `stockRound3(n)`: 3 decimals; a value already within 1e-6 of a 3-decimal number is snapped, finer genuine values (recipe materials, 6 dp) are only cleaned to 6 dp. Whole numbers unchanged.
- Applied on sale (`deductStockForSaleUnit`, dual-unit, variants, pharmacy FEFO batches, hospital `deductFefoBatches`, gas, contract stock), restock/void (`restoreStockForSaleUnit`), returns, hold returns and PO receive.
- Server ledger parity is tested through the e2e harness (client stock equals the ledger after fractional sales, voids and returns).

## 3. Past sales of recipe / service items
- `liveSearchPastSaleItem` no longer hides services (SERVICE badge, recipe badge). New shared `pastSaleConsume(product, qty, ts)` runs the module's own checkout deduction for a service
  (hotel kitchen ledger dated at the sale time) and the sale line carries `componentsUsed`, `serving`, `wholesalePrice` like a normal checkout. Non-services still use `pastSaleTakeStock`.
  Production services go through it too; produced items / Sets keep the BOM path. Water has no past-sale window.

## 4. CRM
- Staff profile (`getStaff`): ONE batch after the auth prelude = 2 D1 trips (budget in zip161-crm-speed changed 6 -> 2).
- `GET /sales`: `limit` + `before=<sold_at>:<id>` keyset, `hasMore`, `nextCursor`; Sales screen pages 50 at a time with "Load more". Inbox: `limit` + `before` (the null-tail cursor condition was also fixed), 50 per page, "Load more".
- Lead list: keyset infinite scroll (IntersectionObserver, 400 px margin, "Load more" fallback, `after=`, `count=0`) for the created/updated sorts; other sorts keep the numbered pager.
- `crm-admin.js` is now dashboard/products/campaigns/sales only; new `crm-admin-more.js` (reports, staff, settings incl. automation and legacy import, audit) is loaded on demand by `CRM.lazyAdmin()`.
  `crm/sw.js` v `crm-sw-2` precaches it and stamps cached answers with `X-Crm-Set`; if the shell set changed since the page started, the lazy load reloads once (sessionStorage guard) instead of mixing old and new files.
- `tests/crm-ui-boot.mjs` evaluates lazily injected scripts; crm-ui static check now forbids only `serviceWorker.register(` in crm-core.js.

## 5. Owner Console pushNow - conclusion: no change needed
The Owner Console does sync shop state (`inventory`, `salesLog`, bills, staff, ...) through `/api/pos-sync`, but it never stamps records per edit (no `stampDirty*`), so a record carried from old storage keeps its old
`updatedAt` and loses to the server's newer copy or tombstone, which was the zip 159/160 hazard. Its settings are left out of a push until a pull has happened (`__ownerPulled`, zip 155), deletions are
tracked by key acks, and `pullStateOnce` pushes unsent work before applying a pull. So ignoring `skipPrePull` is harmless. `zip162-owner-push.test.mjs` pins it (stale storage pushing first does not resurrect a deleted item or overwrite newer stock).

## 6. Water fresh-device link path - one defect fixed
Water has no `pushNow`; it uses `doPush` / `pushNowOrWarn` (both wrapped by `trackPush`, which counts `__pushInFlight`). A FRESH water phone (no `aqua_pw_hash`) opening `?invite=` or `?staff=` went through
`attemptClaimedLinkAutoLogin`, pulled the shop, and then showed the plain login picker: the link's screen (invite / personal PIN) never appeared (the zip 161 `authLinkRecheck` only ran for devices that already had a password).
Fixed: `attemptClaimedLinkAutoLogin` now calls `authLinkRecheck()` after the pull. Tested with the e2e harness (`?invite=` shows the invite screen for the right person, `?staff=` the PIN screen, overlapping pushes end with `__pushInFlight` 0).
The other six apps do not have this path (they recheck after `flushThenPull`).

## 7. GitHub workflows (static validation)
actionlint 1.7.12 (pip `actionlint-py`): no findings on both files. Checked: YAML parses, `needs` chains (android build -> emulator; windows build -> collect), matrix = the 8 keys of `native/apps.json`,
artifact names unique per cell (`part-<app>`), referenced scripts / lockfile / icons / gradle wrapper exist, lockfile matches package.json, cache key path valid, only the documented secrets are used, no `.git` history or root `node_modules` needed.
Fixes: `permissions: contents: read` on both; Windows collector ignores the NSIS `__uninstaller-*.exe` stub that electron-builder may leave in `dist/` (it would have been published as an installer); Android build-tools selection accepts 40+ as well.
Test: `tests/zip162-workflow.test.mjs` (needs python3 + PyYAML, skipped otherwise).

### NOT verifiable without GitHub / real runners
- That the jobs actually run green (Gradle build and SDK download on ubuntu-latest, `npm ci` and electron-builder on windows-latest, the 16 installers, NSIS/MSI install-run-uninstall).
- Emulator job (KVM, api 30 image, `emulator-check.sh` on a real screen), aapt2/apksigner in the runner's build-tools.
- Release signing with the real secrets; the cache hit behaviour; whether `native/**` path filters trigger as intended on the real branch names; whether electron-builder really leaves an `__uninstaller` file (the filter is defensive).
- Runner image updates (action versions `@v4`, `@v2` are pinned by major only).

## 8. Other 161 limitations
The plain-deduction dust note is done (job 2). FTS stays opt-in and lead export is unchanged (decided, not done). Browser-only items (installed PWA / WebView behaviour of `target=_blank`, real phones) remain unverified.
