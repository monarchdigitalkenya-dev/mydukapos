# Cloudflare usage review — zip 259

No new Cron Trigger, Queue, Durable Object, Worker, KV namespace, D1 database or R2 bucket is added. Nothing polls.

| Feature | Requests / reads / writes | Why it cannot run away |
|---|---|---|
| **Till payments — callback** (`mpesa-c2b-confirmation`, `kcb-ipn`) | 1 Pages Function call + 1 `INSERT OR IGNORE` (+ 1 KV put, 45-day TTL) per payment Safaricom/KCB sends | Safaricom retries hit the same primary key (M-PESA code) and write nothing; unsigned callbacks are parked 30 days then expire |
| **Till payments — list** (`GET till-payments`) | 1 function call + 1 indexed D1 read (≤ 20 rows, keyset paging, hard cap 100) when the Till Payments screen is opened or Refresh is pressed, plus ONE badge read ~4 s after the app opens on a device | no timers / intervals / `visibilitychange` hooks (`setInterval` count in the block: 0) |
| **Till payments — apply/release** | 1 conditional UPDATE + 1 claim INSERT per apply | applied once per code (`mpesa_code_claims`) |
| **Retention** | at most one bounded DELETE (≤ 500 rows) per shop per day, only for APPLIED rows older than 180 days | KV marker `till-purge:<id>` (1 per day) |
| **D1 size** | one narrow row (~150 bytes) per payment, 4 small indexes | no raw callback bodies, masked phone only |
| **Backup export** (owner-only, on demand) | KV: `list`(1000/page) + gets; D1: keyset pages of a fixed size per table; DO: 1 MB slices; R2: `list` 500 + gets | runs only when the owner clicks; resumable steps; export never writes anything |
| **Restore** (owner-only, on demand) | one write batch per step; `INSERT OR IGNORE` / compare-then-write → a retry re-writes nothing | preview first; stops on conflicts; verify step reads counts only |
| **HMIS** | no new endpoints. New synced collection `hmisConfig` holds only *changes* to the starter catalogue (the ~25 starter tests, menu and charge types are code), so the first sync after deploy adds nothing and later syncs carry a record only when it changes | merged per record by id; sync cadence unchanged |
| **Hospital lab results / MAR / ledger** | stored on existing synced records (`labResults`, `admissions`, `patientCharges`) | they ride the existing per-record delta push (unchanged records are not re-sent) |

Things to watch after deploy (all already visible in the dashboard): D1 *rows read* for `till_payments` (should be a few per shop per day), Pages Function invocations for `/api/till-payments` (one per device open + manual opens), and KV *puts* for `till:`-prefixed callback keys (one per payment, auto-expiring).

Not changed: the wildcard-router crons (daily + 6-hourly watchdog), the zip 251/252 cost-incident protections, `_ledger.js` write paths.

## Zip 261 - polling back-off
`syncPollTick` replaces the fixed 7 s pull: every 7 s while the live connection (WebSocket) is down or younger than 15 s, every 45 s while it is healthy, every 5 min in a hidden tab (the app still catches up the moment it becomes visible). Expected effect for 50 shops x 2 devices x 12 h: about 18.5M -> about 3-4M polls a month, which fits inside the plan's included requests (estimate about $5-7 a month instead of about $21). The licence record was already cached on the server (10 s), so no server change was needed. Watch Workers requests and KV reads after deploy: they should fall by about 80%.
