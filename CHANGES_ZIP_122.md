# Zip 122 — Every button on the first tap, a much faster Stock Report, small-phone fixes

Builds on zips 118–121. Nothing about data or syncing changes, and everything works online and offline as before.

## How it was checked
Every app was run in a real mobile browser (headless Chromium with touch), offline:
* the Shop, Hotel, Hospital, Pharmacy, Production, Services and Aqua apps, plus the Owner Console;
* screen widths of 320, 360 and 390 px (phones) and 1280 px (desktop);
* sign-in, every tab (21–34 per app; 15 in the Owner Console) and the "More ▾" menu, each opened with a single tap;
* in every tab, every visible button, link, checkbox and dropdown, checked to make sure nothing sits on top of it.

**Result:** after the fixes below, there are 0 problems at every width and no page errors in any tab.

## Fixes
1. **Taps lost while the screen redraws.** Leaving a price or quantity box, or a sync arriving, redraws the cart and lists. A
   tap that landed during that redraw was dropped, and you had to tap again.
   * This was reproduced on the real till: with the cart price box open, tapping **+** did nothing on the first tap.
   * The new shared block `tap-rescue` notices exactly that case and presses the new button once. It never presses twice:
     a normal tap still adds exactly 1, on phone and desktop.
   * Nothing is pressed after a scroll or a long press, or when something else (e.g. a password box) now sits under the finger.
   * Buttons also get `touch-action: manipulation`, so there's no double-tap-zoom wait before a tap counts.
2. **Small phones: the "More ▾" button could slide off the screen.** On a 360 px phone, opening a long-named tab (e.g.
   "↩️ Returned Goods") pushed More past the right edge. It couldn't be tapped, so the other tabs were unreachable. The tab bar
   now keeps More on screen, shortening the active tab's label with "…" if needed.
3. **Android: the More menu snapped shut while you scrolled it.** The browser's address bar sliding away (and the keyboard
   opening) counts as a "resize", which closed the menu and re-laid the tabs. Now only a real width change does.
   * The same applied to Aqua's product grid (it redrew on every scroll) and the item-suggestion list (it closed when the
     keyboard opened).
4. **Buttons hidden under the floating ⌨️ / ⬆️ buttons.** The last buttons on a page (e.g. Reports ▸ Debts / Returns) sat under
   them. Pages now have room at the bottom, so everything can scroll clear. Printing is unchanged.

## Speed: Stock Report, 51 s → 0.7 s
Measured with a shop of 3,000 items and 5,000 sales on a CPU slowed 4× to phone speed:

| | Zip 121 | Zip 122 |
|---|---|---|
| Stock Report opens | **51.6 s** | **0.7 s** |
| Add to cart / search / + | 40–60 ms | 25–60 ms (unchanged) |
| Page load | ~1.7 s | ~1.7 s |

* **Totals in one pass.** The report used to re-scan the whole sales and stock history for every item, several times. It now
  totals every item in one pass (`stockReportTotals`). The figures are identical to before, checked against the old code on
  random data.
* **Paged table.** The table shows the first 200 rows, with **Show more** and **Show all** underneath (`reportRowLimit`). Search,
  totals and printing still cover every item.
* **All apps.** Every app's Stock Report gets both changes. The slowest tab is now Stock Take at about 1 s for a 3,000-item
  count sheet.

## Tests added
* `tests/first-tap.browser.test.mjs` (real Chromium; skipped where Playwright isn't installed):
  * one tap adds exactly one, with no redraw, a redraw on press, a redraw on mouse-down, and the real price-box case;
  * on a small phone, More stays on screen and a height-only resize doesn't close the menu.
* `tests/stock-report-speed.test.mjs`:
  * the figures match the old per-item code (Shop, Aqua, Hotel);
  * a sale recorded right afterwards is counted;
  * 3,000 × 5,000 builds fast and pages 200 → 400 → all.
