-- GENERATED from LEDGER_SCHEMA_0007 in functions/api/_ledger-schema.js by tools/gen-migration.mjs — do not edit by hand.
-- zip 186 (D1 full-database incident): quiet audit triggers (no row when nothing changed), audit kill switch, audit delete guard with a prune flag.
-- Safe to run more than once (DROP IF EXISTS + CREATE). Changes NO data and adds NO index. Apply after 0006, before the CRM drop (0008).

DROP TRIGGER IF EXISTS audit_ledger_records_ins;

DROP TRIGGER IF EXISTS audit_ledger_records_upd;

DROP TRIGGER IF EXISTS no_delete_ledger_audit;

CREATE TRIGGER audit_ledger_records_ins AFTER INSERT ON ledger_records
WHEN COALESCE((SELECT v FROM ledger_meta WHERE k = 'audit_disabled'), '0') <> '1'
BEGIN
  INSERT INTO ledger_audit (client_id, kind, rec_id, action, version, amount, status, actor, source, at, snapshot)
  VALUES (NEW.client_id, NEW.kind, NEW.rec_id, 'CREATE', NEW.version, NEW.amount, NEW.status, NEW.actor, NEW.source, NEW.updated_at,
    CASE WHEN length(NEW.data) <= (CASE WHEN NEW.kind = 'stock_move' THEN 2000 ELSE 16000 END) THEN NEW.data
      ELSE json_object('truncated', 1, 'len', length(NEW.data), 'kind', NEW.kind, 'status', NEW.status, 'amount', NEW.amount, 'version', NEW.version) END);
END;

CREATE TRIGGER audit_ledger_records_upd AFTER UPDATE ON ledger_records
WHEN COALESCE((SELECT v FROM ledger_meta WHERE k = 'audit_disabled'), '0') <> '1'
  AND (NEW.version IS NOT OLD.version OR NEW.status IS NOT OLD.status OR NEW.amount IS NOT OLD.amount
    OR (CASE WHEN json_valid(NEW.data) AND json_valid(OLD.data) THEN json_remove(NEW.data, '$.tries', '$._tries', '$.retries', '$.retryCount', '$._retryCount', '$.lastTryAt') IS NOT json_remove(OLD.data, '$.tries', '$._tries', '$.retries', '$.retryCount', '$._retryCount', '$.lastTryAt') ELSE NEW.data IS NOT OLD.data END))
BEGIN
  INSERT INTO ledger_audit (client_id, kind, rec_id, action, version, amount, status, actor, source, at, snapshot)
  VALUES (NEW.client_id, NEW.kind, NEW.rec_id, 'UPDATE', NEW.version, NEW.amount, NEW.status, NEW.actor, NEW.source, NEW.updated_at,
    CASE WHEN length(NEW.data) <= (CASE WHEN NEW.kind = 'stock_move' THEN 2000 ELSE 16000 END) THEN NEW.data
      ELSE json_object('truncated', 1, 'len', length(NEW.data), 'kind', NEW.kind, 'status', NEW.status, 'amount', NEW.amount, 'version', NEW.version) END);
END;

CREATE TRIGGER no_delete_ledger_audit BEFORE DELETE ON ledger_audit
WHEN NOT (COALESCE((SELECT v FROM ledger_meta WHERE k = 'audit_prune_open'), '0') = '1' AND OLD.at < (CAST(strftime('%s', 'now') AS INTEGER) - 600) * 1000)
BEGIN SELECT RAISE(ABORT, 'financial records are never deleted'); END;

-- the runtime bootstrap (ensureLedgerSchema) skips its own re-run once this is recorded
INSERT INTO ledger_meta (k, v) VALUES ('schema', '3') ON CONFLICT (k) DO UPDATE SET v = excluded.v;
