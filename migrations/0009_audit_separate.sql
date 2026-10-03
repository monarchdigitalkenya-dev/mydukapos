-- zip 187: the audit trail moves to its own database (mydukapos-audit, binding LEDGER_AUDIT_DB), so a flood of audit rows can never again fill the
-- database that holds the sales. The server now writes the audit rows itself (functions/api/_audit-db.js); these two triggers are what wrote them
-- inside this database and are no longer needed. Nothing else changes: the existing ledger_audit table stays here as history (prune it with
-- tools\prune-audit.mjs, or leave it), and its delete/update guards stay.
--
-- Run tools\setup-audit-db.mjs first (it creates the audit database and adds the binding), then apply this, then deploy. Between this migration and the
-- deploy there is no audit trail for a few minutes (sales are never affected). The server also removes these triggers by itself on its first push once
-- the binding exists, so this migration only makes it happen earlier.
DROP TRIGGER IF EXISTS audit_ledger_records_ins;
DROP TRIGGER IF EXISTS audit_ledger_records_upd;
