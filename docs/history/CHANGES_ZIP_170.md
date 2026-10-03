# Zip 170 — printing, speed, connection check

## Printing
- Order ticket (kitchen slip) printed sideways: a short ticket got a page shorter than the roll is wide (e.g. 80 mm x 40 mm), which the browser/driver treats as LANDSCAPE and rotates. receiptPageRule() now never makes the page shorter than the roll is wide, so it stays portrait (58 mm roll -> 58 x 60 mm, 80 mm -> 80 x 82 mm). Long receipts are unchanged.

## Lag / hangs (measured with 3,000 products + 6,000 sales)
- Every save re-hashed all 6,000 sales (sales journal) - now remembered per record (exact: the version string is recomputed whenever the record's content changes). ~25 % faster per sale.
- stockValueTotals(): one code->item map instead of scanning all stock for each row (was 3,000 x 3,000 compares) in every app.
- Phone card-view of tables: no longer re-labels every row of every table every 2.5 s.
- Storage compression slice 60,000 -> 16,000 characters: a sale recompresses ~4x less data.
- Checkout card (zip 168): removed the scroll listener that forced a layout on every scroll frame.
- Background 2.5 s timers pause while the app is hidden.

## Internet detection
- The "is this device online?" questions (our own site + outside internet) are now asked at the same time (up to 18 s -> 9 s), and while "offline" the re-check waits 2/3/5/8/12 s (was up to 30 s), so a connection that came back is noticed much sooner.
- Any device still shown as offline/unavailable reports the evidence to Owner Console -> Errors (already in zip 147): look there for the cause on a phone that keeps saying "no internet".

Tests: tests/zip170-print-speed.test.mjs. Service worker stamp zip-170. No migration.
