# Zip 291 - deploy (Cash float & reconciliation for the Shop + inventory groundwork)

Everything is Windows **cmd** (not PowerShell). Work folder: `C:\dev\mydukapos` (your clone). Cloudflare Pages project: `mydukapos`.

**What this zip changes (user-visible: ONLY the cash drawer; the serialized-unit / variant / import engine is tested but has no screens yet - see `docs/HANDOFF.md`):** Shop app (`index.html`), shared code (`src/shared/functions.js`, new block `src/shared/blocks/cash-drawer.html`, `tools/lib.mjs`), the server merge rules (`functions/api/_merge.js`), tests and docs.
**What it does NOT need:** no D1 migration, no router deploy (`wildcard-router/` unchanged), no new Cloudflare setting or secret. The other apps (hotel, pharmacy, hospital, production, services, water, owner) are byte-identical to zip 289.
**Heads-up:** cash management is ON by default, so after the deploy every Shop checkout asks for the opening cash count once per cash session. Tell your shops first. Owner/Admin can switch it off: Sales Counter -> the green "Open cash drawer" button -> Cash settings.

---------------------------------------------------------------------------------------------------------------------------------------

## PART A - Unpack the zip

```
mkdir C:\dev\zip291
tar -xf "%USERPROFILE%\Downloads\mydukapos_zip291_handoff.zip" -C C:\dev\zip291
```

The zip puts everything inside a folder called `proj`. Point `SRC` at the folder that really holds `package.json` (these two lines work either way):

```
set "SRC=C:\dev\zip291"
if exist "C:\dev\zip291\proj\package.json" set "SRC=C:\dev\zip291\proj"
```

Check you picked the right folder (both lines must list a file, not "File Not Found"):

```
dir "%SRC%\package.json"
dir "%SRC%\src\shared\blocks\cash-drawer.html"
```

(`SRC` only lives in this cmd window. If you close it, run the two `set` lines again.)

## PART B - Make a restore point in your clone

```
cd /d C:\dev\mydukapos
git status
git pull
git tag before-zip291
```

`git status` should say "nothing to commit, working tree clean". If it lists changes you did not expect, stop and sort them out first (commit or stash them).

## PART C - Copy the new files into the clone

```
robocopy "%SRC%" C:\dev\mydukapos /E /XD .git node_modules .wrangler /XF package-lock.json wrangler.toml wrangler.staging.toml /NP /NFL /NDL
if errorlevel 8 (echo ROBOCOPY FAILED - STOP HERE) else (echo robocopy ok)
```

- `/E` copies new and changed files and **never deletes** anything in your clone. Do not use `/MIR` here (zip 284 note: it would be unsafe after an account switch). This zip removes no files, so `/E` is complete.
- `wrangler.toml` and `wrangler.staging.toml` are skipped on purpose (this skips **every** file of those names, including the one in `wildcard-router\`), so your account's KV / D1 / R2 ids and `PAGES_ORIGIN` are never overwritten.
- robocopy exit codes 0-7 are success; 8 or higher is a real error.

## PART D - Look at what changed

```
cd /d C:\dev\mydukapos
git status
git diff --stat
```

Expected: only these files (new ones show as untracked):
`index.html`, `functions/api/_merge.js`, `src/shared/functions.js`, `src/shared/blocks/cash-drawer.html` (new), `tools/lib.mjs`, `tests/helpers.mjs`, `tests/cash-drawer.test.mjs` (new), `tests/serial-import-engine.test.mjs` (new), `DEPLOY.md`, `DEPLOY_291.md` (new), `CHANGELOG.md`, `docs/CASH_INVENTORY_CHECKLIST.md` (new), `docs/HANDOFF.md` (new), `docs/ORIGINAL_REQUEST.md` (new), `docs/history/CHANGES_ZIP_291.md` (new).

If `git status` shows almost EVERY file as changed, that is line endings (see `GIT_SETUP.md`). Run once, then look again:

```
git config core.autocrlf false
git add --renormalize .
git status
```

## PART E - Install and check

```
npm install
npm run check
npm run lint
```

- `npm run check` must say **All apps match src/shared/.** and **cards in sync**.
- `npm run lint` must say **No undeclared names found.**
- `npm install` only changes things if tools changed; no new packages are added by this zip.

## PART F - Run the tests

Just the new cash tests first (about 5-10 minutes):

```
node --test tests\cash-drawer.test.mjs
node --test tests\serial-import-engine.test.mjs
```

Expect **21 of 21** and **7 of 7**. Then everything (several more minutes):

```
npm test
```

Known, not caused by this zip: `tests\zip168-checkout-workspace.test.mjs` test 1 ("pos-checkout class") failed identically on the untouched zip 289 in the build sandbox (a slow single-CPU machine, it waits 3 s for the page). If it passes on your PC, good. If it is the ONLY failure, it is not a blocker and you use `npm run deploy:fast` in Part J. Any other failure: stop and send me the output.

## PART G - Cloudflare login and backup

```
npx wrangler whoami
```

It must show your Cloudflare account. If not: `npx wrangler login`.

Backup (recommended; nothing is dropped or rewritten by this zip, but it costs two minutes):

```
npm run db:backup
```

## PART H - What you skip (and why)

- `npm run db:migrate` - **skip**: no new migration (cash records live in the existing synced shop state, not new D1 tables).
- `npm run deploy:router` - **skip**: `wildcard-router/` did not change.
- Deploy order if you ever do have both: backup -> migrations -> router -> Pages.

## PART I - Staging first (recommended)

```
npm run deploy:staging
```

Open the staging Shop link and check:
1. Add an item to the cart, press Pay: the **Open cash drawer** screen appears. The sale does not go through yet.
2. Count some notes (the total updates live), tick the confirmation, press **Open drawer**. The sale completes.
3. Press the green drawer button above the cart: opening float, cash sales, expected cash are shown. Record a cash movement (needs a reason). Make a second sale as another staff member: no second count asked.
4. **Close cash session...**: count the cash; a difference needs a reason; a difference above the approval limit shows "awaiting manager approval" in **Session history**, where a manager can approve or reject it.
5. A second device on the same shop shows the same open session (after it syncs).
6. Cash settings (owner/admin): turn it off and sell without any prompt; turn it on again. Old sessions are still in the history.

## PART J - Production

```
npm run deploy
```
(`check` + all tests + upload to Cloudflare Pages production.) If Part F showed only the known `zip168` failure, use:
```
npm run deploy:fast
```
Cloudflare uploads only changed files; the service worker versions itself, so open tills pick up the new version on their next reload.

## PART K - Save to Git

```
git add -A
git commit -m "Zip 291: cash float and reconciliation for the Shop"
git push
```
Pushing does NOT deploy; Part J did.

## PART L - Verify the live site

```
npx wrangler pages deployment list --project-name=mydukapos
```
The newest row must be **Production**. Then open a real client link, make a test sale (the opening count appears once), close the session, and check the history. Tell shop staff what the new screen is before the first trading day.

---------------------------------------------------------------------------------------------------------------------------------------

## Rollback

- **Quick (no redeploy):** an owner/admin switches cash management off in Cash settings. Sales go back to normal; every count and session already recorded stays in the history.
- **Code rollback:** Cloudflare dashboard -> Workers & Pages -> mydukapos -> Deployments -> pick the previous Production deployment -> Rollback. Close all open cash sessions first. Older server code does not know the cash records, so do not rely on a rollback to carry in-flight sessions; the shop's own devices keep their copies and they sync again when you redeploy.
- **Git:** `git revert <the zip 291 commit>` then deploy again; `git tag before-zip291` marks the state before this zip.

## Known limits (honest list)

- Only the **Shop** app has the cash drawer (the Hospital keeps its own per-cashier shifts).
- Sales recorded without a session (for example a bill settled later) count toward the drawer by time window, and only in a shop with a single cashier point.
- A void of an already-counted sale removes its cash from expected cash (final state). Cash refunds and payouts must be recorded as drawer movements; they are never guessed from returns or expenses.
- Serialized units (IMEI), the inventory workspace, the import wizard and purchasing integration have tested ENGINE code in this zip but NO screens, so shops cannot use them yet. Exact status and next steps: `docs/HANDOFF.md`.
- New synced lists `serialUnits` and `importBatches` are registered and merge-safe, but nothing writes them yet.
