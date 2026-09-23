# Zips 24 - 69 — what changed

## Zip 69 — Aqua POS: connected bale/bottle production fixed; Stock Take gets a per-item apply
Both reported bugs, fixed and verified with real tests (not just "it parses") given how much this exact class
of mistake has cost this session already.

* **"I produced 24 bales and the linked Sealed Bottle stayed at 0" — root cause found and fixed in three
  places.** A bale connected to a Sealed Bottle product (linked, "track by bottle" off) has no stock of its
  own at all — its displayed quantity is always derived live from the bottle's actual stock. Both production
  entry points (the Production Wizard and the simpler quick-produce form) were writing straight to the bale's
  own qty/bottleStock fields regardless of this — a value that gets silently overwritten the next time
  anything resyncs it, while the bottle (what's actually sold) never received the produced stock at all. Fixed
  in the Wizard, the quick-produce form, and the shared `adjustProductStock` helper other callers (returns,
  restocks) already rely on for this same bale↔bottle awareness — which had the identical gap for a
  *trackBottles* bale (an independently-tracked one), also fixed.
* **"Doesn't connect unless I untick then tick again" — fixed.** Unticking "track by bottle" never actually
  re-synced the bale's derived quantity — only re-ticking did, as a side effect of its own seeding logic. A
  single untick now re-syncs immediately.
* **Stock Take: per-item apply.** Added a "💾 Update" button to every row — type a count, tap it, that one
  item's stock updates immediately to exactly what was counted, without needing to fill in every row and hit
  one bulk "Apply" button. No confirm dialog for a single row (same reasoning the inline Inventory-table edit
  already uses) — the bulk "Apply all" button is untouched and still there for counting a whole shelf at once.
  Shares the same variant/parent-resync logic already built for Stock Take earlier this session, so it works
  correctly for a variant row too.
* Two new test files written to actually prove both fixes work — `tests/aqua-production-bale-link.test.mjs`
  (4 cases: both production entry points, the trackBottles case, and the untick-alone re-sync) and an
  addition to `tests/stock-take.test.mjs` for the per-row button. Both hit a real bug on first run — a missing
  "switch to the Production site first" step in the test setup for the production tests, and an apostrophe-
  escaping mistake in both new test files — caught and fixed before either was trusted.

**Verified:** `npm run check`/`npm run lint` clean. `aqua-production-bale-link` 4/4, `stock-take` 10/10
(covering all 7 modules with Stock Take plus the new per-row case), plus a broader regression batch
(`water-tanks-sites`, `water-refill-sites`, `loose-units`, `sales-and-print`, `smoke`, `static`,
`lint-globals`) 56/56 — 70 individual subtests this turn, 0 failures.

## Zip 68 — HMIS Phase 5: minimum-price guardrails, genuinely verified this time
Finished the minimum-price feature from last turn and, given how much silent-corruption risk this session has
already turned up, wrote real tests for it rather than just re-confirming "it parses."

* **Minimum Price field** added to the inventory schema in all 6 modules with an Add Item form (root, hospital,
  hotel, production, services, pharmacy): the Add Item form, the existing-item Edit modal (root, production,
  services, pharmacy), and the form's own reset-between-entries logic — a value typed for one item can no
  longer leak into the next new item's form by accident.
* **Enforcement, verified working end-to-end:** a manually typed/quoted custom price below an item's minimum
  is blocked with the exact message the spec asked for ("Entered price is below the minimum allowed threshold
  of KES X"), and the sale is genuinely refused — nothing gets added to the cart, not just a warning shown
  alongside it going through anyway. A price exactly at the floor is correctly allowed. An item with no
  minimum set behaves exactly as it always did (no new restriction). Deliberately scoped to custom/quoted
  prices only — picking a preset Retail or Wholesale tier is never blocked, even if that tier happens to sit
  below the floor, since those are the admin's own configured prices, not a staff-negotiated one.
* **Caught my own mistake while building this, again:** a batch edit meant to add the field to both the
  service-type and item-type object literals in 6 files instead duplicated it into one and skipped the other,
  because of the same kind of indentation-substring overlap that bit the Sales Counter role fix earlier this
  session. Caught by checking the actual diff rather than trusting a "patched" message, and fixed properly in
  all 6 before anything shipped.
* New test file (`tests/minimum-price.test.mjs`, 8 cases across root and hospital's two different code
  shapes) actually exercises the modal and checkout path rather than just asserting the code is syntactically
  valid — given how many silent, structurally-plausible-but-wrong edits this exact feature produced while
  being built, "it parses" was not enough confidence to ship on this time.
* Water's guardrail check exists and is correct but is currently inert — flagged again honestly: water's
  Inventory UI is a different paradigm (table/modal-based) from the other 6 modules' Add Item form, and
  doesn't yet have an input to actually set `minimumPrice` on a product.

**Verified:** `npm run check`/`npm run lint` clean; the new test file passes 8/8 on a genuine first run (not
after debugging failures — a good sign the underlying logic, once the duplication bug was caught, was sound);
broader regression batch (`dosing`, `sales-and-print`, `smoke`, `static`, `lint-globals`) 51/51, 0 failures.

**Still open:** water's Minimum Price input UI; the whole-sale "quote a custom total for the whole cart" path
(deliberately not given the same per-item floor check — a blended discount can legitimately put one item
below its own floor while the deal stays profitable overall, and enforcing that cleanly needs more thought
than a quick pass); HMIS Phases 2-4 (the queue/transfer pipeline, remaining stations, registry history beyond
vitals) — all of Phase 5 is otherwise done.

## Zip 67 — Stay Signed In off by default, cart/tab persistence ported everywhere, HMIS Phase 1 done
* **Stay Signed In — off by default, across all 9 files (all 8 apps + Owner Console).** Was on by default;
  now a shop opts in per device from Settings ▸ Security & Access instead of it being on until someone
  notices. Updated the Settings toggle's own description to say so explicitly. The existing test suite
  assumed the old default and needed updating — not weakened, corrected: every existing test now explicitly
  turns the setting on first (since they're testing what happens *while* it's on), and a new test confirms a
  genuinely untouched device — the actual default now — never resumes a session on its own.
* **Cart/tab-reload persistence — ported from root to hotel, hospital, production, services, pharmacy, and
  water.** School skipped (confirmed again: its Sales Counter is the dead/repurposed-into-Dashboard one found
  earlier, nothing to persist). Water got the cart-restore half but not the active-tab-restore half — its
  startup sequence is structured differently enough from the other 6 that I didn't want to rush an insertion
  there; flagging it as a known small gap rather than guessing.
* **HMIS Phase 1 (Triage vitals) — done.** Better news than my last assessment suggested: hospital already had
  a full vitals capture modal (BP, pulse, temperature, SpO2, weight/height with live BMI) AND already correctly
  copied it into the permanent visit record when a visit is saved — I'd been wrong to flag that as a gap.
  What was genuinely missing: a nursing assessment notes field (added), and vitals were never actually
  *displayed* anywhere in the patient's visit history despite being stored — added a vitals summary line to
  each visit history entry, so Phase 1's "saved permanently AND visible in the registry" requirement is now
  both true, not just the storage half.

**Verified:** `npm run check`/`npm run lint` clean across every change. Ran every test file touching what
changed this turn — `stay-signed-in` (8/8, including the new default test), `hold-sale`, `sales-and-print`,
`smoke`, `static`, `patient-billing`, `lint-globals` — 87 individual subtests this turn, 0 failures.

**Still open, unchanged in scope:** water's active-tab restore; HMIS Phases 2-4 (the full 12-station queue
with explicit push-to-next-stage transfers, the remaining stations — Consultation, Diagnosis, Recommend
Medication, Dispensing, Clinic, Check-up — and further patient registry history beyond vitals); HMIS Phase 5
(minimum price guardrails). These are each substantial builds in their own right, not bug fixes — continuing
in the same reply.

## Zip 66 — Sales Counter forced-role fix and Cash-default UX finished across all 8 modules
Two items that had been outstanding since an earlier message, now fully done and verified everywhere (they
also turned out to be items #4 and #6 of the new HMIS request — already complete for hospital as part of this).

* **"Sales Counter forced on every staff member" — finished.** Last turn's fix only reached root/Shop; this
  turn applied the identical fix (remove the hardcoded checked+disabled checkbox, respect real role state) to
  the existing-staff edit view in water, hotel, hospital, school, production, services, and pharmacy — hospital
  needed a third, structurally different spot too (`renderEditStaffRoleCheckboxes`, its own modal-based edit
  flow, not the inline-edit pattern the others use). An admin can now genuinely create or edit a staff member
  with no Sales Counter access (e.g. Deliveries-only, or — for hospital — Triage/Lab/Pharmacy-only with no
  Cashier access) in every module, with the migration from last turn ensuring no existing staff member lost
  access when this landed.
* **Cash pre-selected + Cash Tendered auto-fill — finished everywhere.** Water already had this via its own
  mechanism; applied the identical fix (fold into `updateChangeDue()`, guarded on the field not currently
  being typed into so it never fights a cashier mid-entry) to root/Shop, hotel, hospital, school, production,
  services, and pharmacy. "Cash" was already visually pre-selected by default in every module's markup — the
  actual bug was the empty Cash Tendered field always failing checkout's "less than total" check; it now
  defaults to the running total and updates live as the cart changes, while still respecting a manually-typed
  amount (change is owed) without ever overwriting it.
* **Auto-refresh investigation (root/Shop only so far):** couldn't pin down a single definite JS-level trigger
  despite checking every timer, every `location.reload()`, and the service worker's update logic — the leading
  explanation is the OS reclaiming an idle installed-app's tab on budget Android hardware, which isn't
  something a code fix can prevent. What IS fixed: the actual damage. The Sales Counter cart previously lived
  only in JS memory with zero persistence until checkout — now it saves itself continuously to sessionStorage
  and restores automatically (with a toast) if the page ever reloads, and the app remembers and restores
  whichever tab was actually open instead of always landing back on Sales Counter. Not yet ported to the other
  7 modules.

**Verified:** `npm run check`/`npm run lint` clean; ran every staff, sales/print, receipts, hold-sale, and
smoke/static test file relevant to these changes — 128 individual subtests across this session's batches,
0 failures.

**Still open from this session:** Stay Signed In toggle-off/removal; cart/tab-persistence ported to the other
7 modules; the new HMIS request's outpatient pipeline, triage vitals module, patient registry history, and
minimum-price guardrails (assessed, not yet built — see the reply for the phased plan).

## Zip 65 — the real fix for blank/faded receipts (all 8 modules), plus the variant work verified
Investigated the "receipt printed is completely blank and fades sometimes" report on Shop by tracing the
whole print pipeline (CSS, ESC/POS byte generation, USB/Bluetooth chunking, the print-trigger sequencing) —
most of it turned out to already be solidly engineered from earlier work, but found two real, concrete gaps.

* **The main fix — `print-color-adjust: exact` was missing from the actual receipt print rule in every
  single module.** Without it, the browser is free to apply its own "print economy" color adjustment —
  commonly lightening solid black text to save ink, which is normal and invisible on a regular inkjet/laser
  printer. On a thermal printer there are no shades: text the browser quietly renders as "off-black" gray can
  come out barely visible or not printed at all. This rule already existed for KITCHEN TICKETS in 7 of 8
  modules (and was missing there too, entirely, in water) but had never been applied to the sales receipt
  itself anywhere. Fixed once, globally, at the top of every module's `@media print` block (`* {
  -webkit-print-color-adjust: exact; print-color-adjust: exact; color-adjust: exact; }`) — covers every print
  context (receipt, kitchen ticket, report, bill) in one place, so it can't go missing from one new print rule
  while present on another the way it had.
* **Secondary hardening:** the live "Print Scale" slider's `oninput` handler set `receiptScale` with no
  bounds check, unlike the three other places that set it (initial load, sync pull, staff login), which all
  correctly clamp it to 70–130. In practice the slider's own `min`/`max` attributes already prevent this from
  being reachable through normal use, so this is defense-in-depth rather than a confirmed second cause — but
  an out-of-range scale feeds a CSS zoom/scale factor that a receipt is rendered at, and a very small value
  there would print as effectively blank, so it's now clamped consistently with the other three sites in all
  8 modules regardless.
* Also confirmed as NOT the cause, so as not to leave this as an open question: the receipt-building functions
  (`buildReceiptDoc`, `renderSharedReceipt`) set their print-ready text synchronously with no async gap: the
  auto-print race that seemed plausible at first isn't actually possible; the USB and Bluetooth byte-sending
  functions already chunk and pace writes correctly, with retry/backoff on stalls; and the "receipt prints in
  a new window" code doesn't actually open a new window at all (despite the name) — it prints in-place with no
  timing gap between applying the print CSS class and calling `window.print()`.

Also finished and verified this session's variant work (stock take showing every variant, variant photos in
the Add Item form and the Sales Counter photo grid, and optional main-item price/qty that variants can
inherit or override): `npm run check`/`npm run lint` clean, and directly ran every test file touching this —
`stock-take`, `printer-keeper`, `receipt-uniform`, `receipts`, `sales-and-print`, `sync`, `pull-merge`,
`e2e-revert`, `deletions`, `regressions`, `smoke`, `static`, `lint-globals` — 134 individual subtests this
session, 0 failures.

**Still not done, flagged from last turn and still open:** AI Capture List and Bulk Add supporting variants,
and variant breakdown in reports beyond Stock Take (e.g. the Stock report has the same parent-only gap Stock
Take had before this session's fix).

## Zip 64 — Bills "Update" button and a direct Settle shortcut on tab cards (hotel)
* **✏️ Update button (Bills tab):** a new button on each bill row opens a small modal to correct the
  customer's name, phone, and due date after the fact. Deliberately doesn't touch items, total, or
  amountPaid — those drive the settle/folio math elsewhere, and blind-editing them could desync a bill from
  its own payment history. The existing one-click due-date-only shortcut (click the due date cell) still
  works exactly as before; this covers the rest in one place.
* **💳 Settle shortcut on open-tab cards:** the tab cards shown both on the dedicated Tabs tab and the
  Sales Counter's quick-access tabs popup (same shared render function, so this appears in both places at
  once) now have a direct "💳 Settle" button that jumps straight to the payment-method screen for that tab,
  instead of the old two-step View-then-Settle. Reuses the exact same tab-detail-then-settle-modal flow as
  every other settle path in the app (including the lodging checkout folio from zip 61), so this is purely a
  one-click shortcut to a screen that already existed and was already tested — no new payment logic.
* Caught and fixed my own placement mistake before it shipped: the Update Bill functions initially landed
  inside the shared `@shared:begin/@shared:end` block (right next to the existing `editBillDueDate`, which
  is genuinely shared) — `npm run check` caught the drift immediately, moved the new, hotel-only functions
  outside that block instead of adding them to the shared library (they're not used by any other module).

**Verified:** `npm run check`/`npm run lint` clean; ran `hotel-fixes`, `hotel-bills-quickview`,
`bill-settle-stays-settled`, and `lint-globals` by name — 38/38 passing, 0 failures.

## Zip 63 — Owner Console: staff invite links no longer get stuck on the owner's email sign-in
Reported: adding a staff member in the Owner Console and opening their invite/login link asked for email
sign-in instead of the expected PIN screen. The code already had an explicit "staff don't use email" bypass
— it just had a specific hole in it.

* **Root cause:** the bypass only fired when there was *no owner session already saved on that device*
  (`!ownerSessionToken`). The most natural way to hit this is exactly what happened: opening a staff invite
  link to preview/test it from the same browser you're already signed in as the owner on — the leftover owner
  session blocked the bypass, so it fell straight through to the owner's email sign-in screen, and once past
  that early-return the app never even got to check the invite/staff link at all.
* **Fixed:** an explicit `?invite=` or `?staff=` link is unambiguous — it can only come from a staff link, so
  it now always wins and routes to the staff PIN screen, regardless of any owner session already on that
  device. A remembered staff device with no explicit link parameter this time is unaffected — that narrower,
  more ambiguous case still only applies when there's no competing owner session, exactly as before.
* Also explicitly clears any lingering owner session token when taking this path (a case that couldn't
  previously occur, now can) — without this, a background API call during what's now a staff session could
  still have carried the owner's Authorization header.

**Verified:** `npm run check`/`npm run lint` clean; ran every owner-console and staff-link-related test file
by name (`staff-link-open`, `signup-unified`, `owner-finance`, `owner-reminder`, `owner-storage-ui`,
`lint-globals`) — 62/62 passing, 0 failures.

## Zip 62 — closed the "tabs not synced" gap flagged in zip 61
Zip 61 shipped Phase 1 of the Hotel HMS with an honest caveat: the Tab Management `tabs` array (which the new
Folio checkout relies on) wasn't synced across devices at all. This closes that gap properly rather than
papering over it.

* **Root cause:** `tabs` was never in `collectSyncPayload()`/`applyRemotePayload()` at all — 100% local to
  whichever till created it. A naive fix (just adding it to the push/pull payload) would have made things
  *worse*, not better: the server's per-record merge only applies to fields explicitly listed in
  `MERGE_BY_ID_FIELDS` (`functions/api/_merge.js`), and `tabs` wasn't on that list either — so without the
  server-side change too, two tills would have started wholesale-overwriting each other's *entire* tabs array
  on every push instead of merging.
* **Fixed properly, both sides:**
  - `functions/api/_merge.js`: added `'tabs'` to `MERGE_BY_ID_FIELDS`, so the server now merges tabs
    record-by-record (each tab keyed by its own id) instead of blanket-replacing the array.
  - `src/shared/functions.js`: added `'tabs'` to the client-side `MERGED` set that mirrors the server's list
    (this is a genuinely shared, cross-module file — synced to all 8 apps via `npm run sync`, verified against
    the project's own test that asserts these two lists stay identical:
    `tests/e2e-revert.test.mjs` — "the client's list of per-record collections matches the server's").
  - `hotel/index.html`: registered `tabs` via the existing per-record dirty-tracking (`registerSyncedField`,
    same mechanism bills/customers/etc. already use, so it gets automatic `updatedAt` stamping for free), added
    it to `collectSyncPayload()`, and added it to `applyRemotePayload()` — guarded the same way tables/rooms/
    roomStays already are (only overwrite when the incoming payload actually has it), not the unconditional
    empty-array fallback bills/customers use: an open tab is exactly the kind of in-progress state a stale or
    incomplete pull must never wipe out.
* **What this does and doesn't fully solve, stated plainly:** different tabs (different rooms/tables) opened
  on different tills now correctly merge and appear everywhere. The one residual edge case: two tills
  appending *different orders to the exact same already-open tab* at the *exact same moment*, before either
  has synced the other's change, still resolves by last-write-wins on that whole tab record — same trade-off
  every other field in this merge system already accepts (bills, customers, products all work this way), not
  a new risk specific to tabs. A true additive per-order merge (like `stockMovementLog` gets for quantities)
  would need a bespoke merge function; didn't build that now, both because it's meaningfully riskier to get
  right blind and because the common case (one till manages a given tab's session) is what this actually fixes.
* Also noted, not fixed: closed/voided tabs currently accumulate forever with no pruning (unlike bills, which
  have `pruneClosedBills`) — a separate, smaller storage-growth item, out of scope for "sync this across
  devices."

**Verified:** `npm run check`, `npm run lint` clean. Ran the specific cross-check test this change depends on
by name and confirmed it passes, plus every hotel-specific and sync-related test file, plus a full pass through
every remaining test file not yet covered by name in zip 61's report — 296+ individual subtests across this
session, 0 failures.

## Zip 61 — Hotel HMS Phase 1: real lodging model (check-in/out, folio) — hotel module only
First phase of the larger Hotel & Restaurant Management System spec, built the way hospital's HMIS upgrade was:
an agreed phased plan, each phase shipped and verified on its own. This phase turns "Rooms" from a pure
dining-seat label into an actual bookable lodging unit, without touching the existing dining-reservation
system tables still use.

* **New: guest stays (`roomStays`)** — kept entirely separate from the existing per-room reservation fields
  (name/phone/party size/time/notes) used by dining tables, specifically because the shared `setLocStatus()`
  function (used by 5 modules) deliberately wipes `.reservation` on any non-"reserved" status change — exactly
  right for a table once seated, but it would have silently erased an active guest's stay the moment check-in
  marks the room occupied. A stay holds guest name/phone/ID, party size, check-in time, expected check-out
  date, nightly rate, an optional advance deposit, and an optional credit limit.
* **Check-In** (🏨 button on an available/reserved room) — a short form, then the room goes to occupied.
* **Check-Out & Settle Folio** (🚪 button on an occupied room with an active stay) — computes nights stayed ×
  rate, shows it alongside any Bar/Restaurant charges already on that room's tab, subtracts any deposit, and
  hands off to the existing tab-settle payment screen for the actual payment. Deliberately reuses the tested
  Tab Management settle path (a synthetic "Room Charge" line item folded into the same tab) rather than
  building a second, parallel billing engine — same receipt code, same payment validation, same stock/void
  handling as every other tab.
* **Room status**: added a `maintenance` state alongside the existing available/occupied/reserved/cleaning;
  checkout now correctly leaves a room in `cleaning` (needs housekeeping) instead of jumping straight back to
  `available`, with a "Mark Clean" button to finish that step.
* **Fixed a related pre-existing quirk** found while wiring this up: voiding a room's tab used to always reset
  the room to "available," even mid-stay. It now leaves an occupied lodging room alone if voiding just
  discards a round of charges rather than actually checking the guest out.
* `roomStays` wired into sync the same way the existing `roomStates`/`tableStates` are.

**Known limitation, not fixed this pass (flagging on purpose):** the underlying Tab Management `tabs` array
isn't currently synced across devices at all — a pre-existing gap, not introduced here. A guest checked in on
one till whose F&B orders get rung up on a different till won't show those orders in the folio total if
checkout happens on a third till. Left alone to avoid stacking more risk onto an already large change;
worth a dedicated fix before this feature is relied on across multiple simultaneous tills.

**Verified:** `npm run check` and `npm run lint` clean. Directly ran every hotel-specific test file
(`hotel-fixes`, `hotel-bills-quickview`) plus everything most relevant to what changed (`sync`, `pull-merge`,
`lint-globals`, `receipts`, `sales-and-print`, `two-devices`, `regressions`, `smoke`, `static`) — 164
individual subtests run this way, 0 failures. The full ~150-file suite kept getting cut short end-to-end by
this session's own execution-time limits (not test failures) before a final combined tally could print;
everything that did run passed.

## Zip 60 — fixed a real regression from zip 59, plus a test-suite blocker
Fixed the exact `npm test` failure reported (lint-globals flagging `EtimsOffline` as undeclared) and, while
re-verifying, found that one of zip 59's own fixes had broken something else — full honesty on both below.

* **Fixed: `water/index.html: EtimsOffline (line 28051)` — lint-globals test failure.** The lint tool only
  looks inside water's own inline `<script>` tags for where a name is declared — it can't see into the
  separate `etims-offline.js` file. My `typeof window.EtimsOffline` guard didn't count as a declaration to the
  linter (its operand is a member expression, not a bare identifier), and even a bare `typeof EtimsOffline`
  check only covers the one function it's written in — not the several separate functions in the Settings-panel
  glue code that reference it. Fixed with a single harmless `window.EtimsOffline = window.EtimsOffline;`
  self-assignment, which the linter recognizes as a real declaration and which changes nothing at runtime
  (confirmed `typeof EtimsOffline` still reads 'undefined' in the one place elsewhere that depends on it,
  `probeServer()` in src/shared/functions.js). This was failing since zip 57 — `npm run lint` (which only
  prints, never asserts) had been masking it, and I did not catch it via the full `npm test` run either time
  I claimed everything passed; that was a real error on my part, not a new issue introduced this zip.
* **Found and reverted a regression I introduced earlier this session, before it shipped.** While
  investigating "a bill/delivery sometimes isn't recorded," I added `bills` and `debts` to the same
  local-extras-preserved-on-pull merge that already protects `salesLog` — reasonable for salesLog (a genuinely
  append-only log that's never deleted) but wrong for bills/debts, which CAN be deleted (a settled bill is
  removed from the open list). That change made a locally-stale, already-deleted bill/debt get silently
  resurrected on pull, because it couldn't distinguish "the server hasn't seen this yet" from "the server
  deleted this." Caught by the project's own test suite (`shop app: a bill that is fully settled ... stays
  deleted`, `a debt row stays deleted`) before it was ever packaged — reverted in full, all 8 modules. The
  server already has a correct, tombstone-aware deletion mechanism for bills/debts (confirmed via the passing
  `a deleted record stays deleted: tombstone beats an older copy` test); the real protection for "a bill made
  right before a crash never reaches the server" is zip 59's unconditional push-before-first-pull, which
  doesn't touch deletion semantics at all and needed no changes.
* Also investigated: the "decimal quantity" bug on other modules — found and fixed an inconsistency in
  **school**, the only module where typing a decimal quantity was blocked by default (a real, if
  previously-deliberate, whole-numbers-only setting that didn't match the other 7 modules' unconditional
  decimal support); flipped its default to match the rest of the suite while keeping the toggle available.
  Also found that school's Sales Counter checkout markup doesn't actually exist in its HTML at all (the JS
  function is present but references DOM elements that were never built) — flagged, not fixed, since that's a
  build, not a bug fix.
* Cash-tendered auto-fill (water only so far): "Cash Tendered" now defaults to the running cart total, so a
  cashier taking exact cash can check out without typing anything, while still respecting a manually-entered
  amount. Not yet ported to the other 6 modules with a working Sales Counter — deferred to keep this zip to
  what's actually been re-verified end to end, given the regression found above.

Verified this time by running the actual `npm test` command directly (not just grepping its output) and
confirming, by name, that both previously-broken tests now show `ok`, alongside `npm run check` and
`npm run lint` (68 subtests, 0 failures).

## Zip 59 — the real "edits revert" fix, suite-wide, plus the actual decimal-quantity bug
Zip 58's audit found real bugs in the eTIMS code but hadn't yet found the root cause of "I change something
and it later reverts," which turned out to be architectural and present in all 8 apps, not eTIMS-related.

* **"Edits silently revert" — root cause found and fixed in all 8 apps.** Every editable list (inventory,
  customers, suppliers, delivery zones, offers, bills, debts, etc.) tracks "has this been synced yet?" by
  diffing the live record against a snapshot — but that snapshot is taken fresh from `localStorage` on every
  page load, which already contains whatever was last typed, whether or not it ever reached the server. So:
  edit something → it saves to the device instantly, then waits ~300ms before actually sending → if the tab
  reloads, the browser gets backgrounded and killed, or the connection drops in that window (very plausible
  on a shop tablet) → the in-memory "still needs sending" flag is lost, but the edited value is already in
  localStorage → on the next load, the dirty-tracking snapshot is taken FROM that already-edited state, so
  the edit now looks already-synced → the very next background sync silently overwrites it with the server's
  older copy. Fixed with one change, applied identically to every module: `startPolling()` now force-pushes
  whatever's on the device to the server once, unconditionally, before the first pull of the session is ever
  allowed to apply. A resend the server already has is a harmless no-op, so this costs nothing.
* **Decimal quantity bug — found (water/AquaPOS only): "Custom Refill — Litres Needed."** Typing a decimal
  (e.g. "0.5") into that field parsed correctly, but the resulting cart line had its quantity hardcoded to
  `1` regardless of what was typed — the decimal amount was baked into the line's internal size/price instead
  of showing as the quantity. Rewrote `addCustomLiterRefillToCart()` so the typed litres become the actual
  cart-line quantity against a fixed 1-litre unit; adding more custom litres now adds onto the same line
  instead of fragmenting into a new line per distinct amount typed.
* **Bonus crash bug found while fixing the above:** editing a custom-litres cart line's quantity afterward
  (the +/- buttons, or typing directly into the cart's qty box) looked up its size by `refillSizeId`, which
  is `null` for a custom-litres line — `size.sizeML` would throw. Fixed by reading `line.sizeML` (already
  stored on the line at creation) directly, in both `setCartQtyDirect()` and `changeCartQty()`.
* Investigated and ruled out a receipt-side rounding suspect (`formatQtyDisplay`/`isDecimalUnit`) — those
  functions aren't wired into water's shared-function list, so that code path is inactive there; not the cause.

Verified: `npm run check`, `npm run lint`, and the full `npm test` suite (66 tests) all pass after these changes.

## Zip 58 — two real bugs found and fixed in zip 57's offline eTIMS layer
Both found by re-reading the code with fresh eyes and confirmed with a fake-indexeddb simulation
(`node_modules/fake-indexeddb`, already a project devDependency) before shipping the fix:

* **Duplicate KRA invoice numbers.** `buildSaveSalesPayload()` computed `invcNo` as
  `keys.lastSaleInvcNo + 1` every time, but nothing ever advanced `lastSaleInvcNo` afterward —
  every offline sale before the next VSCU sync got the SAME invoice number. KRA would have
  accepted the first and rejected every one after it as a duplicate. Fixed with a new atomic
  `nextInvcNo()` counter (same IndexedDB-transaction pattern as the local receipt sequence),
  seeded once from VSCU's `lastSaleInvcNo` on Initialize and incremented on every call after that,
  online or offline. Verified: 3 consecutive offline sales now get 16, 17, 18 (not 16, 16, 16).
* **Clock-drift guard couldn't detect drift.** The original formula
  (`recordedAtDevice + offsetMs + (Date.now() - recordedAtDevice)`) algebraically collapses to a
  constant — it always reported the exact offset measured at the last sync, no matter how much the
  device clock was moved afterward. A cashier nudging the system clock forward 3 hours right after
  a sync would show zero drift. Fixed by tracking real elapsed time with `performance.now()` (a
  monotonic clock immune to wall-clock changes) since the last sync, then comparing that against
  `Date.now()`. Verified: no drift immediately after a sync, but a 10-minute clock shift introduced
  *after* the sync is now correctly caught.
* **Bonus fix (found while investigating the invcNo bug):** the hash-chained audit log had a race
  — `auditAppend()` read "what's the last entry" and wrote the new one as two separate steps, so
  two calls in flight at once could both read the same previous entry and fork the chain. Serialized
  with the Web Locks API (falls back to an in-tab promise chain where Web Locks isn't available).
  Verified: 6 concurrent `auditAppend()` calls now produce an intact, verifiable chain.

## Zip 57 — Offline-first KRA eTIMS (VSCU) layer, Aqua POS (water) only
Built as an ADDITIVE layer alongside the existing online eTIMS pipeline (Settings > eTIMS (KRA), which still
talks to KRA through our own server via `/api/etims-submit` and is unchanged). This adds the piece that was
missing: real offline capability when there's no internet at all, not just no response from our server.

* **New: `water/etims-offline.js`** — a self-contained module (own IndexedDB database, `aqua_etims_offline`):
  - **Opt-in toggle + config** — Settings > eTIMS (KRA) > "📡 Offline VSCU" panel: Enable switch, Control Unit ID
    (filled in automatically after Initialize), KRA PIN, API/Communication Key, Pay-Point ID, Device Serial,
    local VSCU address (defaults `http://127.0.0.1:8088`), Sandbox/Production.
  - **Talks to a real, local KRA VSCU install** — per KRA's own VSCU Specification Document v2.0, VSCU is a JAR
    KRA deploys on the shop's own network (same pattern as our print-helper bridge), not something we
    re-implement in-browser. This module calls its actual endpoints with KRA's real field names:
    `/initializer/selectInitInfo`, `/items/saveItems`, `/items/selectItems`, `/trnsSales/saveSales`.
  - **Local sequential numbering** — NS/NR/CN/DN/PR/TR, atomic per pay-point via an IndexedDB transaction, so a
    sale completes instantly with a real sequential reference (e.g. `00-NS-000123`) even with zero connectivity.
  - **Clock drift guard** — records a trusted server time (now fed by every `probeServer()` call across all 8
    apps — the shared function was updated, but this only does anything where `EtimsOffline` is loaded, i.e.
    water today) and blocks new eTIMS invoices if the device clock has since drifted more than 5 minutes.
  - **Salted local auth (PBKDF2 / Web Crypto)** — additive upgrade over the existing unsalted-SHA-256
    `pwHash`/`adminPwHash` flagged as a risk earlier in this project; doesn't replace the existing login path.
  - **Hash-chained audit log** — every config change, blocked sale, and sync event, with a `auditVerifyChain()`
    check to prove nothing's been altered.
  - **Item-master compliance gate** — OFF by default (so turning eTIMS on doesn't instantly block checkout);
    turn on "Require item tax classification" in Settings once products have real `itemClassCd`/`itemCd`/`taxTyCd`.
  - **Queue + sync manager** — FIFO per pay-point (never skips ahead, to keep KRA sequencing intact), a manual
    "Sync Now" button, and a background-sync hook (`sw.js` `sync` event, tag `etims-queue-sync`) that wakes an
    open tab to flush the queue when the browser supports Background Sync; a 15s foreground timer + `online`
    event cover browsers that don't (Safari, some Android WebViews).
* **`water/index.html`**: header network badge (Online / Offline - Invoicing Locally / Syncing (N pending)),
  non-blocking checkout hook (`etimsOfflineRecordSale`, called alongside the existing `submitSaleToEtimsIfEnabled`
  — neither ever blocks or slows down `checkoutCart()`), and a COPY watermark on any receipt reprint (uses the
  existing `sale.printedAt`/`markReceiptPrinted()` tracking — no new state needed).
* **`water/sw.js`**: added `etims-offline.js` to the cached app shell; new `sync` event listener.
* **`src/shared/functions.js`**: `probeServer()` now also feeds the eTIMS clock-drift guard a server timestamp
  whenever it successfully reaches the backend — synced to all 8 apps, but only acts where `EtimsOffline` exists.

**Not yet done / next steps:** exact KRA QR-code verification URL should be confirmed against your OSCU/VSCU
onboarding pack before go-live (the builder uses the publicly documented pattern but KRA has adjusted this
before); `requireItemClassification` gate not yet wired to the Inventory add/edit form (needs `cacheItemForEtims()`
called there); not yet ported beyond water/AquaPOS.

## Aqua POS (water): each site has its own bulk tank
* Production and every Shop branch have their own tanks. Refills, sales and bulk orders draw only from their own site.
* Existing water stays with the Shop; Production / new branches start with an EMPTY tank (record a delivery, or set
  "Level now"). Level corrections are logged in the refill history.
* Tanks sync per record (`pos-sync.js`), so a stale device at one site can't overwrite another site's level.

## Server: size guard, compression, abuse limits
* `pos-sync`: refuses a shop > 24 MB (raw) with a clear 413 message (the apps now show it); shops >= 6 MB are stored
  gzipped automatically (lossless); push reply is slim; size + last writers (IP/country) kept in KV metadata.
* Owner Console -> 💾 Storage: every shop's size, alerts (tab badge), Measure / Compress / Uncompress, "Compress all large shops",
  and a list of shops that hit the SMS / M-Pesa hourly caps.
* Per-shop hourly caps: SMS 1500 recipients, M-Pesa prompts 60 (env `SMS_HOURLY_LIMIT`, `STK_HOURLY_LIMIT`).
* CORS on `pos-sync` limited to the shop's own domain family (no more `*`).
* Backups of big shops are gzipped too.

## Apps
* 413 "too large to sync" notice (all 8 apps). Password hashing: the 32-bit fallback is now real SHA-256.

## Tests / docs
* New: water tanks, storage/size/compression/CORS/rate-limit, owner Storage UI, 413 handling, SHA-256, two-device sync,
  and money invariants through the real checkout of 6 apps. Test boot wait cut from a flat 1.2 s to ~0.45 s.
* `STAGING_SETUP.md` (exact steps), updated `SCALE_PLAN.md` / `SYNC_AUTH_DESIGN.md`.

## Zip 25 additions — storage
* **Device storage compression** (all 9 apps, `src/shared/blocks/storage-compress.html`): big localStorage values are stored
  compressed in 60,000-char slices (lz-string). Measured ~8x smaller on real sales data; a sale recompresses only the last slice.
  Failed saves roll back; "storage full" drops the regenerable `:prev` copies and retries; the Settings meter shows REAL usage.
  Existing (uncompressed) data is read as before and compressed on its next save.
* **Delta push:** sales, stock movements, returns, expenses, attendance, admin activity, dispatch and trade credits are sent as
  new/changed records only (the server already merged by id). First push after opening the app still sends everything.
* **Server limits re-measured:** memory, not KV's 25 MiB, is the ceiling (~6-8x raw size per push). Defaults are now 4 MiB "Large",
  12 MiB refused, 8 MiB auto-compress.
* **Archive old history** (Owner Console -> Storage): move records older than N days into a verified gzipped archive; download or
  restore it later. This is what actually shrinks a shop.

## Zip 26
* **Server-verified logins: dropped** (sign-in must work offline). `SYNC_AUTH_DESIGN.md` now records that decision and what was done instead.
* **Less copy-paste:** `tools/promote-identical.mjs` moved 49 functions that were identical in every app that had them into
  `src/shared/` (shared functions 673 -> 723). It only moves a function when it is provably safe (same normalised source everywhere,
  declared once, in the same script block as the shared region). Run `node tools/promote-identical.mjs --dry` to see what's left.
* `checkoutCart` is still 8 different copies on purpose: they differ by real features (card payments and promotions exist only in
  Shop, gas refills only in Shop/Services/Production, due dates in Services/Pharmacy...). Unifying it needs hook points and broader
  tests first; the money tests added in zip 24 are the start of that safety net.

## Zip 27 — storage is never the client's problem
* **Automatic server archive:** when a push would leave a shop at 80% of the size limit, the server archives old history in the same
  request (keeps the newest 90 days, or 60/30/14/7 if more is needed, to get under 60%), writes a verified gzipped archive, and keeps an
  index of archived ids so a device that re-sends old records can't bring them back — while a back-dated NEW record is never dropped.
* **Automatic device archive** (all 8 shop apps): at 80% of the device's storage (or the instant a save fails for lack of room) the oldest
  history moves to an IndexedDB archive first, and only then leaves the everyday lists; the failed save is repeated. Nothing is removed if
  IndexedDB isn't available. Settings shows a small "older history was moved…" line with a Download button.
* **No storage messages for staff:** removed the "device is low on storage" toast, the 80% warning, the "optimised photos" toast and the
  "too large to sync" toast; a 413 no longer shows as a sync error. Only an ADMIN is told, and only if nothing at all could be freed.
* Owner Console: "Large" shops need no action (info line only); only a REFUSED shop gets a red badge. Automatic archives are labelled.
* Trade-off (by design): after an archive, tills and phones show only the recent history in reports until an archive is restored (server:
  Owner Console -> Storage -> Archives; device: the archive is kept in the browser and can be downloaded).

## Zip 28 — the long-term fix: a per-shop database (opt-in)
* `wildcard-router/shop-store.js`: SQLite-backed Durable Object per shop. Rows instead of one JSON record -> no size ceiling, nothing archived away.
* Merge rules moved unchanged into `functions/api/_merge.js`; both backends verified equal by side-by-side tests.
* `pos-sync` routes a shop to its database when the owner moves it (Owner Console -> Storage -> 🗄️); `/api/history` serves any date range, paged.
* Migration is verified, reversible, keeps the old record as a rollback, and pauses pushes (503, devices retry) only while it runs.
* Devices merge a recent-window pull with the history they already hold (`preparePulledPayload`, all 8 apps).
* Not built / untested: see `SCALE_PLAN.md` (status after zip 28) and `STAGING_SETUP.md` (database section). Nothing changes for any shop until you move it.

## Zip 29
* **Older history on new devices:** background fetch from `/api/history` (`hydrateOlderHistory`), bounded and once per install; fetched records are marked
  acknowledged so they aren't pushed back. The database now tells devices where the recent window starts (`_hotFrom`).
* **Instant sync for database shops:** the server sends a bare poke over the WebSocket; all 8 apps pull when they get one. Older cached apps ignore it.
* **CORS:** `functions/api/_middleware.js` removes `Access-Control-Allow-Origin: *` from every API response for other websites (own domains, subdomains and localhost still work).
* **Staff login links:** an "Open" button next to Copy/Link in every app.
* **Aqua POS stock requests:** confirmed working end to end (request -> Production bell with who asked -> dismiss) and now merged per record on the server so two tills' requests both survive.

## Zip 30
* **🧪 Test the database** (Owner Console -> Storage): runs the per-shop database through a whole shop's life on a throw-away copy on the REAL Cloudflare runtime and
  reports every step. It is the quickest way to find out whether anything my Node stand-in imitated behaves differently there.
* **Stock-revert fix:** a device that re-sends an earlier inventory record (a retry after a lost reply) can no longer put an old stock count back; a real stock
  edit is unaffected. Fixed once in the shared merge, so it holds for both storage backends; proven by tests that fail without the fix.
* Deliberately NOT done: delta pull in the apps. The database path has not yet been proven on real Cloudflare; adding more untested client logic on top of it first
  would make any staging failure harder to pin down. Do it after the self-test is green and one staging shop has run for a few days.

## Zip 31 — "I changed it, refreshed, and it was back"
Reproduced end to end (`tests/e2e-revert.test.mjs`: a real app + the real server code) and fixed two causes that existed before the zips above:
1. **Old copy overwrites a setting.** ~40 settings (receipt text, VAT rates, tab locks, loyalty tiers, hotel tables/rooms, ...) were one whole value each and the LAST PUSH
   WON, so a till that hadn't refreshed put back what another till had just changed. Now each till stamps the settings it actually changed (`_fieldTimes`); the server
   replaces a stamped setting only with an equal-or-newer stamp. Same rule in both storage backends (`functions/api/_merge.js`, `wildcard-router/shop-store.js`).
2. **A pull landing on an unsent edit.** For ~1 s after an edit (300 ms wait + send), a poll or live push could apply the server's older copy over it, losing it for good.
   Now a device sends its unsent changes FIRST and only then applies anything from the server; if it can't send them it keeps them and skips that pull. Failed pushes
   are retried by the poll with a growing pause (4 s .. 1 min), so a refused shop doesn't re-send itself every few seconds.
Also checked: plain edits (price, stock) survive a refresh online, offline, refreshed-at-once and with pushes refused.
Deploy note: old cached apps don't stamp settings, so a setting changed from an OLD app can lose to a stamped value until that app updates (they update on their own within a day or so).
If clients on zip 24+ with big shops report reverts, ALSO check the Owner Console Storage tab for "refused" shops — a refused push looks like a revert.

## Zip 33 — deployment config
* `wrangler.toml`: live KV namespace id filled in; every environment variable/secret the server reads is listed in comments (none are stored in the file).
* `wrangler.staging.toml`, `wildcard-router/wrangler.staging.toml`, `npm run deploy:staging|deploy:router|deploy:router:staging`: a staging deploy is made from a temporary copy
  with its own KV namespace and its own Durable Objects, and refuses to run if it would use the live KV id.
* **Internal files are no longer public.** `wrangler pages deploy .` uploads the whole folder, so the live site could serve `tests/`, `src/`, `tools/`, `*.md` (including the design notes),
  `package.json` and `wrangler.toml`. The top-level middleware now answers 404 for them; every app, icon, manifest, service worker and the public site is unaffected (`tests/internal-paths.test.mjs`).
* Checked with Cloudflare's own bundler: the router Worker (with the ShopStore class) and all Pages Functions compile.

## Zip 36 — Owner Console storage tools
* **🖼️ Shrink photos** (per shop): the usual reason a shop is huge is product photos stored inside items (a phone photo can be 500 KB+). The Owner Console lists a shop's big photos,
  shrinks them in the browser (max 400 px, JPEG) and sends only smaller ones back, in small batches; every device accepts them (new stamp) and a stale device can't put the big ones back.
  Works for single-record and database shops.
* **🗄️ Move all to database**: moves every single-record shop one after another (each verified, each with a rollback copy); skips shops over 10 MB (shrink photos first) and reports failures without stopping.
* Data left behind by deleted links is no longer listed in the Storage tab.

## Zip 37
* Shrink photos is memory-light for very large shops (24 MB+): decoded copies are released early, the write uses KV's own write-time stamp to detect a device push that landed meanwhile (no second
  24 MB download), and the result is written plain when it fits (no extra gzip copies). Tested, including the "push lands meanwhile -> refuse, never overwrite" case.

## Zip 38
* Storage tab lists PERMANENT links only: demo links, deleted links (leftover data) and the owner's own account never appear in the list, the alerts, the totals, the rate-limit list or "Move all to database".

## Zip 39
* **Pharmacy now has the same sign-up as the Shop** (it was the only module still on the old one): full name, business, phone, email and ONE password with Log In / Sign Up on first open, claimed-link
  auto-login, and one Change Password (sets the till AND management password to the new one). Existing users are untouched: their two stored passwords keep working until they use Change Password.
  All 8 modules are now checked by a test to have identical sign-up fields and the unified Change Password.
* **Permanent = database.** A NEW permanent link starts in its own database; a demo link that is confirmed as permanent is moved into the database with all its data (verified, rollback copy kept; if the move
  fails the link is still made permanent and stays a single record). Demo links stay single records.
* **Every link is measured automatically** in the Storage tab (idle shops with no size yet are measured in the background, one at a time; active shops record their size on every save).
* **"Who's logging in?"** list is no longer torn down and rebuilt when the background sync lands and nothing changed.

## Zip 40  (DEPLOY THE ROUTER FIRST: `npm run deploy:router`, then `npm run deploy`)
* **Deleted things stay deleted.** A bill settled and removed from the list, a debt, supplier, inventory item, delivery zone, recurring expense or offer that is deleted on one device
  is now sent to the server as an explicit deletion marker (tombstone). A stale device can't bring it back, other tills drop it, a brand-new device never sees it, and it survives a refresh.
  Safety net: a list that suddenly loses most of its records is treated as a reset, never as mass deletions. Existing shop databases are upgraded in place (`del` column).
* **A push can no longer hide another device's change.** After pushing, a device used to mark itself "up to date" even when the server had merged in a change from another device it had
  not seen; that change stayed hidden until someone else pushed. The server now reports what it held before the push and the device pulls when it missed something.
* **Owner Console gets both fixes** (it has its own older sync code): a settled/removed bill stays gone; a push can't hide another device's change.
* **Owner income model.** Making a link permanent adds nothing to sales or bills (no amount prompt, no placeholder bill). Under each PERMANENT link (open the link's detail) a 💰 toggle opens
  "Money agreed / Money paid": the paid amount is logged as income; any balance becomes a bill with agreed/paid/balance details, settle in full or in part, and a 🔔 Remind admin button.
  Recorded once per link (the toggle then shows On and locked).
* **Payment reminders** reach the admin of that link as a banner in the POS (all 8 apps; admin only; stays until OK), delivered with the license check (~30 s) and acknowledged back to the owner ("seen").
* **🖼️ Shrink all photos** button in the Storage tab: every permanent link, one after another.

## Zip 41  (Hotel/Restaurant/Bar only — deploy the SITE, no router change)
* **Dishes always sell.** Ingredient stock / missing recipes never block a dish or mark it out of stock. Ingredient stock may go below zero (shown as "short by X"); a void puts back exactly what was taken.
* **Inventory "Used" column** (next to Qty Remaining): what dish sales have consumed of each ingredient, from the recipe as it was at the time of the sale. Sales add, voids subtract, never shown below 0.
* **🍳 Kitchen tab** (right after Sales Counter, assignable to staff): Shelf Life (days, default 1), Servings Prepared (optional batches: log / correct / close out), Servings Sold (automatic, always tracked;
  today's sales when nothing is prepared), Servings Left (= Prepared - Sold, "Untracked" when nothing prepared). Multi-day batches stay active until they expire or are all sold; a finished pool is closed
  when new portions are logged. Voids (sale, un-void, whole tab) re-credit Sold, Left, Used and ingredient stock.
* Stored as small 'kitchen' entries (delta 0) in stockMovementLog: no schema change, syncs between tills like any log, ignored by stock reports and server stock reconciliation.
* Not backfilled: Used and Sold count from deployment onward.

## Zip 42  (Hospital app: variable dosing + dosage instructions + sectioned receipt. Deploy the SITE only.)
* **Variable dosing** on a box/pack item that is also sold by the piece (Add item form and the item's edit window): `Allow selling loose pieces`, base unit name, minimum pieces per sale, allowed dose packs
  ("4, 6, 12, 24" or labelled "Child Dose=4, Full Pack=24"). A quantity is valid when it is at least the minimum and is made of allowed packs (8 = 4+4, 10 = 4+6). The first loose add is the minimum
  dose, +/- step through allowed quantities, typing an invalid quantity is refused with the allowed packs listed, quick-select dose buttons sit under the item, and checkout re-checks every piece line.
  "Whole boxes only" removes loose sale entirely. Stock is still counted in base units (6 from a 24-tablet box opens one box and leaves 18 loose).
* **Dosage instruction** (optional, e.g. "1 x 3 for 5 days") under every stocked item in the cart with quick chips; stored on the sale line and printed as `--> Dose: ...` on the on-screen, printed and
  USB/Bluetooth receipts (shared receipt builder; only appears when a line has one).
* **Sectioned receipt**: when a sale has both hospital fees and dispensed items they are listed under "SERVICES & HOSPITAL FEES:" and "DISPENSED MEDICATIONS:" (Hospital only; other apps unchanged).
* Not in this zip: patient bill aggregation / unified counter payment, lab-test pricing, pharmacy-app parity, dispensing labels, a Department column for services.

## Zip 43  (Hospital: visit references + the cashier's patient bill. DEPLOY THE ROUTER FIRST (`npm run deploy:router`), then the site.)
* **Tests made deterministic.** The deletion / missed-change / kitchen two-till tests waited fixed times for timers; on a busy machine (the whole suite runs in parallel) they could fail although the app
  was right, which stopped `npm run deploy`. They now await pushes/pulls directly and poll for the few asynchronous things.
* **Every hospital visit gets a reference** (V260921-4F2K), shown on the visit form and after saving. A patient-billed visit files what it costs as UNPAID charges under that reference — consultation fee,
  procedures / nursing / other fees (picked from the Services list, new rows on the visit form), lab tests (priced from the Services list by name) and the medicines prescribed (with dose-pack quantity and
  dosage). Nothing is charged and no stock moves at the visit. "💵 Take payment now" on the visit form keeps the old immediate sale.
* **Sales Counter -> 🏥 Patient bill**: type the reference, patient number or name (or tap the waiting list) and the whole bill loads into the cart (dosage, dose packs, fees). One payment (cash, M-Pesa,
  card, split) pays it all; stock comes out with that sale; every line is marked paid; a paid lab test shows "💳 Paid — ready for sample". Refused if the cart is busy or stock is short. Put on Pay Later
  the lines are marked billed (not loadable twice). Voiding the sale reopens the bill; restoring it closes it. Receipts carry "Patient Ref:".
* Tests requested from the Laboratory tab get their own reference and go to the cashier.
* Services list has a Department column (Consultation, Laboratory, Radiology, Procedures, Nursing / Ward, Dental, Pharmacy, Other).
* New synced collection `patientCharges` (one small record per line; merged per record on both storage backends).
* Not built: dispensing labels, insurance split at the counter (institution visits keep their account flow), Pharmacy-app parity.

## Zip 44
* **Pharmacy Sales Counter now has the dosage box too** (Hospital had it since zip 42): an optional dosage under each stocked item in the cart with quick chips (1 x 3, 1 x 2, 2 x 3, 1 x 1), saved on the
  sale line and printed as `--> Dose: ...` on the on-screen, printed and USB/Bluetooth receipts. Tested end to end in both apps. (Dose-pack rules and the cashier patient bill remain Hospital-only.)

## Zip 45  (Shop app: dual-unit measurables — a bag AND loose kilograms)
* **Loose unit** on a package item that is also sold loose (Add item form + edit window): pick what one "piece" is (kg, g, l, ml, m ...). Pieces per bag and loose stock now take decimals (a 25.5 kg bag, 12.5 kg loose).
  Loose price: leave blank = bag price / pieces per bag (800 / 50 = 16 per kg) or type your own per-kg margin.
* **Cart / search / receipts speak the unit**: "Cement (50kg bag)" in bags, "Cement (Loose kg)" in kg, with the quantity carrying its unit (10bag, 3kg, 2.5kg). Items without a loose unit keep "(Box)" / "(Piece)".
* **Unit toggle on every dual-unit cart line** (📦 bag | ⚖️ kg): flips the line keeping the same amount of goods (2 bags = 100 kg, 3 kg = 0.06 bag); decimal bags (0.25) sell too.
* **One stock balance**: bags x units + loose. The inventory table shows "29 bag + 47 kg (1,497 kg in all)"; selling anything (bags, kg, fractions of a bag) moves that one balance.
* Shop app only for now (Hotel/Hospital/Pharmacy/Production/Services have the older Box/Piece dual unit).

## Zip 46  (Gas Refill tab, in the Shop, Production and Services apps — one shared implementation)
* **A simple stock board**: one row per cylinder size with FULL and EMPTY counts you can type into (13kg 20 / 5, 6kg 31 / 8), plus "with supplier" and the total, and the three prices (full cylinder, refill, empty
  cylinder) in the same row. Totals by state at the top (Full / Empty / With supplier / All cylinders). Adding a size takes a size and two counts; brand is optional. Every cylinder is an ordinary inventory item
  ("13kg (Full)", "13kg (Empty)") and shows in Inventory; a typed count is logged as a stock adjustment.
* **Four ways to sell**, one tap each, all as normal Sales Counter lines: 🔄 Refill/Exchange (full -1, empty +1 at the refill price), 🛢️ Full cylinder (full -1), 📦 Complete set (full -1 + the accessories you tick,
  with how many per set), ⚪ Empty cylinder (empty -1). A void puts everything back.
* **Accessories are ordinary inventory items**, sold at the Sales Counter like any item; mark the ones that go in a set from the Gas tab (no separate accessory stock to maintain).
* **Cylinders with the supplier are counted**: sent empties (Empty -, With supplier +), refilled ones received (Full +, With supplier -), or swapped on the spot. The number of cylinders you own is always visible.
* **Fixed (Shop app): every refill/exchange added TWO empty cylinders instead of one** (the empty was credited in two places). Now once.
* The old gas tab (variant manager, separate accessory manager, single burner/holder pickers) is replaced. Existing sizes and accessories carry over.

## Zip 47  (fixes for the errors the shops reported — Owner Console -> Errors)
* **"Cannot read properties of undefined (reading 'length')"** (owner, shop, services, hospital: 15 of the 21 groups): the barcode-scanner keydown handler read `e.key.length`; some keyboards / autofill send a keydown
  event with no `key`. Guarded in every app (and the Owner Console).
* **"Cannot read properties of undefined (reading 'toFixed')"** (Shop, one shop): an item saved without a price made `getEffectivePrice()` return undefined, and every place showing a price threw. It now always returns a
  number, and every place that showed a bare `item.price` / `line.price` / wholesale / piece price with toFixed is wrapped to a number (129 places across the apps).

## Zip 48  (DEPLOY THE ROUTER FIRST: `npm run deploy:router`, then `npm run deploy`)
* **The Online / Syncing / Offline badge tells the truth and recovers by itself.** Causes fixed: a 3.5 s limit on every pull (a slow line or a cold server ended in "Offline"; several hard refreshes were needed); a retry wait of
  up to 60 s after a failed save during which the badge was never re-checked; navigator.onLine believed as fact; saves with no time limit (a stalled one sat on "Syncing…" for minutes); server errors labelled "Offline".
  Now: the badge follows whether the server actually answers (a tiny check); pulls get patience (45 s first pull, 12 s polls, doubling up to 90 s while the server is reachable); a dropped connection ends the retry wait the moment
  the server answers; saves give up after 40 s; a server error is "Sync Error"; the wait is capped at 15 s and is kept only for pushes the server ANSWERED and refused. Shop, Hotel, Hospital, School, Production, Services,
  Pharmacy, Aqua POS and the Owner Console.
* **Printers reconnect by themselves** (USB and Bluetooth, all apps): the last-used printer is looked for again whenever it is not connected (after a power cut, switch off/on, unplug, out of range, app reopened) and connected the
  moment it is there; if it is not there it keeps checking (3 s, slowing to 30 s). USB claims ONLY the remembered printer (never another permitted USB device); Bluetooth reopens the same printer without the chooser (and, where the
  browser supports remembered devices, after a reload, and the moment it advertises). A print right after the printer was switched on finds it (up to 4 s); a link that drops before the first byte is reconnected and the receipt sent
  once; one that drops part way is NOT re-sent. Every write has a 15 s limit so a stuck printer cannot block later prints. The shared print relay keeps its ON setting while the printer is off (it used to switch itself off for good).
  System-dialog printing has nothing to connect and is unchanged.

## Zip 49  (tests only — no change to the apps)
* `npm test` failed on the owner's machine at "a save that runs out of room ... the device archives and the save goes through". The test waited a fixed 1.5 s for the archive to finish; with the whole suite running in
  parallel the machine was many times slower and it had not finished. That test, the debounce-push waits in e2e-revert, and the waits in owner-storage-ui, regressions and usb now poll for the result instead of sleeping.

## Zip 50  (DEPLOY THE ROUTER FIRST: `npm run deploy:router`, then `npm run deploy`) — includes zips 48 and 49
New options
* **⏸️ Hold sale** on the Sales Counter (Shop, Hotel, Hospital, Production, Services, Pharmacy, Aqua POS): one sale can be held at a time per device; **▶️ Held¹** brings it back
  (lines, typed customer details and payment method). Nothing is deducted while it waits.
* **Record a Past Sale** takes every payment method: cash, M-Pesa (code + payer), card (reference), split (cash + M-Pesa, must add up) and bill (Pay Later: goes to the Bills tab dated then,
  with anything already paid recorded as a partial payment).
* **Restock and Orders**: items at or below the low-stock level show as tappable buttons; a tap adds the item to the form with its last cost and the cursor in the quantity box ("Add all" too).
  Orders have a **💬 WhatsApp** button and **Save & send on WhatsApp** in the form (the supplier's number is asked once and remembered).
* **📋 Stock Take tab** (all shop-type apps): type what you counted; differences are valued at cost; only counted items change; every change is logged as a "Stock take" adjustment
  (loose pieces counted separately); recent stock takes are kept on the device.
Fixes
* **Settled bills are kept** (closed) and show under "Show closed bills" instead of being deleted the moment they are paid (all six apps with bills); closed bills older than 90 days are tidied away.
* **Bills only move forward on the server**: a settled bill / a payment can never be undone by an older-looking copy from a slow till, and a deleted bill / debt / supplier / delivery zone / recurring expense /
  contract stays deleted even if a till that still holds it touches it (the cause of "a settled bill came back after a refresh").
* **Order ticket on the system printer**: receipt-width, auto-length page (it used to use a full page, wasting paper) and pure black heavy text like the sales receipt (it was blurred).
* **Printing is fast**: a system-dialog print no longer waits on a network check (remembered 30 s, at most 1.2 s wait), and the print queue moves on if a phone never reports a print finished.
* **The sync indicator is a wordless dot** (green online, black offline, orange syncing) that does not flicker: quick syncs never turn it orange, blips never turn it black.
* **Bug scan** (`npm run lint`, also part of `npm test`): finds names used but never declared and buttons calling functions that do not exist. Fixed what it found: Aqua POS carried purchasing code
  it does not use; Hospital / Pharmacy / School threw and swallowed an error on every sync for lists they do not have; the Owner Console called printer code it does not have.
* Tests: the loader no longer stretches its waits (it made multi-device tests twice as slow); fixed waits in five test files are polls.

## Zip 51  (tools only — no change to the apps)
* The bug scan (`tools/lint-globals.mjs`, run by `npm test` and `npm run lint`) built its file paths from `URL.pathname`, which on Windows is `/C:/dev/...` and became `C:\C:\dev\...`, so its 9 tests
  failed there (549 of 558 passed on Windows; everything else was green). It now uses `fileURLToPath`.

## Zip 52  (includes 50 and 51; DEPLOY THE ROUTER FIRST: `npm run deploy:router`, then `npm run deploy`)
* **Aqua POS — sales that never showed in Daily Sales**: a sale / payment / batch made while "Both sites" was selected was stored against a site called "both", which no single-site view matches. It is now stored against the
  Shop site, and old records stored as "both" are shown with the Shop. (Shop / Hotel / Pharmacy: every payment method is recorded and shown; Pay Later bills stay out of Daily Sales until paid, by design.)
* **Print is one print per receipt**: taps while a print is going are ignored (auto-print + a tap prints once); when the print worked the preview closes; the sale remembers `printedAt` / `printCount`; printing the same
  receipt again asks "already printed at HH:MM — print another copy?"; a failed print keeps the preview open. On a computer the cursor goes back to the search box after the preview closes.
* **Aqua POS — adding a refill size** now shows in the Refill Prices list at once, is saved on the device, and a duplicate size is refused.
* **Owner Console — staff are not asked for the owner's email**: a staff invite / staff link opens the PIN sign-in (links now carry the shop `?c=`); copy fresh links for existing staff. The owner still signs in as before.
* **"Webpage not available"**: every service worker now waits for a slow network when nothing is cached, shows a friendly self-retrying page when fully offline, and falls back to the network if the Cache API fails.
* **The login popup no longer reappears** over a running session when the first sync finishes late.
* **"Customer N"** above the reference number on every receipt, restarting each day (Pay Later customers count; payments on old bills and past-day records do not).
* **Restock and Order name boxes** drop down your inventory as you type (pick to fill code, unit and last cost; a new name stays typed).

## Zip 53  (Hotel POS + the AI reader; includes 50 - 52. If those are not deployed yet: `npm run deploy:router` first, then `npm run deploy`)
* **A menu becomes Dishes.** Hotel POS only.
  * *Excel / CSV* (Inventory ⬆️ Import from Excel/CSV): an **Item Type** column (Dish / Item, per row) is understood; a sheet with only names and prices defaults to Dishes; a stock sheet with quantities stays Items. The review has a new
    **"Add these as: Items / Dishes"** choice (Dishes hide Qty / Cost / Wholesale and show Price); Dishes are created with no stock (they sell by price), keep their Category, and re-importing updates prices instead of duplicating.
    A dish with no price is refused with the names listed.
  * *Photo* (Add New Items ▸ 📸 Capture List): the AI reader now recognises a **menu** (dishes, each with one price, no quantities) and reads the printed price as the SELLING price (a "KSH 50" used to be read as a buying cost) and the
    section heading as the Category; there is a **"This is a menu / price list — add it as Dishes"** tick to tell it so. Restock captures are unchanged.
  * Server: `functions/api/_capture-shape.js` (new) shapes the AI's answer (items / recipe / menu); `ai-capture-list.js` prompts for KIND 3 (menu) and accepts `mode: 'menu'`.

## Zip 54  (includes 53; `npm run deploy:router` first if zips 50-53 are not live, then `npm run deploy`)
Speed
* **Sales Counter items grid**: "units sold per item" was a full pass over the whole sales log for EVERY item on every redraw (search keystroke, sale, sync); now one remembered pass.
* **Opening an app no longer re-downloads the whole page** (1-2 MB): the service workers revalidate ('not changed' = a tiny reply) instead of forcing a full reload, and no longer rewrite the offline copy on every open.
* Bursts of `renderAllViews()` calls fold into one redraw; the customer-number scan skips old sales cheaply.
New
* **📊 Reports tab** (all shop-type apps): Sales, Business insights (busiest hour / day, best-earning hour, best worker, sales by hour and weekday, daily / weekly / monthly trend lines), Staff performance, Stock,
  Bills & debts, Expenses & profit — any period, Print / PDF and CSV for Excel, shortcuts to the detailed screens.
* **Hotel: cash tendered is optional but recommended** (empty = exact amount; a typed amount must still cover the total).
* **Importing a file**: a "please wait" banner while it works; headers the app already knows skip the AI (instant, works offline); the AI column reader is capped at 8 s. Re-importing a menu turns dishes that were
  imported as ordinary items into Dishes (same codes, no duplicates).
* **WhatsApp → Leads (Meta ads only)**: `api/whatsapp-webhook.js` (+ `_whatsapp.js`) files people who START a chat from a Meta Click-to-WhatsApp ad (Meta marks those messages with a `referral`) as a lead on the Leads tab, with the ad's headline;
  follow-ups from that person are added to the same lead; ordinary texts from anyone else are dropped and never stored. See WHATSAPP_SETUP.md (needs a Meta app + two secrets; business number +254 791 598 506).
Fixes
* **Staff listed twice on "Who's logging in?"**: a double tap on "Create my account" (or the same invite on two phones) made two records. The staff id now comes from the invite (one invite = one person), taps are handled
  one at a time, and exact duplicates already saved (same name AND same PIN) are merged deterministically on every device (the larger id is retired, its shifts move). Owner Console included.
* Share receipt: on browsers that cannot hand a file to another app the PDF is saved (by design); the message now says so clearly.

## Zip 55  (includes 54; `npm run deploy:router` first if zips 50-54 are not live, then `npm run deploy`)
* **📖 User guides — one per module** (Shop, Hotel, Hospital, Pharmacy, School, Production, Services, Aqua, Owner Console): getting started, first setup, adding items, making a sale, payments, receipts, bills, restock / orders / stock take,
  reports, staff and access, connecting printers, offline / backups, troubleshooting, plus module chapters (hospital patient journey, hotel dishes / kitchen / tabs, school fees, Aqua tanks and sites, hiring, service jobs, owner links / leads / errors)
  and "Every tab at a glance". Open from the 📖 button in the header, Settings ▸ Guide, or Settings ▸ Install App ▸ Version. Searchable, printable.
  Text: `tools/build-guides.mjs` (`npm run guides`, then `npm run sync`); viewer: `src/shared/blocks/guide-ui.html`; per-module data: `src/shared/blocks/guide-data/<module>.html` (the sync tool now supports per-module block content).
* **Settings ▸ Install App ▸ Version** reads **Version 1.0.0 — The best software in existence.** (the build line stays underneath).
* Test: `tests/guides.test.mjs` (every tab of every app is described in its guide; opens three ways; search; print; each guide is about its own module).

## Zip 56  (includes 55; `npm run deploy:router` first if zips 50-55 are not live, then `npm run deploy`)
* **Stay signed in on this device** (`src/shared/blocks/session-keep.html`, every app incl. Aqua POS and the Owner Console): the "Who's logging in?" picker came back after ANY page reload (a phone dropping the app when you switch to
  WhatsApp / printer / camera, an installed app reopened, a refresh, an update) because the login lived only in memory / the tab. A successful login (Admin or a staff member's PIN) is now remembered on the device — never the password —
  for 12 hours after the last tap. Ends on Clock out / switch user, password change, staff removed or locked for the day, 12 h idle, or Settings ▸ Security & Access ▸ "Stay signed in on this device" turned off.
* **Phone layout** (`src/shared/blocks/mobile-cards.html`, every app): under 700 px wide, tables with 4+ columns (Inventory, Store, Bills, Daily Sales, Stock Report, Restock, Orders, Debts, ...) are shown as cards (item name as the title,
  labelled lines, buttons at the bottom; rows drawn later are labelled as they appear); 16 px form fields (no zoom-on-tap on iPhone), bigger touch targets, toolbars wrap. The Sales Counter cart and 2-3 column tables are unchanged; computers unchanged.
* Tests: `tests/stay-signed-in.test.mjs` (7), `tests/mobile-cards.test.mjs` (5).
