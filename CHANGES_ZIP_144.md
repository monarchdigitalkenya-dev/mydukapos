# Zip 144 — Receipt & thermal printing rebuilt on one engine (all modules)

Zip 144 includes zips 131–143.

## Why receipts came out broken (root causes, all confirmed)
1. **The paper width was a shop setting, defaulting to 80 mm — but each till has its own printer.** A 58 mm printer holds 32
   characters a line; receipts were laid out 48 wide. The PRINTER then wrapped every line at 32: words broken, "350.00 A" alone on a
   line, numbers under the wrong heading. The setting is also synced to every till and shared between branches, so one till's
   printer could never be right for all.
2. **The system print dialog (and the preview) used a different layout from the printer**: an HTML table plus text at a fixed
   12–13 px with `pre-wrap` + `word-break`. On 58 mm that is ~23 characters for text laid out for 32 or 48, so the browser split words
   and numbers ("350." / "00") and squeezed the item column. The preview was always drawn 80 mm wide, so it looked fine while the
   paper did not.
3. **The receipt was never really monospaced in the browser.** Every app sets `* { font-family: 'Segoe UI' … }`, which overrode the
   receipt's Courier on every line: space-padded columns drawn in a proportional font cannot line up.
4. **`@page { size: 58mm auto }` is invalid CSS** (a length cannot be combined with `auto`), so browsers dropped it and printed on
   their default paper — A4 / Letter (checked: the PDF came out 216 mm wide).
5. The content was laid out on the full paper width, but the print head only reaches 48 mm of a 58 mm roll (72 of 80): the right
   edge was clipped or the page scaled down.
6. Header/footer/payment lines were not fitted (e.g. "Date … Time …" is 35 characters), the wrapper could leave "KES" at the end of a
   line with the amount on the next, and a line laid out for wider paper was split mid-number instead of squeezed.
7. The HTML barcode had a fixed size and ran off 58 mm paper.

## The engine (src/shared/functions.js)
* **Paper:** `receiptPaperMm()` (this device's printer, else the shop setting) · `receiptPrintableMm()` (58→48 mm, 80→72 mm,
  custom in between) · `getPaperCols()` (32 / 48 / printable ÷ 1.5 mm for custom rolls).
* **Layout (one step for every output):** `receiptGridLines()` fits every line to the columns, wraps at word boundaries only,
  squeezes column gaps before wrapping, keeps "KES 350.00" together, centres/right-aligns with spaces exactly as a printer does.
  `thermalPrepareText()` (USB/Bluetooth) uses the same wrap.
* **Rendering:** `receiptGridHtml()` draws the grid in a monospaced font sized so exactly `cols` characters fill the printable width
  (measured in the browser by `fitReceiptGrids()`), with `white-space: pre` — the browser wraps nothing. The same function draws the
  preview, the system-dialog print, kitchen tickets / order slips / invoices (`setPrintBodyText()`), exchange receipts, and the
  PDF/Share image uses the same lines.
* **Page:** `receiptPageRule()` — `@page` = the roll width × the document's measured length (or the fixed length setting).
* **Money rows:** `receiptMoneyRow()` — label left, amount on the right edge, never split, never colliding.
* **Module content** stays each module's own (hooks into `buildReceiptDoc`): Hotel — RESTAURANT / BAR / ROOM SERVICE / TAKEAWAY /
  POOLSIDE / ROOM bill or receipt, Table or Room, Waiter, Guest, Check-in / Check-out, split-bill part; Services — SERVICE RECEIPT /
  SERVICE INVOICE; Production — hire (rental) receipts as before; Aqua POS — delivery / pay-on-delivery as before; Pharmacy / Hospital
  — dosage, sections as before. A new module passes its own `docLabel / headerExtra / locationLines / itemSubLines / paymentLines`.

## Settings
* **Settings ▸ Receipt ▸ Paper Width** keeps the shop setting and adds **"THIS device's printer paper": Same as above / 58 mm /
  80 mm / Other…** (kept on the device, never synced) and **📏 Print a width test** (USB/Bluetooth: prints a 32- and a 48-character
  ruler — if the 48 one breaks, the printer is 58 mm).
* The receipt window has a **58 mm / 80 mm** switch: the receipt is laid out again at once — the preview is what will print.
* Receipt scale above 100 % no longer pushes the receipt past the paper.

## Deploy
No server or router changes: `npm run deploy` only. On each till whose receipts were broken, open a receipt and tap **58 mm**
(or Settings ▸ Receipt ▸ THIS device's printer paper).
