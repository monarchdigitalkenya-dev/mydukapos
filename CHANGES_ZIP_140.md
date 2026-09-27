# Zip 140 — Kenya Hospitality & Leisure OS (zips 134–140 in one release)

Zip 140 includes zips 131–133. It builds the master prompt on the EXISTING Hotel / Restaurant / Bar app. It is one platform, one
order engine, one billing path, one stock ledger, one customer list and one sync. Nothing was rebuilt; nothing duplicated.
`HOSPITALITY_GAP_ANALYSIS.md` has the audit this started from and the status after it.

## Phase 1 — One order engine (🍽️ Service Orders)
Built on the existing **tabs**: a tab is an open order for a table, room, guest, takeaway or poolside seat.
* **Every order** has a type (dine-in, takeaway, counter, bar, room service, poolside, delivery, phone, event…), a source
  (waiter, cashier, table QR, room QR, table / room barcode, pool attendant…), a waiter and an outlet.
* **Waiter "New order":** opens the fast Sales Counter screen (search, categories, photos, barcode) for that table.
* **Active orders:** a waiter sees only their own; managers, or the setting, see all.
* **Right-side panel** (⅓ of the screen; full screen on a phone):
  * ＋ / － on a line, remove, 🔁 exchange, 📝 note;
  * move / split ticked items to another table, room or name, and merge orders;
  * 🔴 rush;
  * history;
  * settle.
* **Only the change prints.** Every change is a new revision round, and the original rounds are never rewritten:
  * `ADDED: 1x Chicken Wings`
  * `LESS / REMOVED` (a reason is required)
  * `CANCEL: Fanta / INSTEAD: Coke`
  * `NOTE: no onions`

  Stock follows each change exactly: an exchange gives the old item back and takes the new one. The price difference follows by
  itself.
* **Settle order → bill:** the bill (not a receipt) is printed and the order is locked for the waiter. It appears in 🧾 Bills ▸
  "Orders waiting for payment", and the cashier takes the payment. Only a manager or cashier can reopen a printed bill.
* **Service charge:** a %, chosen per order type (Tables & Rooms). It is never charged on room nights or deposits.
* **One unified receipt:** the net lines plus the service charge, whatever kitchen or bar made them.
* **Audit:** every change, bill and reopen is in 🔍 Audit, from the records themselves.

## Phase 2 — Kitchen & bar (📺 Kitchen & Bar Display)
* **Stations:** Kitchen and Bar, plus any you add (Bakery, Pool Bar…). Each category can be routed to a station; otherwise food
  goes to the kitchen and drinks to the bar.
* **Mixed orders:** the kitchen ticket (KOT) has only the food, the bar ticket (BOT) only the drinks. One bill.
* **The display:** each station sees only its own items: New → Accepted → Preparing → Ready → Served.
  * Waiting timer, prep time per item, late orders in red, rush first.
  * The waiter gets "🔔 Ready to serve".
  * Statuses merge per line on the server, so the kitchen and a waiter never undo each other.
* **Printer routing:** a station can print on its own printer through the existing 🌐 print network (rules "🍺 Bar tickets →
  Bar device"). A station with no rule of its own uses the order-ticket rule. If that printer can't be reached, the ticket
  prints here (the fallback) with a warning.
* **Modifiers and add-ons** (extra cheese, no onions, cooking level, sugar, size…):
  * required groups and choice limits, with prices;
  * printed under the line and shown on the display.

## Phase 3 — Secure QR ordering (📱 tables, rooms, poolside, cabanas)
* **The code:** each place gets a random 192-bit token, never "/table/12".
  * The token must belong to the shop whose link it is scanned on.
  * Revoked, expired, altered or other-business codes all answer "not valid".
  * Codes can be switched off or regenerated (the old one stops at once), and printed on a QR sheet.
* **The customer page** (`/order/`, no app):
  * the menu, prices, photos and modifiers the shop **published** (never stock, costs or ingredients);
  * an order, then live status;
  * everything is built as text, under a strict Content-Security-Policy.
* **Orders are safe:**
  * prices are set on the server (the phone's prices are ignored);
  * a double tap is one order;
  * orders are rate-limited per code and per shop.
  * They wait until staff **accept** them on a till, which checks "already accepted elsewhere". Only then is stock deducted and the
    kitchen and bar get their tickets, on that table's bill.
* **Customer status:** the customer's page follows the kitchen: confirmed → preparing → ready → served.
* **Waiters:** scan a table or room code to open that order.

## Phase 4 — Facilities (🎱 pool, pool tables, cabanas, rooms…)
One generic resource engine: swimming pools, pool / snooker / billiards tables, cabanas, conference and meeting rooms, private
dining, courts, gaming areas, event spaces.
* **Timed sessions:** start, pause (not charged), resume, move to another table, end.
  * Manager-only charge adjustment, with a reason.
  * Maintenance and out-of-service block play.
* **Pricing:** per minute, per 30 minutes, per hour (by the quarter), fixed, per person or per day.
  * Minimum session.
  * Peak hours (Kenya time) and member rates.
* **Pool passes:** entry, day pass, family package… with capacity (a full pool sells nothing more) and expiry.
* **Reservations:**
  * checked on this till and then on the **server**, against every booking it holds;
  * in a shop with its own database the check and the booking are **one atomic step**, so two tills can never both win;
  * cancel, reschedule and check-in (which starts the session).
* **One bill:** table time, passes and deposits are lines on the same bill as the food and drinks. Pool-table players' drinks go to
  the bar, onto the same bill.

## Phase 5 — Hotel (🏨)
* **Rooms:** room types and nightly rates, filled in at check-in.
* **Reservations:** a 14-day room grid.
  * A room is never sold twice: the same server clash check, plus a check against the guest currently occupying the room.
  * Arrivals list, and check-in from a reservation (the deposit carries over).
* **Charge to room:** post any outlet's bill (restaurant, bar, pool) to the guest's folio. It respects the stay's credit limit.
* **Checkout:** the existing folio (room nights, room service, charged-to-room bills, service requests, less the deposit); one
  receipt.
* **Housekeeping:** after checkout a room is **dirty → cleaning → clean → inspected (available)**, with a log. Out-of-order rooms
  can't be reserved for tonight.
* **Service requests:**
  * towels, pillows, extra bed, baby cot, laundry, maintenance, decorations, honeymoon, birthday or anniversary setups, flowers,
    balloons, cake, dietary requests…
  * each goes to a department and moves requested → assigned → in progress → done;
  * a charged request goes on the folio when done.

## Phase 6 — Custom orders, catering, events, packages (🎂)
* **One workflow:** request → quote → customer approval → deposit → schedule → production → quality check → ready → collected /
  delivered → completed (or cancelled with a reason).
* **Details:** cake fields (size, weight, shape, flavour, filling, layers, tiers, theme, colours, message, decorations, allergies)
  and event fields (venue, guests, menu, drinks, equipment, setup, staff, dietary, décor).
* **Reference pictures:** compressed, checked, and stored **privately** in R2 (only this shop's devices can open them).
* **Quotes** are sent by WhatsApp. **Deposits and balances are real sales with receipts.** Production can't be scheduled before
  the deposit, and an order can't be completed with a balance.
* **Production:** a ticket goes to the bakery / kitchen with the message and an **ALLERGY** warning.
* **Quality check:** a failed QC says what to fix. When it's ready the customer is told by SMS through the shop's own provider;
  if SMS isn't set up the app says so and opens WhatsApp. **An SMS is never pretended.**
* **Events and catering:** book their venue with the clash-proof reservations.
* **Packages** (e.g. a family pool package): one priced line. Its food and drinks go to the kitchen / bar and come off stock, and
  its pool access creates passes counted against capacity.

## Phase 7 — Roles, outlets, reports, M-Pesa
* **Hospitality roles:** waiter, bartender, chef, cashier, receptionist, housekeeping, pool attendant, event manager,
  storekeeper, supervisor, accountant. Each role ticks the right tabs and permissions.
  * A **waiter** sends orders but **cannot take payment** or cancel items the kitchen has started.
  * A **cashier** takes payment; a **supervisor** can do both and see reports.
  * Staff from before roles keep exactly today's behaviour.
* **Outlets** (Restaurant, Bar, Pool Bar, Room Service…): each device belongs to one; orders and sales carry it.
* **📈 Hospitality Reports** keep **sales, payments, outstanding, refunds, costs and estimated profit apart**. They cover:
  * breakdowns by outlet, order type, source, waiter and table;
  * top products and beverages;
  * every order change with its reason;
  * hotel occupancy, room-nights and revenue, and guest balances;
  * pool passes, swimmers and the busiest hour;
  * pool-table hours and use;
  * custom-order quotes, deposits, production and balances;
  * unverified M-Pesa payments.
* **A typed M-Pesa code is no longer proof of payment** (all 7 apps).
  * Each sale with a typed code is checked against M-Pesa's own records that reached the shop: completed STK prompts (now indexed
    by receipt number) and payments straight to the till / paybill.
  * The code is **claimed** by that sale, so one M-Pesa payment can never pay two sales.
  * Results: verified, paid less, already used, or no record yet. Daily Sales shows a warning for anything not verified.

## What still needs you (not faked)
* **R2:** run `npx wrangler r2 bucket create mydukapos-media` once.
* **M-Pesa verification** needs the shop's own M-Pesa set up (STK in Settings ▸ Payment Gateway, and/or C2B confirmations). Without
  it, typed codes stay "no record found" — shown honestly, never as verified.
* **SMS** needs the shop's provider (Settings ▸ SMS). eTIMS needs the shop's own eTIMS credentials.
* **Permissions:** checked in the app for each staff login. The server checks the shop, the paired device, published prices, QR
  tokens, bookings and M-Pesa codes. **Per-staff checks on the server** would need per-staff server sessions. That is the next
  step if you want it.

## Tests
* **New test files, 52 new tests:**
  * `hospitality-orders` (12): the restaurant end to end, delta tickets, exchange, notes, move / split / merge, waiter visibility,
    old orders, merge rank; the display, stations, printer routing (device and server), modifiers;
  * `qr-ordering` (7): security, pricing, idempotency, rate limit, pairing, XSS-safe page, QR restaurant end to end;
  * `facilities` (6): the pool-table and pool end-to-end scenarios, pricing rules, session controls, reservations, the server
    booking check including two tills at the same moment in a real shop database;
  * `hotel-ops` (2): the hotel end to end and the credit limit;
  * `custom-orders` (3): the custom-cake end to end, the event venue, packages;
  * `hospitality-final` (4): RBAC, reports reconciling with transactions, M-Pesa verification, presets.
* **Real Chromium** at phone width: every new screen opens with no errors and no sideways scrolling; the side panel fills the
  phone screen.
* **Full suite** in Kenya time.

## Deploy
`npx wrangler r2 bucket create mydukapos-media` (once, if not done in zip 133), then `npm run deploy:router` (**needed**: the
shop-database booking step, the tab and radiology merges) and `npm run deploy`.
