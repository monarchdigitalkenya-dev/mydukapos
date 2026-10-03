# Zip 115 — Automatic Daily Report, Audit-tab guide fix, version reset to 1.0.0 + Update Log

## 1. Automatic Daily Report (spec sections 27-30), root + hotel, hospital, production, services, pharmacy
New "⏰ Automatic Daily Report" panel in the Reports tab:
- On/off toggle, a time picker, and a choice between "generate the missed report when the POS is next
  opened" vs "only ever print at the scheduled time — skip if missed."
- Checked every 60 seconds and immediately whenever the tab becomes visible again, so a device that was
  asleep or closed at the scheduled time still gets a chance to catch up under "generate on return."
- Generation and printing are tracked separately: the report always gets generated and logged even if
  printing fails or is blocked (statuses: printed, print-failed, print-blocked, generation-failed) — the
  spec's own requirement that a print failure must never hide that the report was produced.
- Never duplicates — one report per business date, enforced before generation runs, verified even under
  repeated scheduler ticks.
- Fixed `reportsPrint()` (a widely-used existing function) to actually report success/failure instead of
  silently doing nothing when a pop-up is blocked — a real gap this surfaced.
- Water excluded (different Reports architecture, same as every other Reports-tab feature this session).

## 2. Audit tab missing from the in-app guide — real bug, now fixed
The Audit tab (added zip 108) was never added to the in-app 📖 user guide's tab list, so `guides.test.mjs`
was failing in all 6 modules that have it. Added 'Audit' to `tools/build-guides.mjs`'s tab dictionary and
every module's tab list, rebuilt the guide data, re-synced. This had been silently broken since zip 108 —
caught by finally running the full suite, not by anything new in this zip.

## 3. Version reset to 1.0.0 + an Update Log, root + hotel, hospital, production, services, pharmacy
Each module's build stamp (Settings ▸ Install App ▸ Version) previously showed an incrementing legacy
counter with one long descriptive sentence per build (e.g. "HRB-POS v58 — decimal quantities are now
universal..."), different per module. Reset to a clean **1.0.0** everywhere, matching the "Version 1.0.0"
heading already shown above it. Added a proper, append-only **Update Log** (newest first) rendered right
below it — seeded with one entry summarizing this session's work (tax engine, X/Z Reports, Audit tab,
automatic Daily Report). Going forward: bump the version and add one line to `APP_UPDATE_LOG` per release,
instead of rewriting a single descriptive string. Water untouched — it already reads its version from the
service worker's own cache hash automatically, no manual string to reset.

## Investigated, no changes needed
Looked into the Owner Console financial ledger (spec sections 47-49, "never calculate funds by counting
tenant links") expecting to find that anti-pattern. Didn't find it — `agreedAmount`/`paidAmount`/
`balanceOwed` are already tracked per client, and revenue is computed from real recorded sales/payments
(`allTimeRevenue()`, `revenueForDate()`), not link-counting. Existing owner-finance tests still pass
unchanged. Reporting this rather than inventing a change to code that already works correctly.

## Verification
- tests/auto-daily-report.test.mjs (new, 36 tests across 6 modules), tests/app-version-reset.test.mjs (new,
  6 tests across 6 modules).
- Full test suite (94 files) run to completion in batches this session — every file, zero failures.
- `npm run check` (shared function + block drift): clean across all 7 modules.

No router changes — deploy:router not needed.
