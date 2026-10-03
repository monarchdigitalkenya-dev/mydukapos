# Zip 187 - the separate audit database

Audit rows (who changed which money record, and when) live in D1 `mydukapos-audit`, binding `LEDGER_AUDIT_DB`. The sales database no longer holds new audit rows.

* Set it up once: `node tools\setup-audit-db.mjs` (creates the database, adds the binding to `wrangler.toml` and `wildcard-router\wrangler.toml`, creates the table).
* Deploy: `npm run deploy:router`, `npm run deploy`. On its first push the server removes the two audit triggers from the sales database. (`migrations\0009_audit_separate.sql` does the same.)
* If the audit database is full or unreachable: sales are not affected; audit writes pause for 5 minutes and try again. Nothing else to do except trim it.
* Retention: rows older than `AUDIT_RETAIN_DAYS` (default 90) are deleted by the router cron, 20000 per run. Set `AUDIT_RETAIN_DAYS=0` on the router to switch it off.
* Kill switch (still works): `ledger_meta audit_disabled='1'` in the sales database, env `AUDIT_WRITES_DISABLED=1`, or KV `audit:disabled`.
* Health: `/api/ledger-health` shows `auditSeparate:true`, `auditPctOfCap` (audit database) and `pctOfCap` (sales database).
* Manual trim: `npx wrangler d1 execute mydukapos-audit --remote --command "DELETE FROM ledger_audit WHERE id IN (SELECT id FROM ledger_audit ORDER BY id LIMIT 100000)"`
* Not moved: the history already in the sales database's `ledger_audit` (prune with `tools\prune-audit.mjs` as in zip 186).
