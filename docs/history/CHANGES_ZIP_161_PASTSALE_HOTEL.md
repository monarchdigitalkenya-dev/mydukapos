# Zip 161 - Past-sale fractions, and the hotel leftovers

## Job 1 - "Record a Past Sale" takes fractions (0.5, 0.25, 1.5 ...)

Owner report: "for recording a past sale I need to be able to sell even 0.5; it's typable but it auto-rounds to 1."
Cause: the quantity box had `min="1" step="1"` and `saveRecordPastSale()` read it with `parseInt`.

Modules that have the window and were fixed: `index.html`, `hotel`, `hospital`, `pharmacy`, `production`, `services`.
`water/` has no past-sale window (nothing to fix).

### What changed (all six, same code)
- Quantity box: `type="text" inputmode="decimal" step="any" min="0.001"` (a text box, so a comma keypad works and "1/2" can be typed).
- New shared `parsePastSaleQty(raw)`: accepts `0.5`, `0,5`, `.5`, `1,200.5`, `1.200,5`, `1/2`, `1 1/2`, `½`. Refuses empty, text, 0, negative, above 1,000,000, and anything that would round to 0 (below 0.001) with a clear message. Rounds to 3 decimals. It never rounds to a whole number. A single comma is a decimal comma ("1,200" reads as 1.2; use "1200" or "1,200.0" for twelve hundred).
- New shared `pastSaleTakeStock(product, qty)`: floors at 0 like a normal sale, rounds to 3 decimals (10 - 0.5 = 9.5, never 9.499999) and now LOGS a stock movement ("Sale (recorded late)") so the server ledger rebuilds exactly the same figure. Before, a past sale changed the number without a movement and relied on the "not itemised" safety net.
- Total = price x qty rounded to 2 decimals (also what the payment check uses). The sale line keeps the exact qty. "Only N in stock ... recording Q" now shows the fractions as they are.
- New shared `qtyRoundShown`: `formatQty` / `formatQtyDisplay` used to show 0.125 as "0.13"; a genuine 3-decimal quantity is now shown with its third digit. Anything longer (a recipe's 0.3333333) is still shown to 2 decimals, so no existing receipt changes.
- Production: a produced item / Set still uses `deductStockForSaleUnit` (its components are scaled by the fractional qty with `bomRound`, one movement per material, exactly like a normal fractional sale). New: the sale line now keeps `componentsUsed`, like a normal checkout, so a later void / return puts the same materials back (before it was dropped).

### The "pcs" rule found
Every unit is decimal-capable in the normal Sales Counter (`isDecimalUnit()` always returns true; the code comment says "there's no longer a whole-numbers-only mode"). So the normal cart allows 0.5 of a pcs item, and the past sale now does too. No unit is refused, so no unit-specific message was needed.

### Not changed (noted)
- Services / recipe dishes are not offered in Record a Past Sale in any module (the search excludes `type === 'service'`). Unchanged.
- Dual-unit (box / piece) items: the quantity is in boxes (as before); 0.5 takes half a box off the box count. Pieces are untouched.
- Items with variants: the parent quantity is reduced as before, not a chosen variant.
- The stock movement is dated when the past sale is entered (not the past date), on purpose: a movement older than a later stock take would be refused by the server ledger.
- The normal checkout's plain deduction (`deductStockForSaleUnit`) still does `before - qty` without 3-decimal rounding; a fractional normal sale could show float dust (0.3 - 0.1). Not touched here.

Tests: `tests/zip161-past-sale.test.mjs` (45 tests): every module x (attributes, 0.5 / 0.25 / 1.5 / 0.1 / 0.05 with exact stock, comma and fraction input, 3-decimal rounding, refused inputs, total rounding, `0.125` shown as 0.125, one exact movement, negative-stock confirm yes / no, pcs, dual-unit) + production BOM scaling + a two-way sync check against the real `pos-sync` (server stock equals the till's 9.5 / 9.25 / 7.75 and the movements applied once) for the retail and hotel apps.

## Job 2 - hotel leftovers (`hotel/index.html`)

(a) Collator: the suppliers table and the Bar buttons sort with `hospCatNameCmp` (accents / case ignored, 2 before 10). The shared `supplierOptionsHtml` uses it where the app has it (else the old behaviour).

(b) New owner switch in Categories & assign: "Hide items of switched-off categories from the Sales Counter and Orders" (`hospConfig.hideInactiveCatItems`, default OFF = today's behaviour; manager / inventory-access only; audited). ON: records of an inactive category leave the two grids and the All count; a search (name or code) still lists them, and barcode / the item search box are unaffected. Reactivating or switching OFF brings them back.

(c) Dead photo link in the inventory table: `onerror` swaps to the grey placeholder (the picture stays clickable). The Sales Counter grid and Orders menu already did this (zip 159, `hospImgFail`). Orders > Stations, printers & modifiers: checkboxes are 24 px inside 44 px labels (no `:has()`). The Orders new-order fields wrap, and every select / input is 100% wide (was clipped at 360 px; checked in real Chromium: no horizontal scroll, select inside its box).

(d) "Ask AI to suggest types" (import, All mode, optional): sends only rows with no type yet or only the built-in rules' guess, as `{n, name, category, price}` (<= 200 rows per call, up to 10 calls), to the SAME endpoint as the column reader (`PUT /api/ai-capture-list`, new request shape `inventoryTypes`; server side added in `functions/api/ai-capture-list.js`, keeps only ids it was given). The answer only fills the Type dropdown, tagged "AI suggested". It never replaces a type the user chose or the file's Type column, never imports, and if the endpoint fails the message says so and the rules-based suggestion stays. The help text under the buttons was updated.

(e) Chip switching at 5,000 items (real Chromium, headless, this sandbox, phone-less desktop viewport; seeded 5,000-item shop, 15 chips, 60 cells per page):
| | before | after |
|---|---|---|
| chip tap, median (JS) | 167 ms (max 212) | 22.5 ms (max 30) |
| chip tap to next frame, median | 172 ms | 26 ms |
| Bar panel alone | 75-96 ms | 1.2 ms |
| 60 cell pictures (`hospImgHtml`) | 68 ms | 0.06 ms |
Causes: (1) `hospBarSources` / the panel scanned the whole inventory once per bottle (O(n^2)); now the source -> servings map is built once per inventory index (cached on the category index, rebuilt whenever it is). (2) every picture cell asked for its type icon through the whole category index (1.1 ms each x 60); the icon is now remembered (it only depends on the fixed type labels). (3) `hospSetHtml` skips writing a grid / panel whose HTML is identical to what is shown (no DOM re-creation on repeat renders); a stock or price change still repaints. Target < 60 ms met. Not measured: a real phone; a shop with hundreds of bar bottles in Chromium (covered only by a jsdom test).

(f) `<body>` class toggles: `rsz-open` (receipt-size window, in `receiptSizeOpen` / `receiptSizeClose`, shared) and `hcat-open` (category manager / import window, hotel) with CSS rules keyed on the class beside the existing `:has()` rules (separate rules on purpose: an old WebView drops a rule it cannot parse).

Tests: `tests/zip161-hotel-leftovers.test.mjs` (11 tests, stubbed fetch for the AI).

## Files
`src/shared/functions.js`, `src/shared/blocks/receipt-size.html` (then `npm run sync`), the six module `index.html` files (past sale), `hotel/index.html`, `functions/api/ai-capture-list.js`, two new tests.
