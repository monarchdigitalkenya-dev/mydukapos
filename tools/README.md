# Shared-code tools

The apps are single-file PWAs and deploy exactly as before (`npx wrangler pages deploy .`).
What changed: code that used to be copy-pasted into every app now has ONE canonical copy in
`src/shared/`, and a script writes it into each app.

## Everyday commands (run `npm install` once first)

| Command | What it does |
|---|---|
| `npm run sync`  | Writes `src/shared/` into every app's `index.html`. Run after editing anything in `src/shared/`. |
| `npm run check` | Changes nothing; fails if any app is out of sync (someone edited a shared region by hand, or forgot to sync). |
| `npm run drift` | Regenerates `DRIFT_REPORT.md`: what is still duplicated, and which copies have diverged. |
| `npm test`      | Boots all 8 apps in a simulated browser and runs ~70 checks: no script errors, receipts (column headers, ASCII, fits the paper) in every app x width x alignment, USB connect/unplug/replug, injection-safe escaping, conditional sync, the real `pos-sync` server code, storage clean-up. ~1-2 minutes. |
| `npm run deploy`| `check` + `test`, then `wrangler pages deploy . --project-name=mydukapos`. Nothing is uploaded if either fails. |
| `npm run deploy:fast` | `check` only, then deploy (skip the tests when you must). |

## Changing shared code

* **Function** — edit it in `src/shared/functions.js` (each starts with `//@fn name`), then `npm run sync`.
  Every app that lists that name gets the change. Never edit inside `@shared:begin … @shared:end` in an index.html.
* **Give an app a shared function it doesn't use yet** — add the name to that app's `@shared:begin names=…` header, delete
  its local copy, `npm run sync`.
* **Whole blocks** (Hardware icon popup, Storage & Photos) — edit `src/shared/blocks/NAME.html`, `npm run sync`.

## Reconciling a diverged function
See the bottom of `DRIFT_REPORT.md`. Short version: diff the variants, decide the intended behaviour, express real
per-app differences as a setting, move the single version into `src/shared/functions.js`.

## Rules that keep this safe
* Only top-level function declarations move into the shared region — they are hoisted, so their position never matters.
* `extract-shared.mjs` was the one-time migration. It only moved functions that were byte-identical in every app that had
  them; it verified nothing else changed. Don't run it again.

## Promoting duplicates automatically
`node tools/promote-identical.mjs --dry` lists functions that are identical (apart from comments) in every app that has them;
without `--dry` it moves them into `src/shared/` (cuts each app's local copy, adds the name to its `@shared:begin` list). Then run
`npm run sync && npm run check && npm test`. Functions that have genuinely diverged are never touched — see `DRIFT_REPORT.md`.

## Incident tools (zip 186: `ledger_audit` filled the D1 database) — full run order in `docs/INCIDENT_LEDGER_AUDIT_186.md`

| Tool | What it does |
|---|---|
| `tools\backup-all.cmd` | Exports the schema and every table except `ledger_audit` DATA, one file each, into `backup\`; failures are logged and the loop continues. |
| `node tools\archive-audit.mjs` | Read-only: writes the audit rows the prune would delete to `backup\audit\*.ndjson.gz` (+ `manifest.json`). |
| `tools\prune-audit.cmd --measure / --dry-run / --run` | Chunked, resumable removal of retry duplicates from `ledger_audit` (typed `YES`, guard trigger handled and restored, never rows younger than 10 min). |
| `sql\incident\*.sql`, `tools\stock-reconcile.sql` | Read-only diagnostics and the stock reconciliation report (the correction is a commented template). |
