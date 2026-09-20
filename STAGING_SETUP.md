# Staging environment — exact steps

> **Short version (zip 33).** The staging deploy now has its own config files and scripts, so it can never touch your live data:
> 1. `npx wrangler kv namespace create mydukapos_kv_staging`  -> copy the id it prints into `wrangler.staging.toml`
> 2. `npm run deploy:router:staging`   (registers the staging Durable Objects; has no routes, so it can't affect live subdomains)
> 3. `npm run deploy:staging`          (checks, then deploys a temporary copy of the project to `mydukapos-staging` using `wrangler.staging.toml`;
>    it refuses to run if the staging KV id equals the live one)
> Live: `npm run deploy:router` first if `wildcard-router/` changed, then `npm run deploy` (uses `wrangler.toml`, already set to your live KV namespace).
> The manual steps below explain what those scripts do.


Everything risky (the per-shop database, big-shop load tests, new storage limits) must be tried against a copy
first. This is that copy. It takes about 15 minutes and costs nothing on the plan you already have.

The staging project is a **second Pages project with its own KV namespace and its own Durable Object Worker**, so a
mistake there cannot touch a live shop.

## 1. Create the pieces (once)

Run these from the project folder (after `npm install`). Replace nothing — the names are chosen so they can't be
confused with live ones.

```
# 1. A separate KV namespace for staging data
npx wrangler kv namespace create mydukapos_kv_staging
#    -> prints an id like  id = "abc123..."   Copy it.

# 2. A separate Pages project
npx wrangler pages project create mydukapos-staging --production-branch=main

# 3. The live-sync Worker, staging copy (its own Durable Object)
cd wildcard-router
npx wrangler deploy --name mydukapos-router-staging
cd ..
```

## 2. Point the staging project at its own storage

Cloudflare dashboard -> Workers & Pages -> **mydukapos-staging** -> Settings:

* **Functions -> KV namespace bindings:** variable name `mydukapos_kv`, namespace = the staging one from step 1.
* **Functions -> Durable Object bindings:** variable `SYNC_ROOM`, class `SyncRoom`, script `mydukapos-router-staging`.
* **Environment variables:** copy the live ones you need, but use **test** keys for anything that spends money or
  messages people (Paystack/Daraja/SMS). Leave them out entirely if you don't need them.
* Optional: `ROOT_DOMAIN` if you want subdomain links on a staging domain. Otherwise use `?c=<token>` links.

## 3. Deploy to staging (never touches live)

```
npm run check && npm test
npx wrangler pages deploy . --project-name=mydukapos-staging
```

`npm run deploy` (live) is unchanged and still uses `--project-name=mydukapos`. To avoid ever mixing them up, add this
to `package.json` scripts if you like:

```
"deploy:staging": "npm run check && npm test && wrangler pages deploy . --project-name=mydukapos-staging"
```

## 5. What to try there before it goes live

1. Create an owner account and a couple of demo shops on the staging URL.
2. **Size limits:** set `SYNC_WARN_BYTES=200000` and `SYNC_MAX_BYTES=400000` (bytes) as staging environment variables,
   then load a shop with inventory until it crosses them. Check: the 💾 Storage tab flags it, "Compress" shrinks it,
   and past the max the till shows the "too large to sync" message. Then raise the limits back.
3. **Per-site tanks (Aqua POS):** two devices, one on `#production`, one on `#shop` — record a delivery at each and sell
   refills; each site's tank must move independently and survive a refresh on the other device.
4. **Load test for the real ceilings.** Pages Functions have a 128 MB memory limit. I measured the push code in Node
   (V8, same engine): one push needs roughly 6-8x the shop's raw size in memory — about +45 MB at 4 MB, +65 MB at 8 MB,
   +130 MB at 16 MB — so the defaults are 4 MB "Large" / 12 MB refused. That is an estimate from a stand-in, not a Worker
   measurement. On staging, load shops of 4, 8, 12, 16 MB and watch for errors in the Cloudflare dashboard
   (Workers -> Logs). Raise `SYNC_WARN_BYTES` / `SYNC_MAX_BYTES` (live) only to what staging proves.
5. **Automatic archive:** set `SYNC_MAX_BYTES=200000` on staging, then keep adding sales to a test shop (or push a large test
   history). At 160 KB (80%) the shop must trim itself with no error on any till; the Storage tab then shows an "automatic"
   archive. Re-open the till: the old sales must NOT come back, and nothing should show a storage message.
   **Manual archive:** in the Storage tab press "Archive old history…" on a staging shop with test sales, confirm devices show only
   recent history, then "Restore" and confirm the full history comes back with no duplicates.

## 6. Going live

Only after step 4 passes: `npm run deploy` (live). Roll back from the Cloudflare dashboard (Deployments -> a previous one
-> Rollback) if anything looks wrong.

## Environment variables introduced by the size / abuse work (all optional)

| Variable | Default | What it does |
|---|---|---|
| `SYNC_WARN_BYTES` | 4 MiB | Shop shows "Large" in the Storage tab |
| `SYNC_MAX_BYTES` | 12 MiB | Pushes above this are refused with a clear message (HTTP 413) |
| `SYNC_AUTO_COMPRESS_BYTES` | 8 MiB | Shops at/above this are stored gzipped on disk automatically. `off` disables |
| `SMS_HOURLY_LIMIT` | 1500 | SMS recipients per shop per hour |
| `STK_HOURLY_LIMIT` | 60 | M-Pesa STK prompts per shop per hour |
| `ROOT_DOMAIN` | mydukapos.store | Origins allowed by CORS on `pos-sync` (this domain + its subdomains) |


## The per-shop database (long-term storage fix) — opt-in, per shop

What it is: a shop stored as rows in its own SQLite Durable Object instead of one JSON record (`wildcard-router/shop-store.js`).
No size ceiling, nothing archived away, a push costs what the push weighs, devices download only a recent window, and any older date
range is fetched on demand (`/api/history`). Nothing changes for any shop until you move it (Owner Console -> Storage -> 🗄️ Move to database).

**Set up (staging first):**
1. `cd wildcard-router && npx wrangler deploy --name mydukapos-router-staging` (registers the new `ShopStore` class — migration `v2-shop-store`).
2. Bind it in the staging Pages project: Settings -> Functions -> Durable Object bindings -> variable `SHOP_STORE`, class `ShopStore`,
   script `mydukapos-router-staging` (the root `wrangler.toml` already declares it for the live project, pointing at `mydukapos-wildcard-router`).
3. Redeploy the Pages project. Until a shop is moved, the binding is never used.

**Step 4 — one click proves most of the list below:** Owner Console -> Storage -> **🧪 Test the database**. It runs a shop's whole life
(SQL, rollback, push, reading back, two tills selling offline, a 5,000-sale bulk load, paging, delta changes, the point-in-time-restore API) on a
throw-away database on YOUR Cloudflare account and shows every step with timings. It cannot touch a real shop (it refuses any database that holds data).
All green (a yellow ⚠️ on "point-in-time" is only a warning) -> the database works there. Any ❌ -> do not move shops; send me the list.

**Things that could NOT be tested outside Cloudflare — check them on staging before any live shop is moved:**
* the `sql.exec` / `transactionSync` calls behave as in my Node stand-in (`node:sqlite`); I ran the same code against it, not the real runtime;
* a push of a large shop (load 30,000+ sales, then push one sale: it should take milliseconds) and the memory stays low;
* **point-in-time restore**: `POST /restore` on the Durable Object (`ShopStore`) rewinds to a time using Cloudflare's 30-day history. It is written
  from the documentation and is untested. A database shop has NO daily backup copies (the Backups list is for single-record shops); until you have
  proven a restore on staging, keep important shops on the single record, or take an export (`Move to database` keeps the old record as a frozen rollback copy);
* cost: a database shop's tills poll a Durable Object (a few requests per second at most across devices). At a 7-second poll that is ~40k requests per
  device-day; the fast "unchanged" answer keeps each one tiny, but watch the Durable Object request count on staging.

**Move one staging shop and check:** Storage tab -> Move to database -> the shop shows "own database" with a record count; make sales on two devices; reload;
old reports still work on a device that had the history; a NEW device shows only the recent window (older history via `/api/history`).
**Undo:** "Back to single record" (works while the shop still fits in one record).

## Also check on staging (zip 29)
* **CORS middleware:** open the public website, the Owner Console and one shop app and watch the browser console for CORS errors while you use them
  (log in, generate a demo link, view the dashboard). If anything legitimate breaks, tell me which URL — the fix is one line in `functions/api/_cors.js`.
* **Database shop, second device:** log a brand-new device into a database shop; after ~10 s its older reports should fill in (last 180 days). Sales made on
  device A should appear on device B within about a second (the poke).
* **Older history size:** on a busy shop the fetch stops at half of the phone's storage; that's expected.
