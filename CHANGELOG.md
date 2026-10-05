# Changelog

Per-zip detail lives in `docs/history/CHANGES_ZIP_*.md`.

## Zip 214 - Confirm button always reachable
- On shorter screens (1366x768 laptops, browser zoom, small windows) the checkout card was a fixed-height box that clipped the payment methods and the Confirm button, and nothing could scroll to them. The card now frees space (cart list, payment details) and, if it still does not fit, grows so the page scrolls down to Confirm. Fixed once in the shared block, so every app gets it.
- Test: `tests/zip214-confirm-reachable.browser.test.mjs`.

## Zip 213 — Windows app opens faster

- The print helper (PowerShell) used to start 2.5 s after launch and compile its C# class (several seconds of CPU on a mid-range PC) while the shop page was still loading. It now starts only after the page has loaded + 12 s, at below-normal priority, and the compiled class is cached in a small DLL so later starts just load it (no compile). A print before it is ready still works.
- Rebuild the Windows apps to get this (web code unchanged).

## Zip 212 — No blank strip above the receipt from the logo

- A logo with empty / white margins, or an all-white one, printed as a tall blank strip above the shop name on thermal receipts. Blank rows are now trimmed and a logo with nothing to print is left out.

## Zip 210 — Pesapal and Co-operative Bank payments

- **Pesapal (Option E)**: Consumer Key + Secret in Settings > Payment Gateway (sandbox / production). Hosted checkout for M-Pesa, Airtel Money, card and bank: the till shows a payment link (Open / Copy / WhatsApp) and confirms by itself. The IPN address is registered with Pesapal automatically; a notification is never believed on its own — Pesapal is asked for the real status, and an under-payment is refused.
- **Co-operative Bank (Option F)**: M-Pesa STK prompt through Co-op's gateway. The token address, STK address and Paybill/Till come from the shop's own Co-op API portal (not published publicly, so never guessed); nothing is sent until saved. Result returns to the existing callback.
- Confirmed Pesapal payments are indexed by confirmation code, so the till's receipt check works from any device and one payment cannot pay two sales.
- "Force a specific provider" now lists both. New route `/api/pesapal-ipn`, page `pesapal-done.html`.

## Zip 209 — Hotel category buttons, remove image, measure by price, balance sheet

- **Hotel flow**: category buttons (plain when no picture, picture tile when one is set) → sub-categories as plain buttons → items with their own pictures → sale → payment. Setting "plain category buttons" (default on in Hotel only).
- **Remove an item's picture**: choose Change or Remove picture (Inventory rows and the add/edit form).
- **Measure by price**: on cart lines in kg / g / l / ml / m etc., the price menu (Retail, Wholesale, Custom) gets "Measure by price"; type KES 100 and the quantity is worked out to 3 decimals. Stock, totals, receipt and reports use that same quantity × price, so everything balances; the exact resulting total is shown first, with nearest-below / above choices.
- **Balance Sheet report** (Reports > Balance Sheet, as at today): assets (counted cash, stock at cost, bills, debts, trade credit owed to you) = liabilities (trade credit you owe) + owner's equity. Print and CSV.

## Zip 208 — Option to hide "Sell Unlisted Item"

- Settings ▸ General: new switch "Hide the Sell Unlisted Item button" (Shop, Hotel, Pharmacy, Production, Services). Per device, off by default, remembered after restart. Only the button is hidden.

## Zip 207 — Speed: instant button feedback, faster Windows printing

- **Windows printing no longer starts PowerShell for every receipt:** one background PowerShell (started when the app opens) serves all prints, so a print is ~tens of milliseconds instead of 2-4 s plus a fixed 1.5 s wait. The job is checked only until it leaves the queue. If the worker dies it falls back to the slower one-shot way.
- **Every button answers at once:** pressed look on touch-down; an action still working after 0.2 s (server request, receipt printing) shows a small spinner and ignores a second tap on that button. Background sync chatter never triggers it.
- Windows print window waits 100 ms (was 250 ms) before printing.
- Measured in a browser with 800 products and 1,600 sales: tab switches 20-90 ms, add-to-cart 19 ms, checkout 143 ms; the remaining waits are the network and the printer.

## Zip 206 — Printing rebuilt for the Windows .exe (raw ESC/POS), Order Ticket settings, staff "owner only" error

- **Root cause (from the code):** the installed .exe had no raw ESC/POS path for a USB / Windows-installed thermal printer. Every such print went page → Chromium → Windows driver, and the driver (not the app) decides the page length and the cutter — hence blank or very long paper and no cut, while Chrome/web (which sends its own ESC/POS) worked. There were also no time-outs and no honest stage-by-stage result.
- **New:** `native/windows/printraw.js` sends the receipt bytes straight to the Windows spooler with the RAW datatype (one job at a time, a time-out for each, the Windows error translated into plain words). `Settings ▸ Install App ▸ Choose a Windows printer` now asks "Thermal receipt printer (recommended)" or "Normal Windows printer (A4)". Printer health panel, 5-step diagnostic ladder (Windows OK? → text → feed → cut → sample receipt), in-page print log and the saved `print.log`.
- **Safe by design:** a failed print never touches the sale, never marks the receipt printed, never freezes the till (the print queue gives up on a job after 90 s); reprint asks and never creates a second sale. Web version unchanged.
- **Fixed:** drawer kick, cut test, kitchen ticket, print-relay and printer-status paths only recognised a browser Bluetooth printer; they now also use the app's printer.
- **Order Ticket (Hotel):** its own settings, independent of the receipt — space above, line spacing, space between items, paper pushed out after the last line, cut mode (partial / full / none), printable-width note, live preview, and "Print test order ticket" (dummy order through the real pipeline, using unsaved settings). The ticket is only as long as its lines plus the chosen feed.
- **Staff "owner only" red error** on the Owner Console is gone (friendly note instead).
- **Not testable here:** a physical Xprinter/Epson and the installed .exe. The new exe must be built on Windows (`node build.mjs`) and one test print done per till.

## Zip 205 — Audit: mobile, every button, and a line-by-line bug check of the new website code

- **Catalogue safety (server):** a failed or corrupt read can no longer wipe the catalogue (the save is refused with a clear message); two windows or a double tap can no longer overwrite each other (revision check, the page reloads); pictures are only deleted after the catalogue is saved and never while another item uses them; a product that is part of a system cannot be deleted from under it; product/system addresses stay stable when you rename; a category keeps its kind; a product only takes a product category; deleting everything on purpose leaves the shop empty (not back on the starter list); hidden products never leak through a system; bad requests get clean errors; catalogue size is guarded.
- **Owner Catalogue tab:** Save can't be double-tapped into duplicates; unsaved work is protected (asks before discarding) and stray pictures are cleaned; uploads can't race with Cancel/Save; reorder works inside a filtered list; categories are added with a proper inline form (no pop-up prompts); better phone layout and bigger tap targets; clear Retry if the catalogue fails to load.
- **Website:** a mangled address no longer leaves a blank page; "You may also need" no longer shows unrelated items; home "Featured" top-up fixed; Products menu behaves for mouse, touch and keyboard (arrow keys, Escape); phone menu closes on Escape / outside tap and doesn't scroll the page behind; offers that expire while a page is open stop showing; search typed just before tapping a card no longer redraws the next page; filter panel on phones opens as an overlay and the filters stay reachable; larger tap targets (chips, footer links, checkbox); stale structured-data cleared between pages; unknown product addresses are marked noindex.
- Tests: new safety/rules/pictures tests (API), phone sweep + drawer/filter touch test (storefront), double-save/stale-window/inline-category tests (owner).

## Zip 204 — Premium website: real product catalogue, offers, complete systems

Public website only; the POS apps are unchanged.

- **Owner Console → 🛍️ Catalogue**: add, edit, hide/publish, feature, reorder and delete products and complete systems; unlimited categories and system types; up to 12 pictures per item; specs, SKU, stock status, previous price, related products. Nothing on the site is hard-coded any more (the old list only shows until you set the catalogue up; "Load starter items" imports it).
- **Special offers**: offer price + start/end dates; discount amount and % are worked out by the server (server clock decides if an offer is live).
- **Complete systems**: built from your existing products; shows Individual value, System price and YOU SAVE automatically.
- **/shop** is now a storefront: special offers, complete systems, category/offers/systems views, search, price range, availability, sort, smooth no-reload transitions, product and system pages (`/shop/p/<item>`, `/shop/s/<system>`), "You may also need", quote basket to WhatsApp.
- **Home page**: Featured products, Complete systems and Special offers sections fed by the catalogue (hidden while empty); Products ▾ menu in the header; count-up numbers; calm motion that switches off under reduced-motion.
- API: `functions/api/catalog.js`. Tests: zip204-catalog-api, zip204-storefront, zip204-owner-catalogue.

## Zip 203
- **Premium public website (mydukapos.store only; the POS apps are untouched).** New navy / blue look with big type for the home page; a staged hero entrance (background, headline, text, buttons, devices, each 300–800ms), softly floating device illustrations with slow parallax and a gentle pointer tilt, a moving aurora background, a nav that tightens on scroll, a thin scroll-progress line, staggered scroll reveals, buttons with a light sweep, cards that lift. Everything stops under "reduce motion", and nothing waits on the animation.
- **New Hardware page `/shop`:** catalogue of POS terminals, printers, scanners, computers, monitors, networking, accessories and complete systems, with category chips, search, and an "Add to quote" basket that builds one WhatsApp message. The list lives in `public-site/shop-catalog.json` (prices are `null` = "Get a quote" until you fill them in; add a photo per item with the `img` field). Illustrations are drawn in code until real photos are added.
- Home page: "Hardware" link, "Shop hardware" button and a hardware section. All public pages get the Hardware link (the generator `tools/build-public-pages.mjs` was updated), `/shop` is in the sitemap and served on the apex only.
- Tests: `tests/zip203-premium-site.test.mjs` (routing, catalogue, motion rules, no POS app loads the website layer, entrance finishes visible, reduced motion, shop filter / search / quote, phone width).
- Test hygiene: two timing-sensitive start-up tests (legacy bill repair, workspace card) now wait longer so a slower machine does not fail them; the drawer width uses the display-scale compensation.

## Zip 202
- **New left sidebar navigation (all 7 apps)** replaces the long horizontal tab bar: logo and business name on top, icon + label entries, modules grouped into folders (Sales, Inventory/Stock, Finances, Reports, Customers, Staff, Business, System) that expand with a chevron and animate; Sales Counter and Dashboard stay on top level. Collapsible to an icon rail (hamburger) with tooltips and a fly-out for each group; remembered per device. On phones and small tablets it is a slide-out drawer (no sideways tab scrolling).
- **Permissions untouched:** the sidebar is built from the tabs the app already shows each person. A group is only a folder and never grants anything; a group with no permitted tab is not shown at all; there are no greyed-out entries. Access checks (`guardedSwitchTab`, management-password lock, server rules) are unchanged.
- Header: live clock (time + weekday, date), hamburger, theme toggle, branch switcher and notifications kept. Profile card at the bottom of the sidebar with a clearly visible **Clock Out** (uses the existing attendance logic) and the branch switcher.
- Light and dark themes both designed. If the sidebar ever fails to build, the old bar is restored automatically.
- Note: the per-phone "hide tabs" option no longer changes anything while the sidebar is in use. Category tiles show fewer columns on small laptops because the sidebar takes 248px (collapse it to get the room back).
- Tests: `tests/zip202-sidebar.browser.test.mjs` (owner, Sales Counter + Stock Take, single finance tab, no tabs, enforcement, collapse and reload, phone drawer, themes, clock, Clock Out, fallback, all 7 apps); three older tests now exercise the fallback bar or a wider screen.

## Zip 201
- **Stock scenarios tested end to end** (refresh after a sale / restock, offline then online, two devices at once, repeated syncs, manual edits): stock never reverts to old values and never adds itself. 7 new scenarios in `tests/zip201-stock-scenarios.test.mjs`.
- Deleted **expenses, trade credits and saved barcodes** now stay deleted on every device (tombstones sent, and other tills drop them on their next sync).
- **Expired pharmacy batches** are sold last (only when nothing in date is left), never first.
- **Variants of kg / litre items** keep decimal stock (it was cut to whole numbers).
- **Customers:** 0712..., +254712... and 254712... are one customer (no duplicate by phone format).
- Hotel "My Sales": a staff member now sees everyone's totals (it showed only the first server's).
- Hospital guide lists its Dashboard tab; CSS viewport units are zoom-compensated in the branch switcher, category tiles, phone till and stock report.
- Tests brought up to date: phone till (Collect step), sales-for-everyone, owner wording, pairing-free QR ordering, R2 binding, legacy bill repair timing.
- Still deferred (needs a design decision): two devices restocking the same pharmacy item with different expiries (quantity stays correct; the second expiry lands on a "Stock adjustment" batch); duplicate customers created offline on two devices with different spellings of the number are not merged automatically.

## Zip 200
- **Phone payment in three short screens (phones only):** Collect > only the payment methods the shop switched on, as big buttons > just the boxes that method needs (cash tendered is optional in Hotel) > Confirm. Computers and tablets are unchanged. A shop with one method skips the method screen; pay-on-delivery skips both.
- Audit fixes: variant restock now updates cost and price; restocking a parent that has variants no longer logs a phantom expense; Pharmacy void/return puts units back into a batch; a bill instalment cannot be voided as a plain sale; a held delivery sale resumes as delivery; delivery fee is included in X/Z and Reports totals; adding an item with a code that already belongs to another item now asks before replacing it.
- Not fixed (deferred, risky): concurrent Pharmacy restock batch-expiry merge, deleted expenses/trade credits coming back, duplicate customers created offline, variant kg decimals truncated, expired batch sold first.

## Zip 199
- **Global branch switcher** (owner only, every app): a "🏪 Branch ▾" pill in the header lists the branch group. Choosing another branch confirms it by name, saves what the device still has to send, then opens that branch on the same screen (same tab). "All branches" is the existing read-only combined view; "Back to this branch" returns. Staff and single-shop owners never see it. Each branch stays its own shop (own address, stock, sales, staff), so a restock, stock take or sale cannot land in another branch. New block `src/shared/blocks/branch-switcher.html`; tests `tests/zip199-branch-switcher.test.mjs`.

## Zip 198
- Complete package: both `wrangler.toml` files carry the R2 (AUDIT_ARCHIVE, DB_BACKUPS) and owner/audit D1 bindings.
- Stock sync while a device is "stuck": the server's already-processed movements are stamped so they are never counted twice (found by the multi-device stress test, now passing).
- New tests `tests/zip195-sync.test.mjs`; updated the old pairing-era connectivity and sales-journal tests.

## Zip 196
- **Deploy fix**: `npm run deploy:fast` / `deploy` now publish from a clean temporary copy (`tools/deploy-pages.mjs`) that leaves out `native/windows/dist` (installers), `node_modules`, `.git`, zips and any file over 24 MiB. Fixes "Pages only supports files up to 25 MiB" after building the exe.
- wrangler updated to v4 (root and wildcard-router package.json).

## Zip 195
- **Exe build fix**: `WebAssembly.Memory(): could not allocate memory` (electron-builder's icon converter). Ready-made `.ico` files now ship in `native/windows/build/` and `build.mjs` uses them, so the failing step is skipped.
- **Stock reaches every device** even while a device is "stuck" (`stockMergeWhileStuck`), plus a "no stock" recheck.
- **Restock of a variant code** restocks that variant (no duplicate item); a parent code of a variant item is refused with a clear message.
- **Sales are universal**: every device and staff member sees the same Sales totals (hotel bills too).
- No more "server not answering" wording for users.

## Zip 194
- **Exe receipts came out as blank pieces of paper.** Reproduced with the real Electron print call and a virtual printer: the installed exe's silent print IGNORES the receipt's paper size (`@page`) and prints on the printer's default page, so a receipt came out on the wrong page size / chopped into pieces. Fixed in two layers:
  - Rebuilt exe (`native/windows/main.js`): the paper size is passed to Windows (`pageSize`), and the receipt is printed from a clean snapshot window (`native:printHtml`). Verified in Electron to a virtual printer: exactly one 80 x 118 mm page with the whole receipt.
  - Web side (works with the exe already installed): an exe without `printHtml` (the old one) now defaults to the Windows print window, which does honour the receipt's paper size, instead of the silent print that ignored it.
- Zip 193 (black-on-white receipts in dark theme) and zip 192 (Order Ticket Size) are included.

## Zip 193
- **ROOT CAUSE of the exe's empty receipt found and fixed.** In the DARK theme the receipt paper's background was the dark screen colour while its letters are forced black. A browser's print dialog leaves backgrounds out (so the web print looked fine); the Windows app prints backgrounds, so the paper came out dark with black letters - an empty-looking receipt. New shared block `print-white`: receipt and order ticket always print black on white, in every app and theme. This is web-side, so it works with the INSTALLED exe, no rebuild needed. Test: tests/zip192-print.browser.test.mjs (dark theme, Shop + Hotel).
- Zip 192's print-snapshot and Order Ticket Size are included.

## Zip 192
- **Windows exe printed an EMPTY receipt (web was fine).** The exe now prints a *snapshot* of the receipt / order ticket from its own hidden window (`native:printHtml`), with the paper size passed to Windows, instead of printing the live page; the live-page method also waits for the layout to settle and sends the paper size. Settings ▸ Install App ▸ printers has "Print method 1 / 2 / 3" (3 = the Windows print window). Needs the exe rebuilt (`native/windows/main.js`, `preload.js`); the web side works with the old exe too (it falls back to method 2).
- **Hotel: Settings ▸ Receipt Settings ▸ Order Ticket Size** - paper (same as receipt / 58 / 80 / custom), letter size, automatic shrink so no line wraps, live sample, test print, saved on the till.
- Test: `tests/zip192-print.browser.test.mjs`.

## Zip 191 — hide the Table / Room picker in the Hotel till
- Settings ▸ Phone & till layout ▸ "Show Table / Room picker" now works even while Tab payments are on: the picker is hidden, the 🧾 Tabs button stays, and a Tab order goes to a guest name or the auto-numbered "Guest 1".

## Zip 190 — phone till: less scrolling, bigger products, full-screen cart
- **Phone layout** (screens under 700 px only): every cart line fits (name, qty, price, total, remove); the cart button and a bottom bar open a full-screen cart where you confirm and finish the sale; bigger 2-column product tiles; one scrolling row of category chips; search as a bar or a 🔍 icon (Settings ▸ Phone & till layout, per device).
- **Hide switches** (Settings ▸ Phone & till layout): customer phone box, Walk-In/Delivery choice (hiding Delivery forces Walk-In and removes the toggle), Table/Room + Tabs row (shop-wide, synced); which tabs show on this phone (per device).
- **Category images** (Settings ▸ Category Images, off by default): add a picture per category; the Sales Counter then shows category tiles that open the sub-categories or items.
- **Edit stock report**: admin-only button on the Stock Report tab, management password required; edit opening/added/removed/sold/closing for the period with a mandatory reason. Corrections change only what the report shows (never stock or sales), are marked "corrected", audited, and can be restored. CSV export added.
- New shared blocks: `phone-till`, `category-tiles`, `stock-report-edit`. Migration 0008 (drop CRM) now defers foreign keys (it failed on real data in zip 188).

## Zip 188 — dashboards for every app, monthly audit archive, owner database
- **Dashboards**: the zip 186 "command center" dashboard now also runs in Pharmacy, Production and Services (one shared engine, `tools/inject-dashboard.mjs`), and
  Water and Hotel have their own adapters (litres/tanks/sites; departments/tabs/waiters). Hospital gets a new Dashboard tab (counts and money only, never patient
  names or clinical details; hidden from roles that cannot see reports). The old cards keep their ids (branch compare, print report).
- **Monthly audit archive + prune**: with an R2 bucket bound as `AUDIT_ARCHIVE` on the router, once a month audit rows older than 90 days are written to R2 as gzip
  NDJSON, verified, and only then deleted; any failure deletes nothing. Without the bucket the router just trims. Owner tool: `tools\audit-monthly.cmd` (dry run) / `run`.
- **Owner database** (`mydukapos-owner`, binding `OWNER_DB`): a read model of the licence list and group income for the owner console. KV stays the truth; licence
  checks and login never read it; any problem falls back to KV. No secrets are mirrored. `node tools\setup-owner-db.mjs`, status/rebuild route `/api/owner-db`.
- Tests: the old M-Pesa test now seeds the pending prompt the zip 185 hardening requires; zip166 waits longer for the heavier page.

## Zip 187 — the audit trail moves to its own database
- New D1 `mydukapos-audit` (binding `LEDGER_AUDIT_DB`): audit rows are written there, so a flood of them can never again fill the database that holds the sales.
  The server writes them itself right after the sales batch committed (a D1 trigger cannot write into another database), only for records that really
  changed; a failure or a full audit database only pauses the audit for 5 minutes and never fails, rolls back or delays a sale.
- With the binding present the two audit triggers in the sales database are removed (automatically on the first push, or by `migrations/0009`). Without the
  binding nothing changes. The existing `ledger_audit` rows stay in the sales database as history.
- Retention: the router's 6-hourly cron deletes audit rows older than `AUDIT_RETAIN_DAYS` (default 90), a bounded amount per run.
- `node tools\setup-audit-db.mjs`: one command that creates the database, adds the binding to both wrangler.toml files and creates the table.
- `/api/ledger-health` and the watchdog report the audit database's size separately (a warning only), and the sales database's size as before.
- Tests: `tests/zip187-audit-db.test.mjs` (13).

## Zip 186 — D1 incident fixes, CRM removed
- Late fixes found by the full regression run: two overlapping device pairings could each make a token and the server kept the other's (the device then looked
  unpaired and asked to pair again) - pairing is now one at a time; Services logs a variant's stock edit under the variant's own code like the other apps; the
  new text-box and dashboard styles are grouped in a `screen` media block so the automated-test browser (jsdom) starts as fast as before (a real browser applies
  them identically).
- D1 full-database incident (`mydukapos-ledger` hit the 10 GB cap; every write failed with SQLITE 7500):
  - the server audit write is idempotent: a resend of the same record and version no longer adds a `ledger_audit` row;
  - the client sync retry storm is fixed: backoff, a single leader sender per device, and a cap on retries;
  - a "storage full" (507) answer now pauses sync instead of being retried every few hundred milliseconds;
  - prune and backup tools for the database (`npm run db:backup`, `npm run db:migrate`).
- CRM module removed: the `/crm/` app, `/api/crm*` routes, the CRM Meta/WhatsApp ingest, the Owner Console CRM link, CRM tests and docs. Website
  sign-up and demo requests, WhatsApp webhook (KV inbox) and contact forms keep working without it. `migrations/0008_drop_crm.sql` drops the `crm_*`
  tables: apply it ONLY after a backup. `0002_crm.sql` and `0004_crm_speed.sql` stay as applied history.
- One clean deployable site: stray zip removed, change notes moved to `docs/history/`, `docs/`, `migrations/`, `backup/`, `sql/` and any
  `.sql`/`.zip`/`.bak`/`.cmd` file are never served publicly; README rewritten.
- Form controls restyled (16px / 17px text, one design in every app and the public pages).
- Daily Sales: sort by time (newest first by default, or oldest first) and by amount (highest or lowest first); the date shows when a range spans days.
- Sales never lost / shared across devices: a sale marked unpaid stays a sale after reload; a bad record from another device no longer hides the day's sales;
  the owner receives employees' sales even when his own push is refused; changes are written again on page close.
- Connectivity: any successful API answer flips the status to online by itself; "Retry now" works; a full server (507) is shown as such, not as offline.
- Restock / stock take: changes survive an immediate refresh, online or offline, and are never overwritten by an older server copy.
- Dashboard (Shop): new command center with date ranges, KPIs with comparison, sales/profit trend, top sellers, categories, inventory health, slow movers,
  stock movement, staff performance, payment mix, busiest hours/days, customers, credit, expenses, returns, insights, alerts, activity, quick actions; sections
  can be hidden or reordered; CSV export. The previous snapshot cards stay in a collapsed "Quick snapshot" (branch compare and the printed report use them).

## Zip 185
Money-rounding hardening in every app, owner API hardening, device columns, receipt time, public site pages, M-Pesa ledger merge fixes (see the
tests named `zip185-*`).

## Zip 184
Non-JSON push replies handled by the client (`tests/zip184-push-nonjson.test.mjs`).
