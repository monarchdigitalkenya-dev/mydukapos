# Changelog

Per-zip detail lives in `docs/history/CHANGES_ZIP_*.md`.

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
