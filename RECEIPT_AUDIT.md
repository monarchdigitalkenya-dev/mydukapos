# Receipt audit — System dialog, USB, Bluetooth (all 8 apps)

Verified by rendering a sample sale in every app at 58 mm and 80 mm, in justified/left/right alignment (32 combinations)
and decoding the exact bytes sent to a USB/Bluetooth printer. **Not verified on physical printers** — do one test print per mode.

## What was wrong
| Mode | Problem | Where |
|---|---|---|
| USB + Bluetooth | **No column headings** (left/center/right modes), or a heading that didn't line up with the rows (justified) | all apps; Aqua POS had none at all |
| USB + Bluetooth | Text sent as UTF-8: "—", "’", accents printed as junk characters | all apps |
| USB + Bluetooth | **Fixed 32-column layout ignoring the paper width** — on 80 mm paper everything sat in the left two-thirds | hotel, hospital, school, pharmacy, Aqua POS |
| USB + Bluetooth | The VAT table's rows were 33–34 characters wide, one or two more than a 58 mm roll holds, so the last digit wrapped onto its own line | all apps |
| USB + Bluetooth | Long item names wrapped mid-word (the printer breaks lines, not us) | all apps |
| System dialog | Text printed **grey** (not forced to black) — grey almost disappears on a thermal printer | hotel, hospital, school, pharmacy, production |
| System dialog | Thin Courier text, and item codes at 10 px | all apps |
| On-screen / system | The "Amount" column was really the unit price; "Subtotal" the line total | 6 apps |

## What changed
* Printer-safe text (accents stripped, dashes/quotes mapped, unsupported symbols dropped) and Font A selected on every raw print.
* One column table for raw receipts: `ITEM  QTY  PRICE  AMOUNT`, name wrapped over full width, VAT class letter after the amount.
* All raw receipt lines fitted to the configured paper width; lines never exceed it.
* 58 mm VAT table uses a compact layout that fits 32 columns.
* System dialog: pure black, bold, ≥ 11 px, 2 px rules. Column titles are now Item / Qty / Price / Amount everywhere.

## One receipt for every app (this update)
All 8 apps now build their receipt with the SAME code: `buildReceiptDoc()` / `renderSharedReceipt()` in
`src/shared/functions.js`. Shop's layout is the default everywhere. The on-screen preview, the system print dialog,
USB and Bluetooth are all produced from the same rows and lines, so they can no longer drift apart.

* **Payment details on every receipt.** Paid receipts print a "Payment details:" block (Paybill / Till / phone from
  Settings > Receipt) above the thank-you line; bills keep "Please settle via:". Previously only unpaid bills showed them
  (and in Aqua POS never on a paid sale).
* **Aqua POS preview = print.** It used to build the preview and the printed text separately (different line order, 32- vs
  48-column rules, no item codes/VAT letters, bills titled "Sales Receipt"). It also ignored the Paper Width setting on the
  system dialog (hard-coded 80 mm) and sent USB/Bluetooth one plain left-aligned block. It now uses Shop's print pipeline:
  queued jobs, configured paper width, configured copies, centred/bold header on USB/Bluetooth.
* **Per-app differences are small hooks**, not copies of the layout: Aqua POS (delivery block, site, pay-on-delivery,
  total from the sale record), Production (hire labels/rows/deposit lines, hire footer notes), Pharmacy (Rx line).
  Production's hire lines used to be print-only; they now show in the preview too.
* School's old plain-text receipt (32 columns, VAT-inclusive total) was replaced by the same layout.
* Aqua POS still prints a bare quantity ("2") instead of "2pcs", because its items have no unit.

To change the receipt for every app: edit `buildReceiptDoc()` in `src/shared/functions.js`, then `npm run sync`.

## Who served
Every printed bill and receipt now always carries a "Served by:" line, in the print and the preview. A record saved with
nobody on it (older sales the owner rang up themselves) shows the admin. The Bills tab has a "Served By" column in every
app that has one (School has no Bills table).

## Settle without a receipt, and Share as PDF
* The bill settle window has a **💾 Save (no receipt)** button next to the print one, in every app. It records the payment
  exactly the same way (sales log, bill history, eTIMS) but shows and prints nothing.
* **Share** on a receipt now always sends a **PDF file** (`shareReceiptNative()`, one shared copy). It no longer attaches
  the receipt as text, and no longer falls back to a text share or a WhatsApp text link. Browsers that can't hand a
  file to another app save the PDF instead so it can be attached by hand.

## Stock report: retail value columns
The Stock Report (screen and printout, every app) now has **Opening Value (Retail)** and **Closing Value (Retail)** for
each item, with totals, next to the existing cost columns (renamed "(Cost)"). Retail = quantity x the item's current retail
price, the same way the cost columns use today's cost price. Loose pieces of box/piece items are not included in these
per-item columns (they still are in "Total Stock Value — Retail").

## Reference number + barcode on USB / Bluetooth receipts
* USB and Bluetooth receipts never printed the reference **barcode** (only the on-screen / system-dialog receipt had it), and
  Aqua POS, Hotel, Hospital, School and Pharmacy ended the job with a plain full cut (`GS V 0`) that could slice through the
  last printed line — the Ref number. Now every raw receipt sends `GS V B 0` (feed to the cutter, then cut, as Shop, Production
  and Services already did) and, right under the Ref number, the same Code 39 barcode as an image (`GS v 0`), sized to the paper
  (58 mm / 80 mm). Follows the Reference Number / Barcode switches where a module has them (Hotel).
* Needs a printer that can print raster images (practically every ESC/POS thermal printer). Not tested on physical printers.

## Still to do
* Not verified on physical printers - do one test print per mode (system dialog, USB, Bluetooth).
* If a receipt is still faint after this, check the **printer's own** density/darkness setting and the paper (thermal paper ages).
