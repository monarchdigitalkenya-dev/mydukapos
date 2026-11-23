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
const { PAYROLL_SCHEMA } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_payroll-schema.js')).href);
export const payrollMigrationText = () => '-- GENERATED from functions/api/_payroll-schema.js by tools/gen-migration.mjs — do not edit by hand.\n-- Create Payroll (zip 216). Safe to run more than once (IF NOT EXISTS) and never drops or changes existing data.\n\n' + PAYROLL_SCHEMA.map((s) => s.trim() + ';').join('\n\n') + '\n\n' + "INSERT INTO pr_meta (k, v) VALUES ('schema', '1') ON CONFLICT (k) DO UPDATE SET v = excluded.v;\n";
const { HR_SCHEMA, HR_SCHEMA_0018 } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_hr-schema.js')).href);
export const hrMigrationText = () => '-- GENERATED from functions/api/_hr-schema.js by tools/gen-migration.mjs — do not edit by hand.\n-- Staff & HR records (zip 328): a side table for employment details, employee history, deduction approval, staff reports. Needs 0010_payroll.sql applied first. Safe to run more than once (IF NOT EXISTS); changes no existing table and no existing row.\n\n' + HR_SCHEMA.map((s) => s.trim() + ';').join('\n\n') + '\n\n' + "INSERT INTO pr_meta (k, v) VALUES ('hr_schema', '1') ON CONFLICT (k) DO UPDATE SET v = excluded.v;\n";
export const hr0018MigrationText = () => '-- GENERATED from HR_SCHEMA_0018 in functions/api/_hr-schema.js by tools/gen-migration.mjs — do not edit by hand.\n-- Staff registration numbers (zip 334): any number of labelled numbers per person. Needs 0017_hr.sql applied first. Safe to run more than once (IF NOT EXISTS); changes no existing table and no existing row.\n\n' + HR_SCHEMA_0018.map((s) => s.trim() + ';').join('\n\n') + '\n\n' + "INSERT INTO pr_meta (k, v) VALUES ('hr_schema', '2') ON CONFLICT (k) DO UPDATE SET v = excluded.v;\n";
const { LPG_SCHEMA } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_lpg-schema.js')).href);
export const lpgMigrationText = () => '-- GENERATED from functions/api/_lpg-schema.js by tools/gen-migration.mjs — do not edit by hand.\n-- LPG / gas retail (zip 216). Safe to run more than once (IF NOT EXISTS) and never drops anything.\n\n' + LPG_SCHEMA.join(';\n\n') + ';\n';
const { INTEGRITY_SCHEMA } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_stock-integrity-schema.js')).href);
export const integrityMigrationText = () => '-- GENERATED from functions/api/_stock-integrity-schema.js by tools/gen-migration.mjs — do not edit by hand.\n-- zip 336: Store batches (lot, expiry, cost), cost corrections, profit adjustments, books-closed date, stock audit trail. The app also creates these by itself on first use.\n-- Safe to run more than once (IF NOT EXISTS); changes no existing table and no existing row. The new tables are append-only (triggers).\n\n' + INTEGRITY_SCHEMA.map((s) => s.trim() + ';').join('\n\n') + '\n';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.join(ROOT, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'migrations/0001_ledger.sql'), migrationText());
  fs.writeFileSync(path.join(ROOT, 'migrations/0003_efficiency.sql'), efficiencyMigrationText());
  fs.writeFileSync(path.join(ROOT, 'migrations/0007_audit_idempotency.sql'), audit0007MigrationText());
  fs.writeFileSync(path.join(ROOT, 'migrations/0010_payroll.sql'), payrollMigrationText());
  fs.writeFileSync(path.join(ROOT, 'migrations/0011_lpg.sql'), lpgMigrationText());
  fs.writeFileSync(path.join(ROOT, 'migrations/0017_hr.sql'), hrMigrationText());
  fs.writeFileSync(path.join(ROOT, 'migrations/0018_hr_numbers.sql'), hr0018MigrationText());
  fs.writeFileSync(path.join(ROOT, 'migrations/0019_stock_integrity.sql'), integrityMigrationText());
  console.log('wrote migrations/0001_ledger.sql, 0003_efficiency.sql, 0007_audit_idempotency.sql, 0010_payroll.sql, 0011_lpg.sql (0012_chama.sql is kept as applied history: the Chama app was removed in zip 269)');
}
