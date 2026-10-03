# Zip 142 — Shots & keg management (Hospitality / Hotel POS only)

Zip 142 includes zips 131–141.

It is built on what the Hotel app already had: one inventory, one order engine (tabs), one settle / payment / receipt path, one
stock ledger and one sync. There is no separate module. **Retail is unchanged** (packaged drinks sell as before; there is no keg or
shot screen there — tested).

## Three kinds of drink stock, never confused
| Kind | Example | Stock | A sale takes |
|---|---|---|---|
| Packaged | Tusker Bottle 500ml, a can | bottles / cans | 1 bottle |
| Open-bottle servings | Johnnie Walker 750 ml | sealed bottles + **ml in the open bottle** | 30 ml (a shot) |
| Draught (keg) | Tusker Lager 50 L keg | sealed kegs in the store + **each keg on tap in ml** | 500 ml |

Nothing is forced on existing products: shots and kegs are switched on per product.

## Shots, doubles, glasses, bottles
**Setup:** 🍺 Bar & Kegs ▸ Set up a drink.
* Choose the bottle size, then tick each serving with its size and price, e.g. Shot 30 ml KES 350, Double 60 ml KES 650, and
  Bottle KES 7,000.
* The **business default shot size** (30 ml) is set once. A product can use its own size (a 40 ml or 50 ml shot).

**The bartender** taps **SHOT · DOUBLE · BOTTLE** under the drink on the Sales Counter. Nobody types millilitres.

**How stock moves:**
* A shot takes its ml from the **open bottle**, and a new bottle is opened by itself.
* A whole bottle is always a sealed one.
* Stock shows *5 full · 1 open (570 ml) · 4,320 ml in all*.
* Every change is a whole-number stock movement, so the server's stock is exact with no rounding.

**Never more than is there:** with 20 ml left, a 30 ml shot is refused. All servings of that bottle already in the cart are counted.

**Each sale line records the serving:** kind, label, size, and consumed ml (`serving: { kind, label, ml, consumedMl }`).

**Cost** is the bottle's cost × ml / bottle size. For example, a 30 ml shot of a KES 3,000 bottle costs KES 120.

## Kegs (hospitality only)
**Keg product:**
* Capacity: 20, 30, 40, 50, 60 L, or custom.
* A low-level alert, e.g. 5 L.
* Servings: 250, 300, 330, 400, 500, 568, 600 ml, 1 L, or custom, each with a price.
* The theoretical servings per keg are worked out for you.

**Kegs in the store** are received in 📥 Restock.

**Each keg taken into use** is its own record:
* number / tag, product, capacity, when it was opened, what is left, status and tap;
* statuses: Full, Active, Low, Empty, Disconnected, Closed, Spoiled.

**Serving from kegs:**
* A sale takes its ml from the **oldest active keg**. When that keg runs dry, the rest comes from the next one.
* A full keg already taken from the store is **connected by itself**. This can be switched off.
* Example: 2 L left in #001 and #002 full → 500 ml comes from #001; a 1 L serving with 500 ml left is split.

**Out of stock:** no keg left means staff can't sell it, and it's shown as OUT OF STOCK.

**Keg actions:**
* **Replace** (not "edit 5 L back to 50 L"): the old keg is closed at what is left. That remainder is written off with a reason and
  the history is kept. The next keg goes on the same tap.
* **Wastage:** spillage, foam, spoilage, damaged keg, tap leakage, other. The amount and a reason are required.
* **Measure** records what is physically in a keg.
* **Close**, **Spoiled** and **Disconnect**.

**Low-keg alert:** a red banner on 🍺 Bar & Kegs, a badge on its tab, and a message on the till that served the drink that crossed
the line.

**Reconciliation, per keg:** opening, sold, wastage, expected (= opening − sold − wastage), physical, **variance**, and revenue.

## Works everywhere drinks already work
* Tables, bar orders, waiter orders, open tabs, room service, charge to a room (folio), split bills, and the
  order → bill → cashier → payment → receipt flow. There is no separate payment system.
* Reducing or removing a keg serving gives back exactly that serving's ml, to the keg it came from.
* **QR ordering:** keg and shot servings are on the published menu only when there is stock. An accepted order serves from the keg.
  An order is refused if the liquid isn't there.

## Two tills, offline, and syncing exactly once
* **Shots** use the existing stock ledger (idempotent movements).
* **Kegs** keep what each device served as its own counter (`usedBy[device] = { ml, at }`). Wastage, measurements and status changes
  are events joined by id.
* The server merges this key by key (`NESTED_MERGE.kegs`) in both the single-record store and the shop database, and each till merges
  the same way when it pulls.
* **Results:**
  * two bartenders on two tills always add up (50 L − 500 ml − 500 ml = 49 L);
  * a re-sent push changes nothing;
  * a till's unsent servings survive a pull.
* Offline sales keep working as before, with receipts. They are synced when the device is back online.

## Permissions (`bar.manage`)
* **Bartenders** sell and see the kegs.
* **Managers, supervisors, storekeepers and the Admin** can:
  * set up drinks and change sizes or prices;
  * take, connect, replace, close or spoil kegs;
  * record wastage and measure.
* The new presets: Bartender gets the tab; Supervisor and Storekeeper get `bar.manage`.
* **Honest limit:** staff created before roles existed keep today's behaviour and can do everything. Give them a role to restrict them.

## Audit
📜 **Bar audit** lists every keg event (added, connected, low, wastage, measure, status changes, replacement) and every setup change
(serving sizes, prices, bottle / keg size, default shot, auto-connect). Each entry has who, when, device, previous → new, and reason.

## Reports (📈 Hospitality Reports)
* **Beverage sales:** product, serving, quantity, volume, revenue.
* **Shots:** product, bottle, serving size, sold, liquid (and in bottles), revenue.
* **Kegs:** the reconciliation.

## Receipts
Receipts show the serving ("Johnnie Walker Black — Shot 30ml × 2", "Tusker Lager Keg — 500ml"). They never show keg numbers or
litres left. Tested at 80 mm and 58 mm.

## Stock take
* A bottle sold by the shot is counted as **full bottles + ml in the open bottle**. An open bottle is never counted as a full one.
* A keg product is counted as the sealed kegs in the store.
* Kegs on tap are measured in 📏 Keg stock take.

## Also fixed
**Timed facilities (pool tables…) were over-billed.** They were charged by the started quarter hour down to the millisecond, so a
game ending a moment after 60:00 paid an extra quarter. A new unit now starts after 30 seconds of it.

**Three or four tills saving in the same second** on a shop not yet on its own database could get "busy, retry" when the server was
under load: storage takes about one write a second, and the server gave up after 4 tries. It now tries 6 times. Nothing was ever lost
before (the till kept the sale and retried), but the retry is no longer needed.

## Tests
* **New test file `bar-kegs`, 9 tests:**
  * the prompt's §41 cases: 720 / 570 ml; 2 doubles → 630 ml; keg 49.5 L → 44.5 L; multiple kegs;
  * Table 12 with beer, Coke and shots, then to Room 204 and settled;
  * QR ordering;
  * permissions;
  * offline plus two tills through the real sync endpoint, including a double push;
  * two tills in a shop database;
  * Retail has no keg.
* **Updated:** `bar-pours`.
* **Added to `facilities`:** a billing-grace test.
* **Real Chromium at phone width:** the bartender buttons (a real tap adds the serving), the Bar & Kegs tab and the reports. No errors
  and no sideways scrolling.
* **Full suite** in Kenya time.

## Deploy
`npm run deploy:router` is **needed**: the shop database must merge kegs. Then `npm run deploy`.
