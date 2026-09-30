// Writes migrations/0001_ledger.sql from functions/api/_ledger-schema.js and migrations/0002_crm.sql from functions/api/_crm/schema.js
// (the single sources of truth). `npm run gen:migration`
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { LEDGER_SCHEMA } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_ledger-schema.js')).href);
const { CRM_SCHEMA, seedSql } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_crm/schema.js')).href);
export const migrationText = () => '-- GENERATED from functions/api/_ledger-schema.js by tools/gen-migration.mjs — do not edit by hand.\n-- Safe to run more than once (IF NOT EXISTS) and never drops or changes existing data.\n\n' + LEDGER_SCHEMA.map((s) => s.trim() + ';').join('\n\n') + '\n';
export const crmMigrationText = () => '-- GENERATED from functions/api/_crm/schema.js by tools/gen-migration.mjs — do not edit by hand.\n-- Safe to run more than once (IF NOT EXISTS / INSERT OR IGNORE) and never drops or changes existing data.\n\n' + CRM_SCHEMA.map((s) => s.trim() + ';').join('\n\n') + '\n\n-- default statuses, classifications, sources, lost reasons, roles and products (never overwrites edits)\n' + seedSql().join('\n') + '\n';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.join(ROOT, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'migrations/0001_ledger.sql'), migrationText());
  fs.writeFileSync(path.join(ROOT, 'migrations/0002_crm.sql'), crmMigrationText());
  console.log('wrote migrations/0001_ledger.sql, migrations/0002_crm.sql');
}
