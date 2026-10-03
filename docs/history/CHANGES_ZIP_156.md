# Zip 156 — everything left from the 2026-09-29 request

## Storage / server
- Permanent shops move to the Durable Object (SQLite) store at first push; KV keeps demos. KV path re-checks a version stamp before writing.
- Cross-branch sales log idempotent movements; bill/debt payments merge by id; list fields never replaced by non-arrays; archived records carry `_at`.
- ShopStore parity with KV (settings guard, sticky inventory fields, bill/debt merge, history skips tombstones).

## Native
- Android: HTTP 5xx / SSL error → offline screen, renderer crash recovery, cookie flush on pause.
- Windows: 5xx → offline page, renderer crash → reload; build is a parallel matrix.

## Printing
- Print relay carries the exact receipt bytes (stamp/logo included) to the printing device.

## Client (line-by-line audit)
- A pull can no longer wipe an unsent bill; bill instalments count only money received; receipts still show original/paid/remaining.
- Void/unvoid/void again restores stock every time; bill void voids its payments; storage-full is retried and shown.
- Pay-on-Delivery collects the real amount (was KES 0), saves it, records once, keeps the bill closed.
- Returns restore the sold unit/variant; oversell across cart lines refused; flat offers baked into lines; exchanges count the price difference only.
- Aqua void restores bottles/tanks/BOM; checkout rollback covers Aqua stock.
- Movement logged for inline piece/variant edits, new restock items, Store→Branch credit, hospital/pharmacy returns; hotel/hospital qty reductions need approval; togglePaidStatus gated and audited.

## Known limits
- `loyaltyPoints` stays last-write-wins. Legacy bill payments recorded before this zip are not linked to their bills.
- KV race is only narrowed where `SHOP_STORE` is unbound.
- Not fixed: archive splitOld scope for unsent tradeCredits/attendance/adminActivity; syncHaveCheck sig residual; hotel tab rounding, production BOM, Aqua restock/dispatch/tank fill/stock take not audited.
