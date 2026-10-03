# Zip 125 — Sales no longer lost between tabs, Devices & Security in its own section, Settings made for phones

Builds on zips 118–124.

## 1. "Some of today's sales are there, a few aren't" (same device)
* **The cause.** The app open in **more than one tab or window** on the same device (e.g. a browser tab and the installed app, or
  a tab left open from earlier). Every tab keeps its own copy of the sales list and saves the **whole** list. A tab opened
  earlier saved its older list over a sale just made in the other tab. If that sale had not reached the server yet (offline, or
  the server busy), it was gone, even though its receipt had printed.
* **Reproduced** in a real browser on zip 124: 2 sales rung up in two tabs, only 1 left after reopening.
* **The fix: one working tab per app** (new shared block `one-tab`).
  * The tab opened last is the working one. Any other tab stops at once: it can no longer save or sync, and it shows
    **"Open in another tab — Use it here"**.
  * Tapping **Use it here** reloads that tab with everything saved, and the other tab stops instead.
  * The customer display screen is left alone.
* **Also covered earlier:** zip 124 fixed Daily Sales hiding sales behind an old date or filter, and zip 123 fixed the busy
  server during multi-device syncing.

## 2. Devices & Security has its own Settings section
A **🔐 Devices & Security** button next to "Security & Access" opens its own section. Before, the panel was stuck under
whichever other section happened to be open.

## 3. "Till —, App release —, Last sync —" in the device list: the shop database server was out of date
The code records all of these correctly (verified). A shop in its own database shows "—" when **the router Worker was not
redeployed**: its database then runs code from before zip 120, with **no device list, no till numbers and no stock ledger**.

This is now said plainly:
* **To the shop:** a red note in Devices & Security.
* **To you:** the Owner Console ▸ 🩺 Health lists "database server OUT OF DATE — run `npm run deploy:router`" for that shop.

**Action:** run `npm run deploy:router` when deploying. It is required for shops in their own database.

## 4. Settings (and every tab) made for phones
Each screen was checked in a real phone browser at 320, 360 and 390 px (all 7 apps, every tab and every Settings section).
* **No page zoom-out.** One row wider than the screen made the phone zoom the whole page out: header covering part of the
  screen, everything tiny. Now no screen is wider than the phone.
  * **Rows found and fixed:** Delivery Zones, the Payment Gateway transaction type, Attendance Roster, Hospital ▸ Theatre and
    Cashier Shift, and Services ▸ Services Counter.
  * **Rows now wrap,** fields never exceed the screen, and anything still wide scrolls inside its own section.
* **Compact section buttons.** Settings' 24 section buttons are a two-column grid on phones (they used to fill a whole screen).
  Tapping one scrolls to its section.
* **Consistent fields.** Every field in Settings has the same look (number and date boxes kept the browser's dark border).
* **The tab bar keeps Sales Counter visible** next to the open tab on narrow phones. The More ▾ button no longer sticks out
  past the edge.

## Tests added
* `tests/one-tab.browser.test.mjs` (real Chromium):
  * the older tab can't save over a sale;
  * "Use it here" switches over and both sales are kept;
  * the customer display is never stopped.
* `tests/shop-db-outdated.test.mjs`: the device list and the Owner Console health check both flag an out-of-date shop database.
