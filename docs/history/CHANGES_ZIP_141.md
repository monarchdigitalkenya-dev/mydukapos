# Zip 141 — the four items still open after zip 140

Zip 141 includes zips 131–140.

## 1. Per-staff server sessions (all 7 apps)
Before, the server knew the **shop** (its link) and the **device** (pairing), but not **which staff member** was working. Permissions
were checked only in the app.

**Signing in**
* Staff still sign in with their PIN, even offline, exactly as before.
* When the device is online, the same PIN also starts a **server session** (`/api/staff-session`):
  * the server checks the PIN against the staff record **it** holds;
  * the sealed hash every device keeps is not accepted as the PIN;
  * removed or locked-today staff are refused;
  * PIN attempts are limited: 20 an hour per staff member, and a limit per shop.
* The session is signed with a key that never leaves the server. It carries the person's permissions and lasts 16 hours.
* Signed in offline? The PIN proof is kept **in memory only** and the session is asked for when the device is back online.

**Every new sale is signed**
* Each new sale gets a short session id plus a signature over its id, time and total.
* The server checks it on **every** sync and stamps the sale:
  * ✅ confirmed staff;
  * ⚠ changed after signing;
  * ⚠ staff member may not take payments (e.g. a waiter);
  * ⚠ session ended or unknown.
* A device can't forge a stamp. The server's own stamp is itself signed, so it stays correct through re-syncs.
* **A sale is never refused or dropped** for this.
* Sales made offline before the session arrived are signed once it does (covering up to a day).
* 📈 **Hospitality Reports ▸ Who made each sale** shows confirmed, waiting, not signed and flagged sales.

**Staff sessions required** (Settings ▸ 🔐 Devices & Security, Admin or a manager)
* When turned on, the server refuses these without a confirmed staff member:
  * QR codes and the online menu (these also need `orders.manage`, i.e. a supervisor);
  * incoming QR orders;
  * facility bookings;
  * M-Pesa code checks.
* **Selling is never blocked.**

**Also fixed:** the "does the server already have this version" check now notices a sale signed later, or M-Pesa-checked later.
Before, an M-Pesa verification result could stay on one device only.

## 2. Split bill by person / amount (Hotel)
* **Settle ▸ 👥 Split by person:**
  * tick what this person had;
  * their share of the service charge is added;
  * cash, M-Pesa or card, and their own receipt.
* **Settle ▸ ➗ Pay a share:** an amount, or **÷ equally** between a number of people.
* The order shows paid so far and the balance, on screen and on the printed bill.
* The last part closes the order, or **Settle** takes the rest. Its receipt lists the items not yet paid, less the shares already
  taken.
* **Nothing is counted twice:** sales, payments, product counts and cost of goods all add up to the bill once.
* Stock left at order time; nothing is deducted again.
* **Rules:**
  * items already paid for can't be removed, exchanged or moved;
  * a partly paid bill can't be charged to a room;
  * a voided part puts its amount back on the balance.
* Two tills taking parts of the same order at once: the server keeps both.

## 3. Bar units: bottle → tot / shot / double / glass (Hotel)
* **Setup:** Service Orders ▸ settings ▸ 🍾 Bar pours. Pick the bottle and its size (750 ml), then a price per pour size. The sizes
  are editable (default Tot 25, Shot 35, Double 50, Glass 150 ml).
* **How stock moves:**
  * the bottle stays in bottles, and the **open bottle is counted in whole ml** (the app's existing box & piece stock);
  * a new bottle is opened by itself;
  * every change is a whole-number stock movement, so the server's stock is exact, with no rounding drift;
  * a pour with no bottle left still sells and shows the shortfall;
  * voids and removed pours give the ml back.
* Each pour is a bar item with its own price, and its cost comes from the bottle.
* **Report:** 📈 **Pours by bottle** — pours, ml and bottles poured, value, profit, and what is left.
* **Bug fixed:** a dish's ingredients (0.2 kg of beef in a burger) came off only this device's copy. The server's stock ignored them
  until a catch-all correction at the next push, rounded to 3 decimals. They are now itemised stock movements.

## 4. Loyalty member levels (Hotel)
* **Setup:** Settings ▸ Loyalty ▸ ⭐ Member levels, e.g. Silver from KES 20,000 and Gold from KES 100,000. Each level has a
  **token multiplier** and **perks**. The period that counts is 365 days, or 0 for ever.
* **How a level is worked out:** from the sales themselves, and voided sales don't count. So every till agrees and a level never
  drifts.
* **In use:**
  * reaching a level is announced;
  * the level and perks show when you settle a member's order;
  * any discount stays the cashier's decision.
* 📈 **Loyalty members by level** in the reports.
* **Bug fixed:** paying an order (tab) never earned loyalty tokens. It does now.

## Tests
* **New test files, 13 new tests:**
  * `staff-sessions` (6): the PIN check, forged tokens, other shops, rate limit; sale stamping (tampered, waiter, forged, re-sync);
    the required mode; a shop with its own database; the till end to end (offline sign-in → online → signed)
  * `split-bill` (4)
  * `bar-pours` (2)
  * `loyalty-levels` (1)
* **Real Chromium at phone width:** the split screen, the pour settings, the member levels, the staff-session card and the reports.
  No errors and no sideways scrolling.
  * The browser check caught the split screen opening **behind** the Settle popup; this is fixed.
* **Full suite** in Kenya time.

## Deploy
`npm run deploy:router` is **needed**: the shop database's staff check, and the part-payment merge. Then `npm run deploy`.

**Optional:** set a Cloudflare secret `STAFF_SESSION_SECRET` (any long random text) so staff-session keys don't depend on KV. This
is not a payment credential. Without it, each shop gets its own random key in KV automatically.
