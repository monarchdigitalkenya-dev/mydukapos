# Zip 163

## Counter (all modules except Aqua's own layout, which got the same bar)
- Total, payment method buttons and **✅ Confirm** now sit in one sticky bar at the bottom of the sale on phones and computers; the floating buttons lift above it. No scrolling past a long cart to pay.
- **Settings → Payment methods you accept** (every module): tick the ones you take; only those show on the counter (and hotel Settle Tab). At least one stays on. Synced to every device.

## Hotel
- Orders → "This order": each line is a name + amount row over a grid of big buttons (−1 +1 −½ +½ 123 📝 ✕); nothing is clipped at 390 px.
- Categories wrap onto rows (no sideways scrolling) on the Sales Counter and Orders.
- **Sub-categories** (Settings → 🗂️ Sub-categories): inside a category (e.g. Milkshakes) create 200 / 100, then assign each flavour; a second chip row appears under the category.

## Measurements & purchases (Shop, Hotel, Hospital, Pharmacy, Production, Services)
- Restock: "📦 Bought as" card per row — stock unit as counted, a pack (Box/Carton/Sack with contents), or another unit of the same kind (g↔kg, ml↔l, cm↔m); packs + loose pieces (2 boxes + 5 = 53); total cost paid → effective unit cost (full precision). Stock is converted once; the delivery's expense is the exact total.
- Contents override warns and applies to that delivery only unless "Remember" is ticked.
- Weighted-average buying cost after every restock/arrived order (per-item "Last purchase price" option). Purchase history per item (40 kept) and purchase facts on the stock-movement entry.
- ⚙️ Units (per item): pack name/contents, cost method, "ask how much when selling", measurement precision.
- Measured selling: by price (KES 250 of KES 1000/kg = 0.25 kg) or by amount in any same-kind unit, quick chips; quantity lands on the line in the stock unit. Never charges more than the customer asked to spend.
- 📊 Purchases report (Restock tab): period, purchase qty, stock qty, total and effective cost, plus sold qty / revenue / profit.
- Money on these screens is shown in whole KES (unit costs under KES 10 keep 2 decimals); everything stored keeps full precision.

## Known limits
- Aqua POS has no purchase cards (its Restocking tab is materials). Per-item minimum stock is not stored (the shop-wide threshold still applies). Existing receipts/reports elsewhere still show KES with 2 decimals.
