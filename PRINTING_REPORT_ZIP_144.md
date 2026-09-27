# Printing rebuild — report (Zip 144)

## 1. Root cause of the broken receipt
Seven causes, each confirmed in code and, where marked, reproduced in a real Chromium print:
1. **Wrong column count for the printer.** Paper width was one shop-wide, synced setting defaulting to **80 mm (48 characters)**.
   A 58 mm printer holds **32**. Every line was 16 characters too long, and the printer's own line-wrap broke words, split numbers and
   left "350.00 A" on a line of its own — the reference photo's symptoms.
2. **Two layouts.** The preview / system dialog used an HTML table plus text at a fixed 12–13 px with `pre-wrap` + `word-break`, which
   re-wrapped text laid out for 32/48 characters at ~23 per line on 58 mm (words and numbers split). The preview was always drawn at 80 mm.
3. **Not monospaced (Chromium, reproduced).** `* { font-family: 'Segoe UI' … }` in every app overrode Courier on every receipt line;
   space-aligned columns in a proportional font cannot line up.
4. **Invalid page size (Chromium PDF, reproduced).** `@page { size: 58mm auto }` is invalid CSS → dropped → printed on Letter/A4
   (216 mm wide).
5. Content laid out on the full roll width, although the head prints only 48 of 58 mm (72 of 80).
6. Unfitted header/payment lines; "KES" could be separated from its amount; over-wide rows split mid-number.
7. Fixed-size HTML barcode ran off 58 mm paper.

## 2. Modules inspected
Shop (root), Aqua POS, Hotel/Hospitality (restaurant, bar, room service, rooms, QR orders, split bills), Hospital/HMIS, Production
(hire), Services, Pharmacy, Owner Console.

## 3. Printable documents found
| Document | Where built | On the engine now |
|---|---|---|
| Sales receipt, bill / invoice (pay later), bill payment receipt, contract invoice, reprint | `buildReceiptDoc` (all 7 apps) | ✅ grid, 58/80/custom, preview = print = ESC/POS |
| Restaurant / bar / room-service / takeaway / poolside / room bill & receipt, split-bill part | Hotel → `hotelReceiptHooks` | ✅ module content |
| Service receipt / invoice | Services hooks | ✅ |
| Hire (rental) receipt, deposit, due now | Production hooks | ✅ (content unchanged) |
| Delivery / pay-on-delivery receipt | Aqua POS hooks | ✅ (content unchanged) |
| Dispensing receipt with dosage, hospital fee sections | Pharmacy / Hospital hooks | ✅ (content unchanged) |
| Exchange / return receipt | each app | ✅ grid |
| Kitchen / bar order tickets (KOT), order rounds, hospitality custom-order invoice | kitchen-ticket window | ✅ grid + valid page length |
| Receipt PDF / Share image | `buildReceiptCanvas` | ✅ same laid-out lines |
| USB / Bluetooth raw receipts, relayed jobs | `thermalPrepareText` / ESC/POS | ✅ same wrap; device width |
| Reports (sales, stock, profits, X/Z, stock take), statements, barcode/QR sheets, restock notes, attendance | report window / A4 print windows | ◻ own table layouts (reports on a roll now get a valid page size) |
| Owner Console's own receipt | owner console (no shared code) | ◻ not migrated |

## 4–6. Engine, files, what was consolidated
`src/shared/functions.js`: `devicePaperWidth`, `receiptPaperMm`, `receiptPrintableMm`, `setDevicePaperWidth`, `getPaperCols`,
`receiptGridLines`, `receiptGridHtml`, `fitReceiptGrids`, `setPrintBodyText`, `receiptMoneyRow`, `receiptPageRule`,
`printPaperWidthTest`, updated `thermalWrapLine`, `buildReceiptDoc`, `buildReceiptCanvas`, VAT rows. All 7 app `index.html`
(sync + width reads + exchange receipt + kitchen window + settings/preview pickers + page rules), Hotel and Services hooks, guide text.
The separate HTML receipt table, its fixed 12–13 px font and every hard-coded width read were replaced by the engine.

## 7–9. 58 mm / 80 mm / custom
58 mm → 48 mm printable → 32 characters. 80 mm → 72 mm → 48. Custom (e.g. 70 mm) → printable interpolated → printable ÷ 1.5 mm characters.
Each till: Settings ▸ Receipt ▸ **THIS device's printer paper**, or **58 mm / 80 mm** on the receipt itself.

## 10. Browser printing
The receipt is a monospaced grid, font sized so exactly the column count fills the printable width (measured in the browser),
`white-space: pre`; `@page` = roll width × measured length, margin 0; only the receipt prints.

## 11. ESC/POS
Font A, lines fitted to the device's column count, header/footer centred by command, TOTAL/heading bold, raster Code 39 barcode sized to
the head width, feed-and-cut.

## 12. Offline
Nothing needs the server: every document is laid out from the sale on the device.

## 13. Tests performed
* `print-engine` (jsdom): all 7 apps × 58 / 80 / 70 mm × long data (78-character name, 1,250 × 987.50, split payment, bill with
  balance, 4 VAT classes) — no line wider than the paper, no split amount, **preview lines = ESC/POS lines**; reference receipt checked
  line by line; device-width override and page size; relay 80→58; hotel documents; services documents; kitchen slips in 6 apps.
* `print-engine.browser` (real headless Chromium, print media): Shop, Hotel, Aqua POS at 58 and 80 mm — monospaced font measured,
  no line wraps, nothing overflows, text fills 97–100 % of the printable width, barcode inside, **PDF page = 57.8 × ~134 mm / 80.1 mm**
  (was 216 mm Letter).
* Existing receipt tests (receipts, receipt-uniform, raw barcode, bills, dosing, sales-and-print, hotel-fixes), updated where the design
  deliberately changed (the preview is no longer a separate HTML table; the page length is now valid CSS).
* Full suite: **1,328 tests, 1,328 passed, 0 failed** (Kenya time, per-test time limit).

## 14. Limits
* Not printed on physical printers here. Do one test print per till (📏 **Print a width test** for USB/Bluetooth).
* Browsers cannot print silently or choose the printer; the print dialog's own "scale"/"margins" must stay at default / none.
* A long reference in Code 39 on 58 mm is at the edge of what the head can print sharply (bars ~1.7 dots); scans should be checked.
* Reports and A4 statements keep their own table layouts; the Owner Console's own receipt was not migrated.
