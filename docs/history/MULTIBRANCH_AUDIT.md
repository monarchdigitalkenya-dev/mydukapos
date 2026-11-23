# Multi-branch, staff, RBAC and stock transfers: audit of what exists (before zip 309) and the build plan

## 1. What the system already is

| Area | How it works today | Where |
|---|---|---|
| Business / tenant | A **branch group** (`branchGroupId` on each licence) is the business. Every branch is its own shop: its own link (sub-domain), licence, staff list, stock, sales and its own database (ShopStore Durable Object). One member holds `isMainBranch`. | `_license.js` (getBranchGroupMembers, addToBranchGroup, getGroupMainRecord), `branches.js` |
| Branches | Create (auto slug `main1`, `main2` ...), set main, delete, summary/detail panel with stats. Billing caps the number when subscriptions are enforced. No branch code, profile, manager, status or suspend. | `branches.js` |
| Branch switcher | Header pill for the **Admin only**: lists the group's branches + "All branches (combined, view only)"; switching opens the other branch's link in the same tab after saving unsent work. | `src/shared/blocks/branch-switcher.html` (all apps) |
| Staff | Per branch: `staff[]` in that branch's synced state (id, name, sealed `pinHash`, `roles` = allowed tabs, `isManager`, `perms`, `removed`, `lockedDates`). Sign-in works offline with the PIN. **No person identity across branches**: the same person at two branches is two records. | app `staff-tab`, `_staff-auth.js` |
| Staff move | `branches.js` `migrateStaff` filters the person out of the source list and writes both lists with `seedInitialState`. **Bug:** removing a record from the array is not a deletion the sync understands, so a device at the old branch pushes the person back. No additional/temporary assignment, no audit. | `branches.js` |
| Roles / permissions | Tab-level roles (`ROLE_TABS`), `isManager`, a few fine permissions (`perms`), Profits full/expenses-only. Server sessions per staff member (signed claims `sid,name,perms,mgr`) exist; **backend enforcement is opt-in** (`readMode === 'enforce'`, off by default). With it off, a manager action is not checked on the server. | `_staff-auth.js`, `_sec-guard.js` (managerGuard), `_perm-guard.js` |
| Shared warehouse ("Store") | Business-wide store in D1: `store_items` (qty CHECK >= 0) and `store_movements` (append-only, idempotency key, `dest_client_id`, `status`, `received_at`). Branches pull stock from it. | `store.js`, `_store-d1.js`, `migrations/0001_ledger.sql` |
| Stock between branches | Cross-branch SALE (sell another branch's stock at your counter) with one stock movement per line, applied once. No branch-to-branch transfer with approval / dispatch / receipt. | `cross-branch-sale.js` |
| Stock inside a branch | One quantity per item per branch (plus Water "sites", Hotel kitchen ledger). No inventory locations (store room vs shop floor). | apps, `_merge.js` stock ledger |
| Stock ledger | Every stock change is a movement with a stable id, applied exactly once by the server (`applyStockLedger`); duplicates are ignored. | `_merge.js`, `shop-store.js` |
| Audit | Per-shop audit (`ledger_audit`, append-only trigger), security events, owner money log. | `_audit-db.js`, `_sec-events.js` |

## 2. Gaps against the brief

1. No Business HQ: the owner cannot see or manage branches, staff and roles in one place.
2. No branch code / profile / manager / suspend.
3. No person identity across branches; moving staff can be undone by sync; no multi-branch or temporary assignment; no assignment history.
4. Permission checks on the server are off unless each shop switches enforcement on; HQ actions have no owner authentication of their own.
5. No inventory locations inside a branch; no store-to-floor moves.
6. No inter-branch transfer lifecycle (request, approve, dispatch, in transit, receive, discrepancy).
7. No consolidated HQ dashboard for transfers / staff / branches.

## 3. Decisions (keeping the existing architecture)

- **Branches stay separate shops** (their own database each), as today. The brief says not to split or merge storage without approval; the group is the business.
- **New HQ records live in the shared transaction database (D1, `LEDGER_DB`)**, keyed by `group_id`: they are business-wide, need SQL constraints, uniqueness and transactions, and every branch can reach them.
- **HQ actions are owner-authenticated on the server, always** (not opt-in): the main branch's management (Admin) password, proven per request with the same SHA-256 proof the staff-session endpoint uses, or a delegated HQ administrator's own session with explicit permissions. Deny by default.
- **A branch's own staff list stays the thing devices sign in with** (offline PIN sign-in keeps working). HQ writes assignments into each branch's list through the shop's own database (as a device push would), so they sync like any other change; ending an assignment marks the record `removed` (never deleted), which also ends that person's server sessions there.

## 4. Build order

| Zip | Phase | Contents |
|---|---|---|
| 309 | 1: identity, branches, staff, HQ security | D1 tables `org_branch`, `org_person`, `org_assignment`, `org_admin`, `org_audit` (append-only); `/api/org` with owner / delegated-admin auth; branch profiles (code unique per business, manager, contacts, status, suspend/activate keeps history); staff directory across branches; add branch / move / temporary assignment / deactivate everywhere without duplicate people; fix of the migrateStaff resurrection bug; HQ screen in every app for the Admin; switcher shows codes and hides suspended branches. Tests. |
| 310 | 2: inventory locations and transfers | Locations per branch (main store, shop floor, kitchen store ...), location balances, store-to-floor moves; inter-branch transfers with approval rules, dispatch (stock out, in transit), receipt (partial, discrepancies), reconciliation; idempotent, concurrency-safe on D1 + the shops' stock ledgers. Tests incl. duplicates and concurrent dispatch. |
| 311 | 3: HQ dashboard and reports | Branch / staff / transfer / discrepancy overview, consolidated vs branch totals, audit search, role templates and custom roles in a permission matrix. Full regression and report. |
