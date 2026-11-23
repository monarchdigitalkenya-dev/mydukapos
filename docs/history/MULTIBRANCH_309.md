# Zip 309 - Multi-branch Phase 1: Business HQ, branches, staff across branches, HQ security

Part 1 of the multi-branch brief. The audit and the full plan are in `docs/MULTIBRANCH_AUDIT.md`. Phase 2 (inventory locations, store-to-floor moves,
inter-branch transfers with approval / dispatch / receipt / discrepancies) is zip 310; Phase 3 (HQ dashboard, consolidated reports, role templates and
custom roles) is zip 311.

## 1. Existing architecture (what was found)
See the table in `docs/MULTIBRANCH_AUDIT.md`. In short: a business is a **branch group**; every branch is its own shop (link, licence, staff list,
stock, sales, database). Staff live in each branch's own list; there was no person identity across branches; the server checked staff permissions
only when a shop had switched "staff sessions required" on.

## 2. Branch, staff, role and permission model after this zip
- **Business** = the branch group (a shop with no branches is a business of one). **Owner** = whoever knows the main branch's management (Admin)
  password. Cannot be delegated or removed from HQ.
- **Branch** = a shop in the group, now with an HQ profile: unique code, name, manager, phone, email, location, notes, status active / suspended.
- **Person** = one staff record id, the same in every branch the person works at (no second account). Employee number unique in the business.
- **Assignment** = person -> branch, effective-dated: `permanent`, `additional` or `temporary` (with an end date; ends by itself).
- **HQ administrator** = a person given explicit HQ permissions (`branches.manage`, `staff.manage`, `staff.assign`, `admins.view`, `audit.view`,
  `reports.view`, `inventory.manage`, `transfers.approve`) over all or listed branches. Nothing by default; only the owner can add or change them.
- **Branch-level roles** stay as they are (the screens each person may open, manager flag, fine permissions), per branch, and are carried with the
  person when they are placed at another branch (or changed there).

## 3. Database tables (transaction database, LEDGER_DB)
`org_branch`, `org_person`, `org_assignment` (no delete), `org_admin`, `org_audit` (no update, no delete). Unique: branch code per business,
employee number per business, one admin row per person. Migration `migrations/0015_org.sql` (also created by the server on first use, so nothing
breaks if the migration step is skipped). No existing table or record is changed; no data is moved.

## 4. Features
- **Business HQ** (every app: Staff tab button for the Admin, and the branch switcher menu): Branches, Staff, Administrators, Audit trail.
- **Branches:** profile with unique code, guided Add a branch (name + code, no duplicates, the plan's branch limits still apply), Suspend (reason
  required; the branch's tills stop with "suspended by the business owner"; nothing deleted) / Activate; the main branch cannot be suspended.
- **Staff across branches:** one directory with search (name, employee no., phone) and filters (branch, status); Assign / move: *also works there*,
  *move permanently*, *temporary posting until a date* (ends by itself); End at a branch; Deactivate everywhere (reason required; ends sessions and HQ
  access); Reactivate; edit name / employee number / phone. PIN hashes never leave the server.
- **Branch switcher:** shows the HQ name and code ("Westlands · WLD"); suspended branches are not offered.
- **Fixed:** the Staff tab's "Move to branch" used to cut the person out of the old branch's list, which the sync did not treat as a deletion, so a
  device at the old branch put them back. It is now a real move (same id, marked removed at the old branch, history recorded).

## 5. Security
- Every HQ action is authorised on the server (`functions/api/org.js`), on every request, deny by default. The HQ session token is signed with the
  main branch's server key in its own context, so no staff or device token can pass as one; it lasts 8 hours and ends when the password / PIN
  changes. An administrator's permissions and status are re-read on every request (a change applies to the next request).
- Administrators cannot: manage administrators, give themselves anything, change their own assignment or account, act on a branch outside their
  list (changing a branch id in the request is refused), or deactivate someone who also works at a branch they do not manage.
- Sign-in attempts are rate limited (the existing staff PIN limiter). The audit records actor, action, target, before / after and reason; no secrets.

## 6. Tests actually run
- `tests/zip309-business-hq.test.mjs` (7 tests, real org.js / branches.js, real shop databases, D1 on SQLite): owner sign-in and default deny,
  forged / staff tokens refused, branch codes unique, suspend / activate (licence stops, nothing deleted), main branch protected, one person at two
  branches without duplicates, permanent move that a stale device cannot undo, temporary posting that expires, deactivation everywhere ending HQ
  access, delegated administrator limits (scope, no self-elevation, no self-change, immediate effect of reduced rights, PIN change ends session),
  the fixed Staff-tab move, switcher summary, Add a branch with duplicate checks.
- `tests/zip309-business-hq.browser.test.mjs`: the HQ screen in Chromium inside the real Shop app (1366 px) and Hotel app (390 px phone) against the
  real server code: wrong password refused, owner sign-in, edit a branch code, place a person at a second branch, audit shows it, no sideways scroll.
- Regression: see the zip 309 entry in CHANGELOG.md.

## 7. Not in this zip / needs you
- Inventory locations and transfers (zip 310); HQ dashboard, consolidated reports, role templates / custom roles (zip 311).
- People who were created twice (once per branch, before this zip) show as two people; they can be ended at one branch and placed from the other.
- New staff are still created in their branch's Staff tab (that is where the PIN is set, offline-safe). HQ places existing people across branches.
- Deploy: `npm run deploy:router` is not needed for this zip beyond the earlier ones; the migration step (19) creates the HQ tables.
