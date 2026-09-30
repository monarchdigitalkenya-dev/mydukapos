// Writes migrations/0001_ledger.sql from functions/api/_ledger-schema.js, migrations/0002_crm.sql + 0004_crm_speed.sql + (OPTIONAL, kept out of migrations/ so 'migrations apply' never applies it) migrations-optional/0005_crm_search.sql from functions/api/_crm/schema.js
// (the single sources of truth). `npm run gen:migration`
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { LEDGER_SCHEMA } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_ledger-schema.js')).href);
const { CRM_SCHEMA, CRM_SPEED_SCHEMA, CRM_FTS_SCHEMA, seedSql } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_crm/schema.js')).href);
export const migrationText = () => '-- GENERATED from functions/api/_ledger-schema.js by tools/gen-migration.mjs — do not edit by hand.\n-- Safe to run more than once (IF NOT EXISTS) and never drops or changes existing data.\n\n' + LEDGER_SCHEMA.map((s) => s.trim() + ';').join('\n\n') + '\n';
const { EFFICIENCY_SCHEMA } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_efficiency-schema.js')).href);
export const efficiencyMigrationText = () => '-- GENERATED from functions/api/_efficiency-schema.js by tools/gen-migration.mjs — do not edit by hand.\n-- Safe to run more than once (IF NOT EXISTS) and never drops or changes existing data.\n\n' + EFFICIENCY_SCHEMA.map((s) => s.trim() + ';').join('\n\n') + '\n';
export const crmMigrationText = () => '-- GENERATED from functions/api/_crm/schema.js by tools/gen-migration.mjs — do not edit by hand.\n-- Safe to run more than once (IF NOT EXISTS / INSERT OR IGNORE) and never drops or changes existing data.\n\n' + CRM_SCHEMA.map((s) => s.trim() + ';').join('\n\n') + '\n\n-- default statuses, classifications, sources, lost reasons, roles and products (never overwrites edits)\n' + seedSql().join('\n') + '\n';
export const crmSpeedMigrationText = () => '-- GENERATED from CRM_SPEED_SCHEMA in functions/api/_crm/schema.js by tools/gen-migration.mjs — do not edit by hand.\n-- Indexes only (zip 161). Safe to run more than once (IF NOT EXISTS) and never drops or changes existing data.\n\n' + CRM_SPEED_SCHEMA.map((s) => s.trim() + ';').join('\n\n') + '\n';
export const crmSearchMigrationText = () => '-- GENERATED from CRM_FTS_SCHEMA in functions/api/_crm/schema.js by tools/gen-migration.mjs — do not edit by hand.\n-- OPTIONAL fast lead search (zip 161). The CRM works without it (search falls back to LIKE). Apply it BY HAND (it is deliberately NOT in migrations/, so `wrangler d1 migrations apply` never applies it): npx wrangler d1 execute <db> --remote --file=migrations-optional/0005_crm_search.sql. Only if you accept that `wrangler d1 export` cannot dump a database that\n-- contains a virtual table (a documented D1 limitation). Needs the FTS5 trigram tokenizer; if your D1 refuses it, skip this file: nothing else depends on it.\n-- Safe to run more than once (IF NOT EXISTS, and the back-fill only adds leads that are missing).\n\n' + CRM_FTS_SCHEMA.map((s) => s.trim() + ';').join('\n\n') + '\n';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.join(ROOT, 'migrations'), { recursive: true }); fs.mkdirSync(path.join(ROOT, 'migrations-optional'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'migrations/0001_ledger.sql'), migrationText());
  fs.writeFileSync(path.join(ROOT, 'migrations/0002_crm.sql'), crmMigrationText());
  fs.writeFileSync(path.join(ROOT, 'migrations/0003_efficiency.sql'), efficiencyMigrationText());
  fs.writeFileSync(path.join(ROOT, 'migrations/0004_crm_speed.sql'), crmSpeedMigrationText());
  fs.writeFileSync(path.join(ROOT, 'migrations-optional/0005_crm_search.sql'), crmSearchMigrationText());
  console.log('wrote migrations/0001_ledger.sql, 0002_crm.sql, 0003_efficiency.sql, 0004_crm_speed.sql, 0005_crm_search.sql');
}
