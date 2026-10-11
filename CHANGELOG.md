# Changelog

Per-zip detail lives in `docs/history/CHANGES_ZIP_*.md`.

## Zip 257 - Test BEFORE saving Daraja details
- **"🔎 Test these details (before saving)"** now sits beside Save Daraja Credentials and tests exactly what is typed in the boxes (Environment, keys, Shortcode, Passkey, Type, Till number) without saving anything; an empty box falls back to what is saved. After saving, "🔎 Test the saved connection" is shown in the configured panel (the old button vanished once the keys were saved).
- Typed values are checked (digits only for numbers, no spaces in keys) and never echoed back. Same guards as saving: licence, device, Admin/manager, hourly limit.

## Zip 256 - Daraja test explains Safaricom's failure reasons and shows what is sent
- **Test Daraja connection** now also shows (a) what is sent to Safaricom: Type, BusinessShortCode and the receiver (PartyB), (b) which saved changes are still held for 60 minutes (field names only), and (c) the last Safaricom failure texts from this shop's prompts ("Merchant does not exist", "Agent number and Store number do not match", "unresolved reason type") with what each means for the settings.
- Same button in every app that has Option B (shop, hotel, pharmacy, production, services, hospital, water). Tests added to `tests/zip255-daraja-check.test.mjs`. No router change, no migration.

## Zip 255 - Daraja: "Test Daraja connection" + callback address override
- **New button under "Save Daraja Credentials":** checks, one by one, the saved details (and any held change), that environment / shortcode / Till fit together, the Safaricom login, the shortcode + passkey (a harmless status question about an invented prompt; no money, no prompt), the result address Safaricom is given, and recent prompts that never got a result. Each step shows Safaricom's own words and what to do. Admin / manager only; 30 tests an hour per shop. Keys are never echoed.
- **`PAY_CALLBACK_ORIGIN`** (optional Cloudflare variable, e.g. `https://yourbusiness.co.ke`): the address Safaricom is told to send results to. Default unchanged (the host the request came in on, i.e. `mydukapos.pages.dev`).
- Tests: `tests/zip255-daraja-check.test.mjs`; the stale Co-op address check in `zip210-gateways` now expects `pay-cb-stk`. No router change, no migration.

## Zip 254 - Import a medicine list (Doses, Minimum Qty, variants, packs)
- **Import from Excel/CSV** now reads a list shaped like `Drugs | Doses | Minimum Qty | Cost` in Hospital, Shop, Production, Services and Pharmacy. Hospital also gets the variants-from-a-list import the other four already had.
- **Doses column:** "4 Tabs" / "9 Tabs" / "3pcs" = a box that holds that many pieces (cost = box price, cost per piece = box / pieces, also sold by the piece, piece price 0); "200mg/400mg" or "200/400mg" = one variant each; anything else (500ml, 5mg, 15g) stays one piece and is added to the name.
- **Minimum Qty** (also Min Qty, Low Stock...) becomes the item's own low-stock level. Qty and Price stay 0 when the file says 0.
- Also accepted as columns: Variant (a cell with "/" splits), Pieces Per Box / Pack Size, Drug / Drugs / Medicine as the name. Costs written "500 /-", "100/-" or "@150" read as numbers. Stray double spaces in names are tidied.
- Not changed: Hotel and Aqua POS imports. Re-importing a file with Qty 0 sets those items' stock back to 0 (the old behaviour).
- Tests: `tests/zip254-medicine-list-import.test.mjs`. Ready-made file: `ALLIVIA_HC_DRUGS_IMPORT.xlsx` (not part of the app).

## Zip 253 - Receipt Settings (barcode, VAT, inline PAID/UNPAID) + pack-price cost + compact image row
- **Receipt Settings (all 7 receipt apps):** new card "What prints on the receipt" with Reference number (on), Barcode (**off by default**), VAT / tax (**off by default**: no VAT letters, no VAT table) and PAID / UNPAID. The same settings drive the on-screen preview, system print, USB and Bluetooth. They persist and sync to other devices. Hotel's own barcode/ref setting was folded into this shared one.
- **PAID / UNPAID** now prints as wording on the TOTAL line ("TOTAL - PAID   KES 500.00"). The stamp picture and its reserved space are gone.
- **Add item (6 apps) and Aqua POS Add Product:** the optional picture area is a compact row (preview, upload/camera, Remove). New "Bought in a box / pack" card: price paid + pieces = cost per piece, recalculated on every change (KES 1,200 / 24 = KES 50). Cost, stock value and profit use it. Items bought singly are unchanged. With "Also sold individually", the cost field keeps the box cost, units-per-box is set from the pieces, and the piece cost is derived.
- Validation: price 0 or more, pieces a whole number above 0 (fractions only for dual-unit), both or neither.
- Not covered on purpose: Bulk Add rows, CSV import, the Inventory edit window, variants' own costs, the eTIMS block.
- Tests: `tests/zip253-receipt-and-pack-cost.test.mjs`; `raw-ref-barcode` and `print-engine` updated for the new off-by-default settings. No router change, no migration.

## Zip 252 - Cost incident: every remaining D1 write path covered
- **Same cause as zip 251, remaining statements:** a stamp-only re-send also rewrote `ledger_bills` (every open tab, on every push, even with a correct clock because of `version >=`) and `ledger_sale_items`, and the repeat-send memory in `_ledger.js` never matched because the fingerprint included `updatedAt`. Now: `ledger_bills` and sale lines are written only when a column really differs; the fingerprint ignores the top-level `updatedAt`. Measured on the test copy (43 records, 4 re-sends): 30 -> 0 D1 row changes per re-send with a correct clock, 40 -> 10 (0 inside the repeat-send memory window) from a till 10 minutes behind. The remaining 10 are the `ledger_sales` header of unacknowledged sales, deliberately left alone (its `version` guards the sale lines and the duplicate-settlement rule).
- KV path unchanged on purpose: one value written per push (600k KV writes in the bill, inside the included amount); no per-record rows.
- Same switch: `LEDGER_STAMP_GUARD=0` restores all of it. Tests: `tests/zip252-d1-all-paths.test.mjs`.

## Zip 251 - Cost incident: Durable Object + D1 writes from a till with a wrong clock
- **Cause (reproduced on the code; production usage NOT yet confirmed):** a till whose clock is 2+ minutes behind the server has every record's `updatedAt` shifted by `correctClockDrift` on every push. The apps re-send whole lists (inventory, customers, staff, bills, debts, tabs ...) and take the server's copy back on each pull, so each push produced a copy that differed ONLY in `updatedAt`, was newer, and was rewritten - 381 records = 383 Durable Object row changes per push (2 with a correct clock), 70 bills/debts = 140 D1 row changes per push (0 with a correct clock) - and the stored stamp walked ahead by the drift on every push.
- **Fix (server only, no app update):** the shop database (`wildcard-router/shop-store.js`) and the D1 ledger (`functions/api/_ledger.js`) no longer rewrite a record that differs only in its top-level `updatedAt`. Real edits are unchanged. Switches: `SYNC_STAMP_GUARD=0` (router Worker), `LEDGER_STAMP_GUARD=0` (Pages project).
- **Monitoring:** the router logs one line per drifted till per 10 minutes ("device clock is off by ... s"); `/stats` and the Owner Console storage reply carry `guard` (pushes, record rows updated, timestamp-only rewrites skipped, drifted devices, records stamped in the future).
- **Deploy the router FIRST (`npm run deploy:router`), then `npm run deploy`.** No migration. Not changed: stored time stamps already in the future (see `docs/COST_INCIDENT_251.md`).
- Tests: `tests/zip251-clock-drift-writes.test.mjs`. Details: `docs/COST_INCIDENT_251.md`.

## Zip 250 - Daraja production: the callback addresses (STK result + direct Till payments)
- **Root cause:** Safaricom's PRODUCTION system filters out any callback / validation / confirmation address that contains the words **mpesa**, **m-pesa** or **safaricom** (sandbox does not enforce it, which is why everything worked with sandbox keys). Every address this app gave Safaricom had "mpesa" in it (`/api/mpesa-callback`, `/api/mpesa-c2b-confirmation`, `/api/mpesa-c2b-validation`), so on production the prompt could be sent but its result never arrived (the till waited for ever) and **Register Till URLs** was refused or silently never delivered.
- **Fix:** new routes with neutral names - `/api/pay-cb-stk`, `/api/pay-cb-till-confirm`, `/api/pay-cb-till-validate` - are the very same handlers (re-exports; same callback-key signing). The STK prompt, **Register Till URLs** and the address shown in Settings > Payment Gateway now use them. The old `mpesa-*` routes stay in place so a prompt already sent, or a registration made earlier, still completes.
- **Register Till URLs:** a Till (Buy Goods) shop now registers its **Till number** (the number customers pay), not the Store / Head Office number; a Paybill shop its Paybill. The success line names the number registered. Safaricom's own error (+ code) is shown, with what to do for "Duplicate notification info" (production registers a number's URLs once: delete the old ones under URL Management in the Daraja portal, then register again); a non-JSON reply no longer crashes it.
- **Login to Daraja:** a rejected Consumer Key / Secret now says the HTTP status, Safaricom's reason and which environment (sandbox / production) the keys were tried against.
- **STK status check:** a Safaricom reply that is an error object ("being processed", throttled) no longer marks a prompt the customer is still answering as FAILED.
- Tests: `tests/zip250-daraja-callback-urls.test.mjs`; `zip249` test updated to the new address. See `docs/DARAJA_GO_LIVE.md`.

## Zip 221
- **Daraja production keys just work (zip 249):** (1) pasting production keys over keys saved under **sandbox** is no longer held for 60 minutes (sandbox keys move no money) and the environment switch and the keys now take effect together; replacing keys that were already saved as **production** keys is still held (zip 247 protection unchanged); a Till number saved on its own never changes what the saved keys count as; Reset Daraja clears everything. (2) **Till (Buy Goods) shops:** Settings > Payment Gateway > Daraja shows a **Till number** box when the type is Till: the Shortcode box holds the Store / Head Office number (BusinessShortCode + password) and the Till number is sent as PartyB; blank = same number (as before). (3) The STK timestamp is Nairobi time (UTC+3), not the server's UTC clock. (4) Safaricom's own refusal text and error code now reach the till; a non-JSON reply no longer crashes the call. Tests: `tests/zip249-daraja-production.test.mjs`; the two zip 247 hold tests now use live (production) keys. See `docs/DARAJA_GO_LIVE.md`.
- **Zip 248 - Aqua dispatch fixed.** Pressing 🚚 Dispatch while the Shop was on screen took the stock out of the Shop and put it back into the Shop (nothing reached the branch): Dispatch (item, shop request, bell, refill) now moves to Production by itself and a staff login is put back on its own site afterwards. Staff who could use Production keep the Dispatch tab (it used to be part of Production), so the "Dispatch is not available to your login" message no longer appears for them; the owner is never refused.
- **Zip 248 - Aqua login list.** The plain link now lists ALL staff (shop and production, each tagged with its site) plus Admin; only a link ending #shop or #production narrows the list to that site. A staff member signing in on the plain link lands on their own site, and the link is not rewritten.
- **Hotel Sub-categories + dark mode (zip 247):** the Sub-categories window has big full-width text boxes (one per line), and every sub-category has its own **Add item** form (name, price, stock) that creates the item straight into it; typing a name that already exists asks **Update the existing item** (new price / more stock, and put it in this sub-category) or **Add as a new item** (with its own name). Dishes / services saved from Add Item now ask the same question instead of refusing (all apps). Dark mode: pale tinted boxes, tips and dim grey captions that were unreadable are fixed in every app (shared `dark-fix` block: tinted-box rules plus a contrast guard that, in dark mode, switches any text too close to the colour it sits on to a readable one, in all 7 apps and the Owner Console, and undoes itself in light mode).
- **Payment safety (zip 247):** (1) changing the payment gateway or the SMS account keys now needs a typed Admin password or manager PIN, checked on the server every time (header `X-Pay-Proof`; offline selling is untouched; remembered for 90 s in the same sitting); (2) every change alerts the owner by SMS (the shop's own SMS account, sent through the OLD account for an SMS change), WhatsApp (when configured) and email, is logged in Settings, and a replaced key is HELD for 60 minutes (`PAYMENT_CHANGE_COOLDOWN_MIN`) with a "Not me - cancel" button while the old keys keep working; (3) payment and SMS keys are encrypted in KV (AES-GCM) when the `PAYMENT_SECRETS_KEY` Cloudflare secret is set (Owner Console > Storage > Payment safety sweep seals existing shops); (4) every shop gets callback keys, and unsigned payment callbacks are refused from 2026-12-01 (`CALLBACK_LEGACY_CUTOFF`); (5) wildcard CORS removed from sms-config, payment-accounts, mpesa-stkpush and mpesa-status, manager / staff-session checks added, per-phone cap on payment prompts; (6) the "update available" notice no longer appears when nothing was published (the service worker compares the page's content, not its ETag, and ignores other pages). **No repeated passwords on reconnect:** a staff / Admin server session is now renewed silently from the token the device already holds (up to 3 days after it ran out, 14 days since the last typed sign-in; ends at once on a changed password / PIN, a removed or locked person).
- **Payroll: no second typing of staff (zip 245):** the people already in Staff Accounts are put into the payroll register by themselves when Payroll > Overview or Staff opens (for the Admin / anyone allowed to edit staff; at most once a minute). Someone already there (linked, or the same name added by hand) is never added again; salaries are then set per person. The button is now "Re-check my POS staff".
- **Live shop on its own subdomain no longer reads "not found" (zip 245):** the licence lookup now re-reads a miss twice, finds a shop whose subdomain entry is missing from the Licenses index (and writes the entry back), and honours the link's own ?c= on an unclaimed subdomain (never on another shop's). The could-not-confirm screen shows a small support reference.
- **"This link no longer exists" fixed (zip 245):** the message is now said ONLY for a link proven deleted (in Trash, or permanently purged: the purge now leaves a tombstone). An app opened without its shop token (an installed web app, a phone's Add to Home Screen, cleared storage), an unknown code or a lookup that missed for a moment is answered "not_found" / "no_link": it never locks a shop that was working, is re-checked before anything is shown, and then says "Open your shop link" / "We could not confirm this link - nothing has been removed" with a box to paste the link, Try again and WhatsApp. The installed app's manifest now carries the shop token in its start_url, so it opens straight into the shop. A not-found answer is never saved as the device's offline licence checkpoint.
- **Duplicate items, Hotel ordering and Daily Sales pin (zip 244):** adding an item (one or bulk) that already exists now opens a window saying so, with **Update existing** (prices / add stock), **Create variant** (or a separate "Name — Version" item in Hotel/Hospital) or cancel, instead of an error or a duplicate with another code; names repeated inside one bulk batch are skipped. **Hotel:** Settings > Category Images & Order can hide the "All <category>" / "All items" tiles, and categories, sub-categories and items can be ordered manually by number or by most popular / price / A–Z. **Daily Sales** can be pinned always visible (per device) or left to hide as before.
- **Excel/CSV import reads variants (zip 243):** a **Variant** (or Size / Option) column turns rows that share an Item Name into ONE product with a variant per row, each with its own Retail Price and Quantity. Shown in the same review screen as the photo capture. Shop, Pharmacy, Production, Services.
- **Chama (zip 242):** after **Undo** the member's figures now refresh at once (the screen was showing the 20-second saved copy, so a corrected 12,000 still looked like 12,000). **Merry-go-round:** the admin gets **↩ Undo** on every member marked Received (by mistake at set-up or after a payout): they go back to waiting, a recorded payout is cancelled by a matching correction and can be paid again.
- **Capture List reads size grids (zip 241):** a photo of a ruled sheet (product per row, a size per column with its price above, counts in the cells; uniforms, shoes, clothes) is read as ONE product per row with a variant per non-empty size, each with its own price and stock. The review shows the sizes under each product (editable, add or remove a size); Add Items / Inventory import create the product with its variants (re-capturing tops up existing sizes), Restock / Store get one line per size. Shop, Pharmacy, Production and Services.
- **Sidebar accordion (zip 240):** opening one folder closes the other, so only one folder is open at a time (the one holding the tab you are on).
- **Logistics folder in every app (zip 239):** the sidebar's Logistics folder now holds every tab where stock moves: Orders, Restock/Restocking, Deliveries, Returned Goods, Bulk Tank and (Aqua) Dispatch. Nothing about access changes; a folder with no visible tab does not show.
- **Orders (zip 238):** every order has a **⬇ Download** button (saves the order as a PDF with all lines and the total). **WhatsApp** now always opens: with no supplier number it opens WhatsApp to pick the chat, a blocked pop-up falls back to this tab, and a long order (too long for a link) opens a short message while the full list is copied to paste.
- **AquaPOS Stock Report fix (zip 237):** a dispatch's "received" half was counted at Production too, so a day of Opening 9 / Produced 92 / Dispatched 101 showed Opening -92, Added 193. Stock movements now record their site and each site's report only counts its own (older dispatch rows are recognised by their wording). Production shows Opening 9, Added 92, Removed 101, Closing 0.
- **AquaPOS: Dispatch tab + Logistics group (zip 237):** new **🚚 Dispatch** tab sends items and pre-filled refills (bottles or litres) from Production to a shop branch, with factory stock, open shop requests and Dispatch History (moved out of Production; stock logic unchanged). Every tab where stock or water moves (Dispatch, Deliveries, Returned Goods, Restocking, Bulk Tank) is now in one **Logistics** sidebar folder. Dispatch can be assigned to staff like any tab.
- **Chama: reset, undo and a double-recording guard (zip 235):** in **Staff ▸ Members ▸ a member**, the admin now sees that member's recent payments with **↩ Undo this payment** (recorded twice) and **🧹 Reset test payments** for that person; the Members screen has **Clear ALL test payments** (type RESET). Nothing is erased: each payment is cancelled by a matching correction in the append-only ledger, waiting reports are cleared, the member is told and the audit trail records who did it. Loans, payouts and expenses are never touched. Admin only. **Double-recording guard:** a payment for the same member, same thing and same amount within 2 minutes (M-Pesa report, cash report or an official recording it) asks "Is this a second payment?" first; OK records it anyway, so a genuine repeat is never forbidden (a retry of the same request is still harmless). New **More ▸ How to use this app**: a printable training guide for members, officials and the admin (including a 20-minute training session plan). Tests `zip235-chama-reset`, `zip235-chama.browser`.
- **Chama: only the admin can undo an entry (zip 234):** *Reverse* on the ledger is now admin-only ("↩ Undo this entry (admin)"), for a payment recorded twice. The original stays, a matching reversal is added (append-only), the member is told. **Is this M-Pesa real?** The payment inbox now checks each pasted code against Safaricom's own confirmation for the chama's Paybill / Till when one is connected: ✅ Confirmed by Safaricom / ⚠ different amount / ⚠ no record / ℹ not checked (a pasted SMS can be faked). Test `zip234-chama-reverse-verify`.
- **Live counter rounds up to a whole shilling (zip 233):** the Sales Counter in the six POS apps now rounds every cart total up to the next whole shilling (e.g. 100.30 → 101), shown as a visible "Rounding" line so receipts, payments and reports still add up. On by default; switch off in Settings ▸ View ("Round every sale up to a whole shilling"). Also: the user guide now lists the Accounts tab. Test `zip232-round-up`.
- Zip 232 — Record a Past Sale (all POS apps except Water): many items in one go (whole or decimal quantities, own price and optional own time per line), totals rounded UP to a whole shilling with a visible "Rounding" line, and a photo Capture List that reads every line (item, quantity, price, time/date) and matches it to Inventory (code, name, spelling, size, price tie-break; ambiguous or unknown lines must be chosen); lines with the same time form one sale. AI Capture List: mode "pastSales" (server: ai-capture-list.js, _capture-shape.js).
- Zip 232 — Chama: faster (home loads its data in parallel, kept 20 s and cached on the phone), terms and conditions page, automatic late-payment fines (fixed or %, grace days, once per period, never for old periods), logo next to the name (admin upload), PIN-reset buttons.
- Zip 232 — the "A newer version of the app is ready" bar now disappears after 3 seconds instead of staying on screen.
- Chama upgrade (zip 230): "Who is logging in?" name tiles + PIN with Show PIN, temporary PIN → own PIN (typed twice); several roles per member (Admin/Secretary/Treasurer/Chairperson); cash reporting with receiver confirmation and corrected amount + reason; My contributions breakdown (required/paid/remaining, M-Pesa/cash, pending/overdue); merry-go-round status card, countdown, collection table, adjust schedule with audited reason, take over a round already running; "Set up an existing chama" wizard with opening balances (no invented history).
- Admin: "Reset sign-in" and "Sign out all devices" per member; PDF Chama guide in docs/.
- AI Capture List (Gemini): tenant keys are tried first, then platform keys one by one; any key that is out of quota, invalid, forbidden, billing-blocked, unreachable or overloaded now hands over to the next key.
- Water app: materials can be priced "per piece" or "per bag / pack" (with pieces per bag) right beside the cost, on the Add form and in the Materials table; the per-piece cost is worked out and shown, and every sale/recipe cost uses it.
- Water app (AquaPOS): Shop and Production no longer mix materials. An item's materials list (and a produced item's recipe) only counts the materials of the site you are working in, so a Production sale/run takes Production's materials and never the Shop's, and the Materials Used window lists and costs only this site's materials. Dashboard, Profits & Expenses, Demand Trends and the charts now follow the site too (expenses are stamped with their site; old ones count as the Shop's). Each site's materials list must be set once per item (Inventory → 🧩).
- Per-item low-stock level: the Add New Item form now has "Low-stock alert at" (this item's own minimum; blank = shop-wide level), and variant rows use the item's own level. It was already editable in the item's Edit window (Stock alerts).
- **Accounts (new tab, owner/admin only, Finances group):** double-entry books rebuilt from the till's own records on every open (so they can never disagree with it): **General ledger** per account with running balance, **Trial balance**, **Income statement**, **Balance sheet**, **Cash flow** (direct), **Receivables and Payables ageing**, **Bank / M-Pesa reconciliation** (paste statement lines, auto-match, record missing items), **Fixed-assets register** with monthly straight-line depreciation and disposal, **Journals & opening balances**. Every report prints and exports to CSV. Accrual basis: a Pay Later bill is income and a receivable the day it is made; bill payments clear it; "Restock" expenses go to Inventory. Tests `zip227-accounts` (postings balance, statements add up, ageing, cash flow, bank rec, tab in 6 apps). Not in Aqua/Owner.
- **Payslip "Approved by":** type the approver's name; remembered, shown on screen, print, PDF and share.
- **Chama full member report:** one report per member with summary, deposit history, loans and repayments, penalties, meeting attendance and every transaction with a running balance; prints and exports to CSV.
- **Archived status** (Item edit > Status): hidden from the till grid and search, the Inventory list (tick "Show archived" to see them) and stock take; never deleted, history and stock value kept.
- **Stock-take reasons per line:** every counted line that differs gets a reason (Damaged, Expired, Missing / theft, Counting error, Delivery not recorded, Used / sampled, Other) saved on its movement as "Stock take - <reason>".
- **Stock value by branch:** this branch plus every other branch (from the copy this device holds; "Load this branch" refreshes one).
- Already existed (no change): Supplier directory and Purchase Orders (Restock / Orders tabs). Branch-to-branch transfers with approval: not built.
- **Chama reports and ledgers:** new printable **Cash book** (money in / out / running balance, opening balance, date range), **member ledger**, **fund ledger**, **Income and expenditure**, **Financial position**, plus **Print every member's statement**. Every Chama report and statement now prints cleanly (only the report, with a "Printed <date>" line, headers repeat on each page) and exports to CSV.
- **Every ledger printable in the shop apps:** Trade credits, Cross-branch sales, Deliveries, Bills, Audit, Inventory list, Restock, Orders, Trends, Dashboard, Store, Contracts, Attendance and Tables/Rooms get a "Print / Save as PDF" button (titled with the business name and date). New block `print-panels`; test `zip224-print-panels`.
- **No re-login after a flaky connection:** a PIN/password entered offline is kept for that tab only and the server session is requested silently when the internet returns (also after a page reload). Payroll no longer shows its sign-in card in that case - it waits for the silent session, and opens by itself on reconnect. New `staffSessionEnsure`; test `zip222-session-reconnect`.
- **Login audit (online AND offline):** shop password, staff PIN (picker and personal link) and the Owner Console password are all verified on the device, so they work with no internet. New test `zip221-login-offline` proves it in all 7 shop apps + owner, offline and online; the page itself opens offline from the service-worker copy (query strings like `?staff=` included).
- **Aqua cost mode:** every product/refill chooses "calculate from materials" or "I type the cost"; no hidden cost any more (fixes the 0 vs 708 mismatch).
- **Stock rules per item:** low-stock / reorder level, OUT OF STOCK pill, Inactive (blocks sale), Adjust stock with reasons, valuation by category.
- **Renaming a service/dish** keeps the same item and its image.
- **Category order:** manual drag, A-Z, Z-A, most items, best selling; shop-wide sync.
- **Payslips:** Print, Download PDF, Share PDF, Save, Saved copy, Cancel. Saved PDFs live in D1 (`pr_slip_files`) and copies older than 90 days move to R2 automatically (restored on open). Migration 0010 regenerated (idempotent; run it).
- Not built from the master prompt: general ledger/trial balance, AR/AP ageing, reconciliation, fixed assets, branch transfers, PO workflow, per-tenant D1 (not possible with Pages static bindings).

## Zip 219 - Settings > View, Owner sidebar, Daily Sales, stale-page fix
- **Settings > 👁️ View** (new tab, every app): ALL the "hide this" switches now live in one place - Hide Sell Unlisted Item, Hide the 🧾 Bills button (Hotel: the staff-bills button on the Sales Counter), Hide the 💰 Sales button, and the Phone & till layout (photos per row, search style, which tabs show). Shop-wide; nothing is deleted.
- The Sales panel heading reads **Daily Sales** (it said "Everyone"); another day reads "Daily Sales - <date>".
- **Owner Console** now has the grouped sidebar like the other apps (Clients & Links, Money, Content, Monitoring, Team, System).
- **Old page after a release fixed**: the service worker now always tells an open page when a newer copy differs from the one it was shown (it stayed silent on the first open after a release), and every app's service worker version is bumped so installed apps re-download the page.

## Zip 218 - Photos per row (2 or 3) on the phone
- **Aqua POS: Dispatch Refills.** Production > Dispatch History > 💧 Dispatch Refills. Pick the shop branch, then send refill water either as **pre-filled bottles** of an existing refill size (N x size, converted to litres) or as plain **litres**. It is taken from Production's bulk tank(s) and added to the branch's tank, both tank logs get an entry, and it shows in Dispatch History (e.g. 200 L). Refused, with nothing changed, if Production lacks the water, the branch tank lacks room or has no tank, or a half bottle is entered.
- Settings > Phone till (Payment methods card): **Photos per row on the phone - 2 big photos / 3 smaller photos**. It applies to the item photo grid AND the category / sub-category picture tiles, and is saved for **every device** of the shop.
- Sub-category pictures (Hotel) were already supported: Settings > Category images lists every sub-category under its category with Add image; a sub-category without a picture is a plain button when "plain buttons" is on. Category -> Sub-category -> Items each show pictures or buttons.

## Zip 217 - Counter tweaks (included in the 216 package)
- The Sales panel heading now reads **Today's Sales** (or "Sales - <date>" when another day is picked) instead of "Everyone".
- Settings > General: hide the 🧾 Bills button and/or the 💰 Sales button on the Sales Counter (per device; nothing is deleted).
- Choose a Price: typing a decimal quantity (0.5, 2.25) now adds exactly that to the cart; it used to round to a whole number.
- Hidden payment methods, hidden buttons (Bills / Sales / ad-hoc), hidden phone tabs and the search style now apply to **every device of the shop**, not just the one you changed them on.
- "Tengeneza Payroll" is now **Create Payroll** everywhere.
- **NEW PRODUCT: Chama** (`/chama/`, generate links on the Owner Console like any other product). Mobile-first chama / merry-go-round / savings-group manager: phone + PIN sign-in with remembered devices, roles (admin, secretary, treasurer, members) with permissions, configurable contribution periods with first-class partial payments, M-Pesa message paste (only code, amount, date, time and recipient are read and kept; balance, daily limit, link and raw text are never stored), duplicate-code protection, secretary verify/reject inbox, meetings, attendance, optional penalties, minutes (draft/approved), announcements, merry-go-round, loans with guarantors, fundraisers, multiple funds, append-only ledger with reversals, statements, reports (print/PDF, CSV), audit log. New D1 tables: `migrations/0012_chama.sql`.

## Zip 216 - Create Payroll + LPG / gas retail
- **Create Payroll** (Staff group, every app): staff register with documents (ID, contract, certificates; stored privately in R2), salary set-up, pay runs (review > approve > pay), payslips (screen + PDF), additions and deductions, optional statutory template (OFF by default - verify rates with KRA / NSSF / SHA before switching on). Admin and payroll-rights people only; a worker opens only their own paid payslips; another person's private document = ACCESS DENIED. An approved / paid run can never be edited - corrections are a reversal or adjustment run. Needs internet and a signed-in staff PIN session. Server: `functions/api/payroll.js`, migration `0010_payroll.sql`.
- **LPG / gas**: one chooser at the Sales Counter (**🔥 Gas**: Buy Full / Exchange Empty / Buy Cylinder / Buy Set); a mixed cart is one sale and one payment. The Gas tab's mini-counter is gone; the tab now keeps stock: Full / Empty / Away / Damaged per size, full / refill / empty prices **and costs** (gas lines used to record a price tier as their cost - margins were wrong), bundles with cost, margin and promo price, damaged handling with reasons, cylinder stock take with admin approval (adjusts by the variance found), brand exchange rules (own brand always; partner brands only by agreement), movement history (before / change / after / why / sale), dashboard cards and gas reports.
- Every cylinder movement now carries a gas note; exchanges also log the empty that came in (it used to change without a movement). A failed checkout puts back the Damaged / Away counters and a set's parts too. At payment the cart is re-checked as a whole.
- Server: `lpg_movements` (append-only), `lpg_sale_lines`, `lpg_stocktakes` (decided = final), filled in the same atomic group as the sale; migration `0011_lpg.sql`. Every row carries the branch's client id.
- Tests: `tests/zip216-payroll*.mjs`, `tests/zip216-lpg.test.mjs`, rewritten `tests/gas.test.mjs`.

## Zip 215 - Aqua POS: honest costs, staff, stamp, tabs, stock, Capture Sales
- **Material cost is never hidden**: the recipe window now shows each material's cost (editable right there), the line cost and a plain note about whether the item's own Cost Price is counted. A new install no longer starts with a 1.50/litre water cost. (The 708.50 came from an old "1.5 BOTTLES" material in the recipe whose cost was never visible.)
- **Plain link = Shop** (every shop staff member); only a link ending **#production** is Production. The last-used site is no longer remembered at start-up.
- **Removed staff** can no longer be picked, use their old personal link, or approve as a manager - in every app.
- **PAID / UNPAID stamp mark** (Settings > Receipts > Receipt Stamp): prints under the stamp (or alone). UNPAID = Pay Later / Pay on Delivery / bill owing.
- **Hide any tab** (including Sales Counter and Bills; only Settings stays): hidden = removed from the bar, More and side menu until ticked again. Per device.
- **Stock**: restocking from a captured list in the "All Sites" view was shown but never saved (came back to the old figure) - fixed. Many random two-till sale/offline/sync runs checked: sale + material stock always agree.
- **Capture sales from a book** (Aqua > Daily Sales): photo/upload -> AI reads items, quantities, prices -> you match each line -> one confirm records the sale and takes stock off (products, bale bottles, tank litres, recipe materials).
- **Aqua tabs**: Add New Items, Inventory and Materials (with Suppliers) are now three tabs. Staff who had Inventory keep access to all three.
- Tests: `tests/zip215-aqua-fixes.test.mjs`, `tests/zip215-tabs.browser.test.mjs`.

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
