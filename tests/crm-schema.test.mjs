import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { makeD1 } from './d1-fake.mjs';
import { crmMigrationText, migrationText } from '../tools/gen-migration.mjs';
import { ensureCrmSchema, CRM_SCHEMA, PERM_KEYS, ROLE_DEFAULTS } from '../functions/api/_crm/schema.js';
import { listProducts } from '../functions/api/_license.js';

// The CRM schema, run on a REAL SQL engine.
const objects = (db) => db.prepare(`SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name LIKE '%crm%' OR name LIKE 'no_%crm%' ORDER BY type, name`).all().map((r) => r.type + ':' + r.name);

test('migrations/0002_crm.sql is exactly what the code generates, and 0001 is unchanged by it', () => {
  assert.equal(fs.readFileSync(new URL('../migrations/0002_crm.sql', import.meta.url), 'utf8'), crmMigrationText());
  assert.equal(fs.readFileSync(new URL('../migrations/0001_ledger.sql', import.meta.url), 'utf8'), migrationText());
});

test('running the migration file creates the same tables, indexes and triggers as ensureCrmSchema (and twice is harmless)', async () => {
  const viaFile = new DatabaseSync(':memory:'); viaFile.exec('PRAGMA foreign_keys = ON');
  const sql = fs.readFileSync(new URL('../migrations/0002_crm.sql', import.meta.url), 'utf8');
  const speed = fs.readFileSync(new URL('../migrations/0004_crm_speed.sql', import.meta.url), 'utf8');   // zip 161: the speed indexes are a second migration
  viaFile.exec(sql); viaFile.exec(sql); viaFile.exec(speed); viaFile.exec(speed);
  const d1 = makeD1(); await ensureCrmSchema(d1); await ensureCrmSchema(d1);
  assert.deepEqual(objects(viaFile), objects(d1._db));
  for (const t of ['crm_statuses', 'crm_sources', 'crm_classifications', 'crm_lost_reasons', 'crm_products', 'crm_roles']) {
    assert.deepEqual(viaFile.prepare(`select * from ${t} order by 1`).all(), d1._db.prepare(`select * from ${t} order by 1`).all(), t + ' seeds agree');
  }
});

test('defaults are seeded idempotently: statuses, classifications, sources, lost reasons, roles and the MyDuka products', async () => {
  const d1 = makeD1(); await ensureCrmSchema(d1);
  const keys = (t) => d1.query(`select key from ${t} order by position`).map((r) => r.key);
  assert.deepEqual(keys('crm_statuses'), ['new', 'unassigned', 'assigned', 'contacting', 'contacted', 'awaiting_response', 'followup_required', 'qualified', 'potential', 'meeting', 'proposal', 'negotiation', 'won', 'lost', 'not_interested', 'invalid_number']);
  assert.deepEqual(keys('crm_classifications'), ['hot', 'warm', 'cold', 'potential', 'dead']);
  assert.ok(keys('crm_sources').includes('website') && keys('crm_sources').includes('meta_ads') && keys('crm_sources').includes('whatsapp'));
  assert.ok(keys('crm_lost_reasons').length >= 5);
  assert.deepEqual(d1.query('select key from crm_products order by position').map((r) => r.key), listProducts().map((p) => p.id), 'products come from _license.js');
  assert.deepEqual(d1.query('select key from crm_roles order by key').map((r) => r.key), Object.keys(ROLE_DEFAULTS).sort());
  assert.equal(d1.query(`select count(*) n from crm_statuses where is_won = 1`)[0].n, 1);
  // an admin edit survives a re-seed
  d1._db.exec(`update crm_statuses set label = 'Customer won', active = 1 where key = 'won'`);
  d1._db.exec(`delete from crm_meta where k = 'seed'`);
  await ensureCrmSchema({ ...d1 });                     // a new handle object forces the seed path again on the same data
  assert.equal(d1.query(`select label from crm_statuses where key = 'won'`)[0].label, 'Customer won', 'INSERT OR IGNORE never overwrites');
  assert.equal(d1.query('select count(*) n from crm_statuses')[0].n, 16);
});

test('permission catalogue: every role default is a known key; owner has everything', () => {
  for (const [role, r] of Object.entries(ROLE_DEFAULTS)) for (const p of r.perms) assert.ok(PERM_KEYS.includes(p), `${role}: ${p}`);
  assert.deepEqual([...ROLE_DEFAULTS.owner.perms].sort(), [...PERM_KEYS].sort());
  assert.ok(!ROLE_DEFAULTS.sales.perms.includes('leads.all') && !ROLE_DEFAULTS.sales.perms.includes('revenue.company') && !ROLE_DEFAULTS.sales.perms.includes('staff.view'));
});

test('the database itself refuses to delete history and enforces one open owner per lead', async () => {
  const d1 = makeD1(); await ensureCrmSchema(d1); const db = d1._db, t = Date.now();
  db.exec(`insert into crm_users (id, name, role, status, created_at, updated_at) values ('u1','Ann','sales','active',${t},${t}),('u2','Bob','sales','active',${t},${t})`);
  db.exec(`insert into crm_leads (id, name, created_at, updated_at) values ('l1','Lead',${t},${t})`);
  db.exec(`insert into crm_lead_owners (id, lead_id, user_id, kind, started_at) values ('o1','l1','u1','claim',${t})`);
  assert.throws(() => db.exec(`insert into crm_lead_owners (id, lead_id, user_id, kind, started_at) values ('o2','l1','u2','claim',${t})`), /UNIQUE/, 'a second open ownership row is impossible');
  db.exec(`update crm_lead_owners set ended_at = ${t} where id = 'o1'`);
  db.exec(`insert into crm_lead_owners (id, lead_id, user_id, kind, started_at) values ('o2','l1','u2','reassign',${t})`);
  for (const [tbl, id] of [['crm_users', 'u1'], ['crm_leads', 'l1'], ['crm_lead_owners', 'o1']]) assert.throws(() => db.exec(`delete from ${tbl} where id = '${id}'`), /never deleted/, tbl);
  db.exec(`insert into crm_audit (action, entity, at) values ('x','y',${t})`);
  assert.throws(() => db.exec(`delete from crm_audit`), /never deleted/);
  assert.throws(() => db.exec(`update crm_audit set action = 'z'`), /append-only/);
  assert.throws(() => db.exec(`insert into crm_users (id, name, role, status, created_at, updated_at) values ('u3','X','sales','bogus',${t},${t})`), /CHECK/);
  assert.throws(() => db.exec(`insert into crm_leads (id, name, status_key, created_at, updated_at) values ('l2','L','nope',${t},${t})`), /FOREIGN KEY/);
  // spend: one row per scope and day; a WhatsApp / Meta message id is unique
  db.exec(`insert into crm_campaigns (id, name, created_at, updated_at) values ('c1','C',${t},${t})`);
  db.exec(`insert into crm_spend (id, campaign_id, scope_key, date, amount, created_at, updated_at) values ('s1','c1','campaign:c1','2026-09-01',10,${t},${t})`);
  assert.throws(() => db.exec(`insert into crm_spend (id, campaign_id, scope_key, date, amount, created_at, updated_at) values ('s2','c1','campaign:c1','2026-09-01',20,${t},${t})`), /UNIQUE/);
  assert.throws(() => db.exec(`insert into crm_spend (id, campaign_id, scope_key, date, amount, created_at, updated_at) values ('s3','c1','campaign:c1','2026-09-02',-5,${t},${t})`), /CHECK/);
});
