# Zip 168 — Sales Counter checkout workspace (all modules)

UI/UX only. No change to cart state, calculations, stock, M-Pesa, sales records, permissions, API or database.

- Active Checkout is one card: header with item-count pill, Walk-in/Delivery, Table/Room, cart list, payment details, TOTAL, segmented payment selector, Confirm.
- The cart list scrolls inside the card (sticky header); the page no longer grows with the cart.
- The footer (payment fields, TOTAL, methods, Confirm) is anchored; on desktop the card is sized to the window so Confirm stays on screen (tested at 1600x900).
- Payment fields only show for the chosen method; M-Pesa fields lay out as a compact grid on wide screens; hint text hidden; phone label is "Customer phone (optional)".
- Mobile (<=900px) keeps the sticky bottom bar from zip 166.
- Applies to Shop, Hotel, Hospital, Pharmacy, Production, Services, Water (shared block receipt-extras).
- Tests: tests/zip168-checkout-workspace.test.mjs. Service worker stamp zip-168.
