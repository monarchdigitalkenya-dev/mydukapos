// Writes migrations/0001_ledger.sql and 0003_efficiency.sql from functions/api/_ledger-schema.js / _efficiency-schema.js (the single sources of truth).
// 0002_crm.sql / 0004_crm_speed.sql are applied history of the removed CRM (zip 186): they are no longer generated, and 0008_drop_crm.sql removes its tables. `npm run gen:migration`
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { LEDGER_SCHEMA, LEDGER_SCHEMA_0007, LEDGER_SCHEMA_VERSION } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_ledger-schema.js')).href);
export const migrationText = () => '-- GENERATED from functions/api/_ledger-schema.js by tools/gen-migration.mjs — do not edit by hand.\n-- Safe to run more than once (IF NOT EXISTS) and never drops or changes existing data.\n\n' + LEDGER_SCHEMA.map((s) => s.trim() + ';').join('\n\n') + '\n';
export const audit0007MigrationText = () => '-- GENERATED from LEDGER_SCHEMA_0007 in functions/api/_ledger-schema.js by tools/gen-migration.mjs — do not edit by hand.\n-- zip 186 (D1 full-database incident): quiet audit triggers (no row when nothing changed), audit kill switch, audit delete guard with a prune flag.\n-- Safe to run more than once (DROP IF EXISTS + CREATE). Changes NO data and adds NO index. Apply after 0006, before the CRM drop (0008).\n\n' + LEDGER_SCHEMA_0007.map((s) => s.trim() + ';').join('\n\n') + `\n\n-- the runtime bootstrap (ensureLedgerSchema) skips its own re-run once this is recorded\nINSERT INTO ledger_meta (k, v) VALUES ('schema', '${LEDGER_SCHEMA_VERSION}') ON CONFLICT (k) DO UPDATE SET v = excluded.v;\n`;
const { EFFICIENCY_SCHEMA } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_efficiency-schema.js')).href);
export const efficiencyMigrationText = () => '-- GENERATED from functions/api/_efficiency-schema.js by tools/gen-migration.mjs — do not edit by hand.\n-- Safe to run more than once (IF NOT EXISTS) and never drops or changes existing data.\n\n' + EFFICIENCY_SCHEMA.map((s) => s.trim() + ';').join('\n\n') + '\n';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.join(ROOT, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'migrations/0001_ledger.sql'), migrationText());
  fs.writeFileSync(path.join(ROOT, 'migrations/0003_efficiency.sql'), efficiencyMigrationText());
  fs.writeFileSync(path.join(ROOT, 'migrations/0007_audit_idempotency.sql'), audit0007MigrationText());
  console.log('wrote migrations/0001_ledger.sql, 0003_efficiency.sql, 0007_audit_idempotency.sql');
}
