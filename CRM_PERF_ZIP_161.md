# CRM speed - zip 161

All numbers below are **measured in the sandbox** (Chromium via Playwright, the real CRM router on a SQLite-backed D1 fake, dataset: 5,000 leads, 20,000 activities, 3,000 conversations, 30,000 messages, 300 follow-ups, 50 meetings, 10 staff, 8 campaigns). They are operation counts (D1 round trips and statements) and sandbox milliseconds. They are NOT Cloudflare latency: on Cloudflare every D1 round trip adds a network hop, so the round-trip column is the one that predicts real-world improvement. "Mobile" = Chromium network emulation (150 ms round trip, 1.6 Mbit/s down) plus 4x CPU slowdown, still an emulation.

Owner note acknowledged: clients who sign up through the demo/website link are pushed into the CRM by `demo-account.js` (`_crm/demo-lead.js`). That path was not touched, and `tests/zip161-crm-speed.test.mjs` now proves one sign-up = exactly one CRM lead with its attribution, and a repeat sign-up with the same phone or email is de-duplicated (first attribution kept).

## 1. What was slow (found by measuring)

1. The dashboard made **90 D1 round trips** per load (one per figure).
2. Every request paid 3 to 9 round trips of overhead (session, permissions, settings, lazy jobs) before doing any work.
3. Lead detail 12 trips, campaigns 15, staff reports 16, config 8, staff profile 14.
4. Start-up fired 16 requests, two of them the same `/staff`, and the dashboard waited for `/campaigns` and `/products` (they only fill filter boxes).
5. The bell/inbox poll (every 45 s) downloaded up to 200 conversations (78 KB) just to count unread chats.
6. The lead list built the table AND the phone cards (twice the DOM), redrew the whole chat every 15 s, and had no request de-duplication or cancellation.

## 2. Server: before and after (measured in sandbox, owner, warm, median of 3)

| Endpoint | trips before | trips after | stmts before | stmts after | sandbox ms before | sandbox ms after | bytes before | bytes after |
|---|---|---|---|---|---|---|---|---|
| GET /me | 9 | 1 | 9 | 2 | 1.4 | 0.4 | 7452 | 7452 |
| GET /staff | 4 | 2 | 4 | 3 | 3 | 2.6 | 3000 | 3000 |
| GET /notifications (poll) | 6 | 2 | 6 | 5 | 0.5 | 1.1 | 46 | 64 |
| GET /inbox/conversations?unread=1 (poll) | 4 | 2 | 4 | 3 | 2.5 | 2.1 | 78289 | 78324 |
| GET /dashboard today | 90 | 2 | 90 | 35 | 18 | 14.2 | 6572 | 7015 |
| GET /dashboard month | 90 | 2 | 90 | 35 | 23.1 | 17.5 | 10294 | 10294 |
| GET /leads (default) | 5 | 2 | 5 | 4 | 3.4 | 3.6 | 66262 | 66313 |
| GET /leads page 60 | 5 | 2 | 5 | 4 | 25 | 4.6 | 65481 | 65532 |
| GET /leads sort=name | 5 | 2 | 5 | 4 | 6.9 | 3.7 | 65479 | 65512 |
| GET /leads sort=staff | 5 | 2 | 5 | 4 | 6.5 | 6.3 | 66708 | 66741 |
| GET /leads sort=next_followup | 5 | 2 | 5 | 4 | 8.7 | 6.7 | 66840 | 66873 |
| GET /leads sort=revenue | 5 | 2 | 5 | 4 | 7.6 | 6.2 | 65858 | 65891 |
| GET /leads?q=name | 5 | 2 | 5 | 4 | 6.8 | 4.9 | 65724 | 65775 |
| GET /leads?q=phone digits | 5 | 2 | 5 | 4 | 6.9 | 5.9 | 66 | 100 |
| GET /leads?q=email | 5 | 2 | 5 | 4 | 4.7 | 4.3 | 66326 | 66377 |
| GET /leads?status=new | 5 | 2 | 5 | 4 | 5.1 | 3.1 | 64140 | 64191 |
| GET /leads?staff=me | 5 | 2 | 5 | 4 | 0.9 | 0.9 | 66 | 100 |
| GET /leads?pool=1 | 5 | 2 | 5 | 4 | 6.4 | 2.7 | 63866 | 63917 |
| GET /leads?follow=overdue | 5 | 2 | 5 | 4 | 8.1 | 5.1 | 66887 | 66938 |
| GET /leads?follow=none | 5 | 2 | 5 | 4 | 4.4 | 3.7 | 66110 | 66161 |
| GET /leads?campaign= | 5 | 2 | 5 | 4 | 3.5 | 2.9 | 66400 | 66451 |
| GET /leads/:id (detail) | 12 | 2 | 12 | 11 | 1.4 | 1.3 | 3345 | 3345 |
| GET /leads/export.csv | 5 | 3 | 5 | 4 | 194.6 | 190.2 | 1216103 | 1216103 |
| POST /leads/:id/note | 5 | 3 | 7 | 6 | 1 | 0.9 | 55 | 55 |
| POST /leads/:id/status | 6 | 4 | 6 | 5 | 0.8 | 0.8 | 1306 | 1306 |
| GET /inbox/status | 3 | 1 | 3 | 2 | 0.3 | 0.2 | 23 | 23 |
| GET /inbox/conversations | 4 | 2 | 4 | 3 | 2.1 | 2.4 | 77918 | 77954 |
| GET /inbox/conversations?q= | 4 | 2 | 4 | 3 | 5.7 | 4.8 | 57057 | 57075 |
| GET /inbox/conversations/:id/messages | 5 | 2 | 5 | 4 | 0.5 | 0.5 | 2393 | 2409 |
| POST /inbox/conversations/:id/read | 5 | 2 | 5 | 3 | 0.4 | 0.3 | 11 | 11 |
| GET /followups today | 5 | 2 | 5 | 3 | 0.7 | 0.5 | 2119 | 1421 |
| GET /followups overdue | 5 | 2 | 5 | 3 | 1.4 | 1.2 | 33370 | 33370 |
| GET /meetings (month) | 4 | 2 | 4 | 3 | 0.6 | 0.8 | 4798 | 4798 |
| GET /config | 8 | 1 | 8 | 2 | 0.6 | 0.4 | 6525 | 6525 |
| GET /products | 4 | 2 | 4 | 3 | 0.4 | 0.4 | 1073 | 1073 |
| GET /campaigns | 15 | 2 | 15 | 14 | 4.7 | 4.1 | 25675 | 25675 |
| GET /settings | 4 | 1 | 4 | 2 | 0.3 | 0.2 | 299 | 299 |
| GET /sales | 5 | 2 | 5 | 4 | 3.5 | 3.7 | 139717 | 139717 |
| GET /reports/staff | 16 | 2 | 16 | 15 | 8.1 | 7.8 | 7469 | 7469 |
| GET /reports/sources | 7 | 2 | 7 | 6 | 2.1 | 1.6 | 2048 | 2048 |
| GET /reports/campaigns | 15 | 3 | 15 | 14 | 4.3 | 2.6 | 22351 | 22351 |
| GET /reports/products | 6 | 2 | 6 | 5 | 1.9 | 1.9 | 1307 | 1307 |
| GET /reports/funnel | 7 | 2 | 7 | 6 | 8.8 | 5.1 | 2111 | 2112 |
| GET /reports/response | 5 | 2 | 5 | 3 | 5.2 | 3.4 | 5050 | 5050 |
| GET /staff/:id | 14 | 6 | 14 | 13 | 1.4 | 1.3 | 772 | 772 |
| GET /audit | 5 | 2 | 5 | 4 | 0.7 | 0.6 | 11965 | 11965 |
| GET /automation | 6 | 2 | 6 | 4 | 1 | 0.6 | 10433 | 10433 |

Cold-start: importing the whole CRM router takes about 40 ms in this sandbox (3 runs: 42, 38, 37 ms). It was not changed (see section 5).

## 3. Page, real Chromium (measured in sandbox)

| Measure | before (fast) | after (fast) | before (mobile emu) | after (mobile emu) |
|---|---|---|---|---|
| Cold open dashboard, total | 1455 ms | 239 ms | 3142 ms | 1229 ms |
| First contentful paint | - | 140 ms | 1632 ms | 880 ms |
| Requests at cold start | 16 | 12 (7 are the app files) | 16 | 12 |
| Repeat open | 1395 ms | 139 ms | 2064 ms | 615 ms |
| Open Leads | 124 ms | 82 ms | 250 ms | 278 ms |
| Leads DOM nodes | 1754 | 1255 | 1754 | 1255 |
| Open Inbox | 158 ms | 92 ms | 618 ms | 405 ms |
| Open a conversation | 630 ms / 8 req | 473 ms / 6 req | 1195 ms | 1091 ms |
| Dashboard again | 1017 ms | 52 ms | 1092 ms | 304 ms |
| Idle poll, per 50 s | 2 requests | 1 request | 2 | 1 |

Start-up now sends `/boot` from the page head while the scripts are still downloading (its request starts about 36 ms in, before the scripts finish). JS is 57 KB gzipped (193 KB raw), CSS 5 KB, unchanged. "Type a search" (about 2.1 s in both) is dominated by the test's typing delay, not the server (search answers in about 5 ms).

## 4. What changed

Server (`functions/api/_crm/**`)
- `core.js`: `many()` (one `db.batch` = one round trip and one consistent snapshot) and `batcher()`.
- `auth.js`: session, user, role permissions, overrides and the lazy-job gates are read in **one** batch per request. Statuses and permissions are never cached, so a suspension bites on the very next request (tested).
- `cache.js` (new): module-scope memory for labels, config and settings only, 30 s TTL (`CRM_CACHE_MS`, 0 = off), dropped at once by the instance that writes, and per database object. Lazy jobs (`runAutomation`, `sweepReminders`) are skipped using the value already read in the auth batch.
- `router.js`: `Server-Timing: d1;dur=..;desc="N trips M stmts", app;dur=..` on every CRM answer (F12, Network, Timing tab); new `GET /boot`.
- `reports.js`, `campaigns.js`, `leads.js`, `inbox.js`, `misc.js`, `staff.js`, `sales.js`, `automation.js`, `followups.js`, `config.js`: N+1 loops and sequential awaits became one batch each. Dashboard 90 to 2 trips, lead detail 12 to 2, campaigns 15 to 2, config 8 to 1.
- Lead list: two-phase query (page of ids first, then only those rows pay for the sub-selects), keyset paging with `after=<value>:<id>` for the created/updated sorts (`nextCursor`, `hasMore`, `count=0` skips COUNT(*)); page numbers still work and give the same rows. Inbox list `before=` cursor, thread `before=` and `hasMore`, `/campaigns?lite=1`, `/sales?limit=`. Every response keeps its old fields; the new ones are additions.
- `/notifications` also returns `inboxUnread` (one small request replaces two).
- Search: optional FTS5 trigram table (`crm_leads_fts`), kept in sync by triggers, same answers as LIKE (tested on many terms, including insert, update and soft-delete); `CRM_FTS=0` forces LIKE; without the table LIKE is used automatically.
- `schema.js`: new covering/sort indexes in `CRM_SPEED_SCHEMA` (`IF NOT EXISTS`), schema version 4 to 5 (a database at 4 gets them at its next first use). Generated `migrations/0004_crm_speed.sql`. The optional FTS file is `migrations-optional/0005_crm_search.sql` (kept OUT of `migrations/` on purpose, see section 5).

Page (`crm/**`, `_headers`)
- `index.html`: an inline head script starts `/boot` while the scripts download.
- `crm-core.js`: one `/boot` at start-up instead of `/me` + `/staff` x2 + `/notifications` + inbox list; identical GETs in flight share one request; every navigation-bound GET is cancelled when you move to another screen; visibility-aware polling (nothing while the tab is hidden, an immediate refresh on return).
- `crm-admin.js`: dashboard figures no longer wait for the campaign/product lists.
- `crm-leads.js`: `/campaigns?lite=1`, only one layout (table or cards) is built, 250 ms search debounce, stale answers and in-flight searches are cancelled.
- `crm-inbox.js`: no `/inbox/status` call (the list says it), 15 s poll only redraws the chat when something changed, 250 ms search debounce.
- `crm/sw.js` (new): a CRM-only service worker. It answers only the app shell (page, css, `crm-*.js`, icon, manifest) as ONE consistent set named by a hash of the files, stale-while-revalidate (at most one check a minute; a new set is downloaded completely, verified, then switched atomically; the page shows "A new version of the CRM is ready - Reload"). It never touches `/api`, other origins, non-GET or anything outside the shell. `/crm/?nosw=1` unregisters it and clears its caches. The shop's `/sw.js` still skips `/crm/`. Tested in Chromium: it registers with scope `/crm/`, a reload while offline still opens the app shell.
- `_headers`: `/crm/*` is `Cache-Control: no-cache` (Pages sends an ETag, so an unchanged file costs a 304). `/crm/sw.js` is already no-cache through the existing `/*/sw.js` rule.

Tests: `tests/zip161-crm-speed.test.mjs` (17 tests): per-endpoint round-trip budgets on the big dataset, keyset and page pagination correctness (inbox too), cache invalidation (own edit visible at once, foreign edit after the TTL, TTL 0, permissions never cached), FTS vs LIKE parity and trigger sync, migrations match the generator, service-worker behaviour (whole-set update, partial or offline download changes nothing, never touches /api), Server-Timing, `/boot`, front-end wiring, and the demo sign-up owner note. Two existing tests were touched: `tests/crm-schema.test.mjs` also runs `0004`, and `tests/crm-ui.test.mjs` used to assert "no service worker"; it now asserts that the only registration is in `crm-start.js`.

## 5. What was NOT changed, and why

- **FTS is opt-in.** D1 cannot `wrangler d1 export` a database that contains a virtual table, and that export is the owner's backup route. LIKE is already fast on this dataset with the new indexes (search 2 to 6 ms on 5,000 leads). Turn FTS on only if the lead table grows to hundreds of thousands of rows.
- **`crm-admin.js` is not lazy-loaded.** It is 55 KB raw, about 12 KB gzipped, and the service worker makes repeat visits free; lazy-loading would add a request and a failure mode to every admin screen.
- **Cold-start module loading** (about 40 ms) is left alone: bundling the Functions would change the deploy shape shared with other agents' code.
- **No infinite scroll.** The list is server-paged at 25 rows, so the DOM is already small; the keyset API is ready for infinite scroll if wanted. The Sales screen still returns up to 1,000 rows (139 KB) by default; `limit=` exists, but the screen needs a "load more" control first.
- **Inbox list** still returns up to 200 conversations by default (78 KB); the `before=` cursor exists, the screen does not use it yet.
- **Staff profile** takes 6 trips (down from 14): the permission overrides are read by a separate helper.
- **Statuses and permissions are never cached**, by design, even though that costs one trip per request.
- **Lead export** (1.2 MB, about 190 sandbox ms) is unchanged; it is an explicit download.
- Photos: avatars are still loaded as embedded images when a staff photo exists; not measured to be a problem.
- Outside my area I made no edits (`src/shared/functions.js`, per-module invite code, `hotel/index.html`). The only files touched outside `crm/**`, `functions/api/_crm/**`, `functions/api/crm/**`, `migrations/**` and `tools/gen-migration.mjs` are `_headers` (CRM rules appended), `tools/audit-d1-queries.mjs` (adds the speed indexes), `tests/` helpers and the new tools listed below.

## 6. Owner steps (Windows Command Prompt)

1. Open Command Prompt (Start, type `cmd`, Enter) and go to the project folder: `cd /d C:\path\to\your\project`
2. Check the project: `npm run check` then `npm run lint`, then `npm test`.
3. Add the new indexes to the database (safe to repeat; only `0004` is new, `0005` is deliberately not in this folder): `npx wrangler d1 migrations apply mydukapos-ledger --remote`
4. Deploy as usual: `npm run deploy`
5. Open the CRM once in your browser and sign in. The first visit after the deploy installs the CRM's own fast-start worker; the next visit opens the app from your device.
6. To see where time goes: press F12, open the Network tab, click a `/api/crm/...` request, open the Timing tab and read `Server-Timing` (for example `d1;dur=3.1;desc="2 trips 4 stmts"`). More than 3 trips on a normal screen would be a bug to report.
7. If a screen ever looks stale, open `https://YOUR-SITE/crm/?nosw=1` once: it switches the fast-start worker off and clears its files. Reload without `?nosw=1` to switch it on again.
8. OPTIONAL, only for a very large lead table: turn on fast search. In the Cloudflare dashboard open your Pages project, Settings, Variables, add `CRM_FTS` = `1`, redeploy (the table builds itself), or run `npx wrangler d1 execute mydukapos-ledger --remote --file=migrations-optional/0005_crm_search.sql`. Remember `wrangler d1 export` will then refuse this database. To go back to normal search set `CRM_FTS` = `0` (search falls back to LIKE at once).
9. OPTIONAL: `CRM_CACHE_MS` (default 30000) sets how many milliseconds the label and settings memory lasts; `0` turns it off.

## 7. Tools added (re-run any time)

- `node tools/measure-crm-speed.mjs [--root <dir>] [--json <file>]` server round trips per endpoint.
- `node tools/crm-dev-server.mjs --port 8901` serves the CRM plus the real API on the big dataset; `node tools/measure-crm-browser.mjs --base http://localhost:8901 --profile fast|mobile` measures the page in Chromium.
