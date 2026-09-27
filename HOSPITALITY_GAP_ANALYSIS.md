# Kenya Hospitality & Leisure OS — Audit & Gap Analysis (zip 133)

This is the first step of the master prompt: inspect what exists before changing anything. The hospitality module is the
**Hotel / Restaurant / Bar app** (`hotel/`, "HRB-POS"). It shares one core (`src/shared/`) with the shop, pharmacy, hospital,
production, services and water apps.

## How the platform is built
This architecture is kept, not replaced. Rebuilding it would destroy working, tested features, which the brief forbids.

| Layer | What it is | Consequence for the brief |
|---|---|---|
| **Client** | One offline-first web app per business type, with shared functions and blocks kept identical by `npm run sync` / `check`. | Offline selling works today. New modules are added to the same app, not as separate systems. |
| **Data** | Each shop's state is JSON records synced to Cloudflare. Bigger shops use a Durable Object with SQLite (`wildcard-router/shop-store.js`). Every record is merged by id (`functions/api/_merge.js`). | "Normalized relational DB" means: records with ids, merged per record server-side, plus append-only logs (sales, stock movements, audit). No new database product. |
| **Tenancy** | Every request is resolved to one shop (licence + link) and optionally a paired device (zip 125). Storage keys carry the shop id, including R2 media (zip 133). | Tenant isolation is enforced server-side. Branches are linked shops (`branches.js`). |
| **Auth** | Admin password (salted, slow hash), staff PINs, manager PINs, a server-checked admin session for protected fields (zip 121), per-tab roles. | RBAC is per tab/role. Granular permissions, checked server-side for every action, are a gap (below). |
| **Payments** | M-Pesa STK push with verified callback (idempotent per CheckoutRequestID) and a status poll; Paystack; C2B confirmation; per-tenant credentials only (zip 119). | Sound base. Gap: a typed M-Pesa code is accepted as payment without reconciliation. |
| **Tax** | eTIMS configuration and submission endpoint (`etims-submit.js`), with status tracked per invoice. | Real integration layer, which needs each business's own eTIMS credentials. |
| **Media** | R2 (zip 133), falling back to KV. | Product photos, radiology images and custom-order reference images all use one service. |

## Status by area

**Legend:** ✅ implemented · 🟡 partial · ❌ missing · ⚠️ needs fixing

| # | Area | Status | What exists / what is missing |
|---|---|---|---|
| 4–6 | Multi-tenant, multi-branch, outlets | 🟡 | Tenant isolation ✅; branches as linked shops ✅; cross-branch sales ✅. **Missing:** outlets/departments inside one branch (Restaurant / Bar / Pool Bar / Room Service) as a first-class setting that drives routing and reports. |
| 7 | Business type setup | 🟡 | One app per business type; the hotel app covers hotel + restaurant + bar. **Missing:** a "what does this business have?" selector that switches modules (pool, pool tables, events, bakery…) on and off. |
| 8 | Roles & permissions | 🟡 | Tabs per staff, manager overrides, admin-only settings, server-checked admin fields. **Missing:** named hospitality roles (waiter, bartender, chef…) with granular permissions (orders.void, payments.refund…); waiter sees only their own orders. |
| 9 | One order engine | 🟡 | **Tabs** (rounds of orders on a table / room / guest, one consolidated bill) plus the counter checkout. **Missing:** order type and source on every order (dine-in, takeaway, room service, QR, poolside…), a per-order status lifecycle, and one "orders" model the kitchen, bar and bills read from. |
| 10–12 | Waiter Orders / Active Orders panel | ❌ | Staff add rounds via the Sales Counter → tab. **Missing:** a waiter "Orders" screen, "Active orders" with the side panel (add, update, exchange, notes, settle). |
| 13 | Delta printing | 🟡 | Each round prints its own KOT, so an added round prints only the new items ✅. **Missing:** per-item revisions (changed, removed, exchanged) printing only the change, with who, when and why. |
| 14 | Item exchange | ❌ | Returns/exchanges exist for completed sales. **Missing:** exchange inside an open order, with price, tax, stock and kitchen deltas. |
| 15–16 | Settle → Bill → Cashier; one receipt | 🟡 | Tab "Settle" collects payment directly; one consolidated receipt ✅. **Missing:** "settle for billing" (waiter finalizes → bill appears in Bills → cashier takes payment) as a separate step. |
| 17 | Table management | 🟡 | Tables with statuses (available / occupied / reserved / cleaning), reservation fields, open tab per table. **Missing:** floors / sections, the full status set (ordering, preparing, bill requested…), assign waiter, transfer, merge, split. |
| 18–21, 36, 64, 87 | Secure QR ordering (table / room / poolside) | ❌ | Receipt QR image only. **Missing:** signed per-table / room / location tokens, a public no-install menu page, a server endpoint that accepts customer orders into the right table, revocation and regeneration, rate limits, printing QR sheets. |
| 20, 47 | Barcode scanning | ✅ / 🟡 | USB, Bluetooth and camera scanning for products; barcode generation and printing ✅. **Missing:** table / room barcodes. |
| 22–24 | KOT / BOT / mixed routing / KDS | 🟡 | KOT per tab round ✅; the "Kitchen" tab tracks dish preparation batches. **Missing:** item → station routing (kitchen / bar / bakery / pool bar), BOT, a kitchen/bar display with statuses (new → accepted → preparing → ready → served), priorities, prep time. |
| 25–26 | Menu, modifiers | 🟡 | Items / dishes with images, categories, prices, cost, VAT class, barcode ✅. **Missing:** modifiers and add-ons (extra cheese, no onions, sugar level, size), preparation station and time per item. |
| 27–29, 71–72, 91–93 | Custom orders (cakes), catering, events, packages, service requests | ❌ | Contracts module (fixed-price agreements) exists. **Missing:** the quote → approval → deposit → production → QC → ready → collected workflow, reference images (R2 ready), catering / event bookings, packages, hotel service requests. |
| 30, 90 | Hotel: rooms, stays, folio | 🟡 | Rooms, check-in with nights and deposit, stay → folio at checkout (room + tab charges), room → cleaning after checkout ✅. **Missing:** room types and rates, a reservation calendar with conflict detection, housekeeping status workflow (dirty → cleaning → clean → inspected), maintenance / out-of-order, posting any outlet's bill to a room folio. |
| 31 | Room service | 🟡 | Orders can go to a room tab ✅. **Missing:** a room-service order type / source and a room QR. |
| 32–41, 69–70 | Pool, pool tables, facility / resource engine, reservations | ❌ | **Missing entirely:** a generic resource engine (pools, pool/snooker tables, cabanas, conference rooms…), timed sessions (start / pause / resume / end, per-minute / hour pricing, peak / off-peak), pool tickets and passes with capacity, facility reservations with server-side double-booking prevention. |
| 42–43, 73 | Customers, loyalty | ✅ / 🟡 | Customers with purchase history, loyalty tokens ✅. **Missing:** reservations, stays and sessions on the customer history. |
| 44–46 | Bar units, recipes, inventory | 🟡 | Recipes / ingredients deducted per sale ✅, units incl. pieces / boxes, stock take, immutable stock ledger, wastage via stock movements ✅. **Missing:** bottle → shot / ml / tot conversions for bar recipes and breakage as its own movement type. |
| 48 | Purchasing | ✅ | Suppliers, purchase orders (WhatsApp, in transit, arrived), restock with cost ✅. |
| 49–51, 75 | Payments, M-Pesa, billing | 🟡 | Cash, M-Pesa (STK + verified callback), card, split cash/M-Pesa, pay-later bills, partial payments ✅. **⚠️** A typed M-Pesa code is accepted as proof (should be marked "unverified" until reconciled with C2B). **Missing:** service charge, split bill by item / person / amount, merge bills. |
| 52–54 | Cashier shift, discounts, void / cancel / refund | 🟡 | Shift / float / close with variance (hospital), manager-approved discounts / voids / refunds (hospital, zip 132), voids with reason and stock back in all apps ✅. **Missing:** the same cashier-shift and approval tools in the hotel app. |
| 55–56, 86, 88 | Printers, routing, receipts | 🟡 | USB / Bluetooth / system printing with reconnection, 58 / 80 mm, PDF receipts, cash drawer, customer display ✅. **Missing:** routing rules (item / category / station → printer with fallback). |
| 57, 82–83 | Offline, idempotency | ✅ | Offline selling, sales journal, client ids + device + sequence, server merge by id, idempotent pushes, central connectivity (zips 127–131) ✅. |
| 58 | Real-time | ✅ | WebSocket poke + fast pull; station boards refresh ✅. |
| 59 | Notifications | 🟡 | SMS (any provider), WhatsApp click-to-chat, email for resets ✅. **Missing:** order-ready / reservation notifications for hospitality. |
| 60–61 | Reports | 🟡 | Sales, insights, staff, stock, bills and debts, expenses and profit, X/Z ✅. **Missing:** table / waiter / KOT, bar variance, occupancy, pool / pool-table utilisation, custom-order pipeline. |
| 62 | Audit | ✅ | Audit tab and admin activity log ✅ (hospitality events are added as each module lands). |
| 63, 65 | Security | ✅ / 🟡 | Hashing, sessions, device pairing, tenant keys, rate limits on sensitive endpoints, CORS, output escaping, R2 uploads checked by real file signature (zip 133) ✅. **Missing:** per-action server authorization (see RBAC). |
| 76–77 | eTIMS, Kenya-first | ✅ / 🟡 | KES, Kenya time for days, M-Pesa, eTIMS layer, thermal printing ✅. |
| 84 | Backups | ✅ | Automated server backups, restore, verification (owner console) ✅. |

## Duplicates found
None in the hospitality app itself. The hospital app's shift / approvals code and the hotel app's tabs are the pieces to share,
not copy.

## Delivery plan (one module per zip, each end-to-end tested)
Every phase extends the existing tabs, bills, stock ledger, printers and sync. Nothing is built as a second system.

1. **Order engine:**
   * Every tab order gets a type, source, per-item station and status.
   * Waiter **Orders** + **Active orders** side panel.
   * Revisions with delta KOT / BOT (added, removed, changed, exchanged).
   * Item exchange.
   * **Settle for billing** → Bills → Cashier.
   * Service charge.
   * Split bill by item / amount.
2. **Kitchen & bar:**
   * Stations (kitchen / bar / bakery / pool bar), item → station routing.
   * Kitchen/bar display with statuses and prep times.
   * Printer routing with fallback.
   * Modifiers and add-ons.
3. **Secure QR ordering:**
   * Signed per-location tokens (tables, rooms, poolside, cabanas), revoke / regenerate, printable sheets.
   * A public menu page with no install.
   * Server-validated, rate-limited customer orders into the right tab.
   * Table / room barcodes.
4. **Resource engine:**
   * Resources (pool, pool / snooker tables, cabanas, conference rooms…) with pricing rules.
   * Timed sessions (start / pause / resume / end / extend / transfer).
   * Pool tickets and passes with capacity.
   * Reservations with server-side conflict detection.
   * Everything billed through the same tab / bill.
5. **Hotel:**
   * Room types and rates, a reservation calendar.
   * The housekeeping workflow, maintenance.
   * Folio posting from any outlet, service requests.
6. **Custom orders, catering and events:**
   * Quote → approval → deposit → production → QC → ready → completed.
   * Reference images (R2), packages.
7. **Roles and reports:**
   * Hospitality roles with granular permissions (waiter sees own orders…), outlets / departments.
   * Hospitality reports (table / waiter, bar variance, occupancy, utilisation).
   * The M-Pesa typed-code "unverified until reconciled" fix.

## Status after zip 140
Phases 1–7 of the delivery plan are built (see `CHANGES_ZIP_140.md`), each end-to-end tested:
* the order engine and waiter screens;
* kitchen / bar routing and the display;
* secure QR ordering;
* the facility engine (pool, pool tables, reservations);
* hotel operations;
* custom orders, catering and events;
* roles, outlets, reports, and M-Pesa code verification.

**Still open (deliberately not faked):**
* **Per-staff authorization on the server.** Today the server checks the shop, the paired device, published prices, QR tokens,
  bookings and M-Pesa codes; staff permissions are checked in the app. Per-staff server checks need per-staff server sessions.
* **Split bill by person / amount.** Split by item is done: move ticked items.
* **Bar units.** Bottle → shot / ml deductions for cocktails. Recipes deduct whatever units an item is set up with today.
* **Loyalty tiers.** The existing loyalty tokens are unchanged.

## Status after zip 141
The four items still open after zip 140 are built (see `CHANGES_ZIP_141.md`), each end-to-end tested:
* **Per-staff server sessions.** The server checks the staff PIN against its own staff record, signs a session with that person's
  permissions, checks every sale's staff signature on sync (stamping it, never dropping it), and — when the shop turns it on —
  refuses QR / menu / booking / M-Pesa-check actions without a confirmed staff member or the permission.
* **Split bill by person / amount**, each part a real sale with a receipt.
* **Bar units**: bottle → tot / shot / double / glass, the open bottle counted in whole ml.
* **Loyalty member levels** on top of the token brackets.

**Still open (deliberately not faked):**
* **Cocktails from several bottles.** A pour takes one bottle's ml. A cocktail can use the existing dish recipe (ingredients in
  bottles), which is itemised now but counted in fractions of a bottle.
* **Breakage** as its own stock movement type (today: a stock adjustment with a reason).
* **Member discounts applied automatically.** Levels show perks; any discount stays the cashier's decision.

## Status after zip 142
* **Bar units: done.** Shots, doubles, glasses and bottles from open bottles, with exact ml, never oversold. See `CHANGES_ZIP_142.md`.
* **Draught kegs: done.** Individual kegs with conflict-free multi-till counting, replace / wastage / measure / reconciliation, low
  alerts and audit.
* Breakage of packaged stock is still a stock adjustment with a reason. Keg wastage has its own reasons.
