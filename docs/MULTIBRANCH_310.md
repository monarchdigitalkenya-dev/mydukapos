# Zip 310 - Multi-branch Phases 2 and 3: stock locations, transfers, HQ dashboard, reports, roles

> **Zip 311 update:** HQ is simpler. Stock is one list per branch with Move / Send to branch / + Store on each item, a Main store is made for each branch, transfers go out at once (approvals are off unless the owner turns them on in More > Transfer approvals), every dialog has its ✕ at the top and its buttons at the bottom, and the Staff-tab HQ button no longer disappears. See CHANGELOG.md, zip 311.

This finishes the multi-branch brief. Phase 1 (Business HQ, branches, staff across branches, HQ administrators, audit) is zip 309
(`docs/MULTIBRANCH_309.md`); the audit of the existing system and the plan are in `docs/MULTIBRANCH_AUDIT.md`. Below: the brief's deliverables 1-9.

## 1. Existing architecture (what was kept)
- A business is a **branch group**; each branch is its own shop with its own link, licence, staff list, sales and database.
- A branch's stock lives in its own shop database. Every quantity change is a **stock movement** with its own id, applied by the server exactly once
  (the stock ledger, zips 120-306). That is what keeps two devices in step: a device holding an old quantity cannot push it back over a newer one.
- Nothing in that model was changed. Stores, transfers and reports are added *around* it. The shop floor is still counted, sold from and restocked
  in the till exactly as before.

## 2. The model after this zip
| Thing | Where | Rule |
|---|---|---|
| **Shop floor** | the branch's own database (location id `floor`) | what the till sells from. Changed only through stock movements. |
| **Store / location** | `inv_location` (main store, warehouse, kitchen, bar, pharmacy, other) | per branch, unique name, "Shop floor" reserved |
| **Location stock** | `inv_loc_stock` | `CHECK (qty >= 0)`: a store can never go below zero, even with two moves at once |
| **Movement history** | `inv_movement` | append-only (no update, no delete); the id is fixed per step, so one step can never count twice |
| **Transfer / move** | `xfer`, `xfer_line`, `xfer_event` | `TR-00001` between branches, `MV-00001` inside a branch; events append-only; a closed transfer cannot be changed |
| **Approval rules** | `org_setting` | every transfer / above a value / never; independent approval; whether moves inside a branch need approval |
| **Role** | `org_role` | a named set of screens + manager flag, given to a person **at one branch** |

**Branch total = shop floor + its stores.** A move inside a branch changes *where* stock is, never the total, and never creates a sale or a purchase.

## 3. Transfer lifecycle
`pending` (needs approval) -> `approved` -> `dispatching` -> `in_transit` -> `partial` / `discrepancy` -> `completed`; `pending` / `approved` ->
`rejected` / `cancelled`.
- **Dispatch** takes the stock off the source. On a shop floor the check and the deduction happen in **one request inside the branch database**, so
  a sale of the last unit at the same moment cannot slip in between. If the source is short now (it sold some since the request), nothing is taken
  and the transfer goes back to `approved` with the shortage shown.
- **In transit** stock belongs to neither branch: it is in neither count and is listed on its own in the stock report.
- **Receipt** adds only what was **received in good order**. Damaged and missing are recorded per line; received + damaged + missing can never be more
  than what is on the way (database CHECK). Several part-receipts are allowed. Each receipt has its own id: pressing Confirm twice, or a retry
  after a dropped connection, is counted once.
- **Settle** (approval permission): each damaged / missing line is written off, returned to the source, or found at the destination, with a note.
- **Reverse** (moves inside a branch): a new move the other way, linked to the original; the original stays in the history. Between branches, you
  make a transfer back.
- **Independent approval**: an administrator cannot approve a transfer they requested (the owner can). Dispatching needs a person who manages the
  source branch; receiving, one who manages the destination.

## 4. Files
- New: `functions/api/_stock.js` (schema, location stock, shop-floor movements, references), `functions/api/_xfer-actions.js` (stock and transfer
  actions), `functions/api/_hq-reports.js` (dashboard, reports, CSV, roles), `migrations/0016_stock.sql`.
- Changed: `functions/api/org.js` (routes the new actions after the HQ sign-in check), `src/shared/blocks/business-hq.html` (Dashboard, Stock,
  Transfers, Reports, Roles tabs; "Role at a branch" on a person) -> synced into the 7 apps. Service worker `zip-310`.

## 5. Dashboard and reports
- **Dashboard** (opens first): sales today and last 7 days (completed sales from the transaction database, the same numbers the branches'
  reports reconcile against), branches active / suspended, staff, HQ administrators, items at or below their low-stock level (the till's own rule:
  the item's reorder level / minimum, else the shop's level), transfers waiting for approval / to dispatch / in transit / with discrepancies,
  per-branch table, open transfers, latest stock movements and HQ activity.
- **Reports** (permission `reports.view`): Sales by day and branch (with payment methods and gross profit), Stock by branch and place (shop floor,
  stores, in transit; value at cost; low / out), Transfers and discrepancies (every line), Staff by branch. **One branch or consolidated.** An
  administrator's "consolidated" only ever covers the branches they manage. **Download CSV** (opens in Excel; cells that look like formulas are
  neutralised so a spreadsheet never runs them). Viewing a report is recorded in the audit trail.

## 6. Roles
Templates: Branch manager, Supervisor, Cashier, Store keeper, Accountant, Auditor (view). A template fills in the screens this app actually has;
you can change them and save it as your own role, or start a custom role. A role is given **per person per branch** (Staff -> ⋯ More -> Role at a
branch): the same person can be a store keeper at one branch and a cashier at another. The Staff screen is never part of a role. Only the owner
(or an administrator over all branches) can create or give a manager role; nobody can change their own role. The PIN is never touched.

## 7. Security
Every new action runs on the server after the HQ session check of zip 309 (deny by default, permissions and branch scope re-read on every
request). Stock actions need `inventory.manage`, approvals and settling need `transfers.approve`, reports need `reports.view`, roles need
`staff.manage`; only the owner changes the approval rules. Every change is in the HQ audit trail and the transfer's own history; neither can be
edited or deleted.

## 8. Tests actually run
- `tests/zip310-stock-transfers.test.mjs` (7 tests, real server code, real shop databases on SQLite, D1 on SQLite): stores (no duplicates, reserved
  name, reason required, a receipt counted once, a count); **17-19** store -> floor and back, a refused over-move, reversal, branch total unchanged,
  no sale / purchase created; **20-22** approval, dispatch -> in transit (not at the destination), a second dispatch takes nothing, part receipt
  with damaged, the same receipt twice, over-receipt refused, missing, settle, stock conserved across the business, closed transfer locked;
  **23** two transfers for more than is on the shelf dispatched at the same moment -> exactly one, never below zero; three identical receipts at once
  -> added once; a sale between request and dispatch -> refused with the shortage; **24** independent approval, scope (source / destination),
  permissions, reasons, owner-only rules; store items keep their selling price at a new shop floor; a broken-off dispatch finishes once; migration
  file = what the server creates.
- `tests/zip310-hq-reports.test.mjs` (3 tests): dashboard numbers (voided sales excluded, low-stock rule), consolidated and per-branch sales, stock
  CSV with formula neutralising, administrator scope in reports, roles per person per branch, no self-change, manager roles owner-only.
- `tests/zip310-hq-stock.browser.test.mjs`: Chromium, the real Shop app at 1366 px and the real Hotel app on a 390 px phone, against the real server
  code: dashboard, add a store, receive, a refused over-move, a move to the shop floor (checked in the branch database), a transfer requested,
  approved, dispatched, received with 1 damaged, settled, a stock report and its CSV download, a role from a template; no sideways scroll, no errors.
- A device that still holds the old quantity and pushes the item after an HQ move cannot undo the move (checked against the shop database).
- Full regression: see the zip 310 entry in CHANGELOG.md.

## 9. Limits and what needs you
- **Batches, expiry and serial numbers** move at quantity level: a transfer line can carry a batch number and expiry date for the record, but the
  receiving till's own batch list is not split automatically. For pharmacy batches, receive the batch in the till (Restock) after the transfer.
- **Stores** are managed in Business HQ (needs the internet). The tills keep working offline; the shop floor is what they sell.
- **A branch must be in its own database** (every paid branch moves there by itself at its first sync) before stock can move on its shop floor;
  otherwise HQ says so and nothing changes.
- **Deploy:** step 19 (migrations apply) creates the new tables; if it is skipped they are created on first use anyway.
