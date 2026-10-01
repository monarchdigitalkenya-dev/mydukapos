// functions/api/_crm/schema.js — the D1 schema of the MyDuka CRM (zip 157). Single source of truth (NOT a route):
//   * the server creates any missing table on first use (ensureCrmSchema) and seeds the defaults idempotently;
//   * migrations/0002_crm.sql is GENERATED from CRM_SCHEMA + CRM_SEEDS by tools/gen-migration.mjs (a test fails if they differ).
// Rules the database itself enforces (not just the app):
//   * users, leads, sales, activities, ownership history and the audit are NEVER deleted (triggers abort DELETE); audit is append-only;
//   * a lead has at most ONE open ownership record (partial unique index) and the claim is one conditional UPDATE (see leads.js);
//   * a phone-message id (WhatsApp) / Meta lead id is unique, so a retried webhook is the same row;
//   * spend is one row per (campaign/ad set/ad, day).
import { listProducts } from '../_license.js';

export const CRM_SCHEMA_VERSION = 5;                      // zip 161: 4 -> 5 (the speed indexes below; a database at 4 gets them at its next first use)
export const CRM_SEED_VERSION = 3;

// Columns added after schema v1. A database created at v1 gets them through ALTER TABLE ... ADD COLUMN in ensureCrmSchema (CREATE TABLE IF NOT EXISTS
// cannot add columns to a table that already exists); a fresh database (or migrations/0002_crm.sql) gets them from the CREATE TABLE itself.
export const CRM_COLUMN_ADDS = {
  crm_leads: [
    ['country', 'TEXT'],
    ['estimated_value', 'REAL CHECK (estimated_value IS NULL OR estimated_value >= 0)'],
    ['actual_value', 'REAL'],                                   // sum of the lead's sales (set on convert)
    ['expected_close_date', 'TEXT'],                            // YYYY-MM-DD
    ['next_action', 'TEXT'],
    ['contact_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_contacted_at', 'INTEGER'],
    ['last_contacted_by', 'TEXT REFERENCES crm_users(id)'],
    ['last_contacted_by_name', 'TEXT'],                         // name snapshot: history keeps the name after the account is archived
  ],
  // zip 158 (schema v3): WhatsApp attachments. `type` is image / video / voice / audio / document / sticker; `text` holds the caption.
  crm_messages: [
    ['media_id', 'TEXT'],                                       // Meta's media id (the file is fetched on demand through GET /inbox/media/:messageId)
    ['media_mime', 'TEXT'],
    ['media_name', 'TEXT'],                                     // a document's file name
  ],
};
const colsSql = (t) => CRM_COLUMN_ADDS[t].map(([c, d]) => `  ${c} ${d},`).join('\n');

const cfg = (t, extra = '') => `CREATE TABLE IF NOT EXISTS ${t} (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,${extra}
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const noDelete = ['crm_users', 'crm_leads', 'crm_sales', 'crm_activities', 'crm_lead_owners', 'crm_audit', 'crm_contact_attempts', 'crm_events'];

export const CRM_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS crm_meta (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS crm_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT)`,

  // ---- identity ----
  `CREATE TABLE IF NOT EXISTS crm_users (
  id TEXT PRIMARY KEY,
  owner_ref TEXT UNIQUE,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  phone TEXT,
  phone_norm TEXT,
  role TEXT NOT NULL DEFAULT 'sales',
  department TEXT,
  photo TEXT,
  password_hash TEXT,
  password_salt TEXT,
  password_iters INTEGER,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','suspended','inactive')),
  archived INTEGER NOT NULL DEFAULT 0,
  login_disabled INTEGER NOT NULL DEFAULT 0,
  session_epoch INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER,
  legacy_id TEXT UNIQUE
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_users_status ON crm_users (status, archived)`,
  `CREATE TABLE IF NOT EXISTS crm_roles (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  perms TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 1
)`,
  `CREATE TABLE IF NOT EXISTS crm_user_perms (
  user_id TEXT NOT NULL REFERENCES crm_users(id),
  perm TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('grant','deny')),
  set_by TEXT,
  set_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, perm)
)`,
  `CREATE TABLE IF NOT EXISTS crm_invitations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES crm_users(id),
  kind TEXT NOT NULL CHECK (kind IN ('invite','reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_inv_user ON crm_invitations (user_id, kind)`,

  // ---- configuration (ordered, keys stable, deactivate never delete) ----
  cfg('crm_statuses', '\n  is_won INTEGER NOT NULL DEFAULT 0,\n  is_lost INTEGER NOT NULL DEFAULT 0,'),
  cfg('crm_classifications'),
  cfg('crm_sources'),
  cfg('crm_lost_reasons'),
  `CREATE TABLE IF NOT EXISTS crm_products (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT,
  price REAL,
  license_product TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,

  // ---- campaigns / ad sets / ads / spend ----
  `CREATE TABLE IF NOT EXISTS crm_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'meta',
  source_key TEXT REFERENCES crm_sources(key),
  external_id TEXT,
  objective TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  budget REAL,
  starts_on TEXT,
  ends_on TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_campaign_ext ON crm_campaigns (platform, external_id) WHERE external_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS crm_adsets (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES crm_campaigns(id),
  name TEXT NOT NULL,
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_adsets_campaign ON crm_adsets (campaign_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_adset_ext ON crm_adsets (external_id) WHERE external_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS crm_ads (
  id TEXT PRIMARY KEY,
  adset_id TEXT REFERENCES crm_adsets(id),
  campaign_id TEXT REFERENCES crm_campaigns(id),
  name TEXT NOT NULL,
  external_id TEXT,
  headline TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_ads_adset ON crm_ads (adset_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_ad_ext ON crm_ads (external_id) WHERE external_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS crm_spend (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES crm_campaigns(id),
  adset_id TEXT REFERENCES crm_adsets(id),
  ad_id TEXT REFERENCES crm_ads(id),
  scope_key TEXT NOT NULL,
  date TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount >= 0),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (scope_key, date)
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_spend_campaign ON crm_spend (campaign_id, date)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_spend_date ON crm_spend (date)`,                                     // zip 159: reports sum spend over a date range
  `CREATE INDEX IF NOT EXISTS ix_crm_spend_ad ON crm_spend (ad_id)`,                                       // zip 159: ad-level spend roll-up

  // ---- imports ----
  `CREATE TABLE IF NOT EXISTS crm_imports (
  id TEXT PRIMARY KEY,
  file_name TEXT,
  source TEXT,
  mapping TEXT,
  options TEXT,
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','committing','done')),
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES crm_users(id),
  created_by_name TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
)`,
  `CREATE TABLE IF NOT EXISTS crm_import_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id TEXT NOT NULL REFERENCES crm_imports(id),
  row_no INTEGER NOT NULL,
  data TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','created','updated','skipped','error')),
  error TEXT,
  warning TEXT,
  lead_id TEXT,
  duplicate_of TEXT,
  assigned_to TEXT,
  claim TEXT,
  claimed_at INTEGER,
  UNIQUE (import_id, row_no)
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_import_rows_status ON crm_import_rows (import_id, status, row_no)`,

  // ---- leads ----
  `CREATE TABLE IF NOT EXISTS crm_leads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  phone_norm TEXT,
  whatsapp TEXT,
  whatsapp_norm TEXT,
  email TEXT,
  business_name TEXT,
  location TEXT,
  notes TEXT,
${colsSql('crm_leads')}
  status_key TEXT NOT NULL DEFAULT 'new' REFERENCES crm_statuses(key),
  class_key TEXT REFERENCES crm_classifications(key),
  source_key TEXT REFERENCES crm_sources(key),
  lost_reason_key TEXT REFERENCES crm_lost_reasons(key),
  owner_id TEXT REFERENCES crm_users(id),
  created_by TEXT REFERENCES crm_users(id),
  created_by_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  assigned_at INTEGER,
  claimed_at INTEGER,
  first_contact_at INTEGER,
  first_response_at INTEGER,
  converted_at INTEGER,
  lost_at INTEGER,
  last_activity_at INTEGER,
  first_source_key TEXT,
  first_campaign_id TEXT REFERENCES crm_campaigns(id),
  first_adset_id TEXT REFERENCES crm_adsets(id),
  first_ad_id TEXT REFERENCES crm_ads(id),
  first_utm_source TEXT,
  first_utm_medium TEXT,
  first_utm_campaign TEXT,
  first_utm_content TEXT,
  first_utm_term TEXT,
  first_referrer TEXT,
  first_landing_url TEXT,
  first_touch_at INTEGER,
  import_id TEXT REFERENCES crm_imports(id),
  customer_id TEXT,
  merged_into_id TEXT,
  deleted_at INTEGER,
  legacy_id TEXT UNIQUE,
  legacy_json TEXT
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_leads_phone ON crm_leads (phone_norm)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_leads_wa ON crm_leads (whatsapp_norm)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_leads_email ON crm_leads (email)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_leads_owner ON crm_leads (owner_id, status_key)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_leads_created ON crm_leads (created_at)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_leads_status ON crm_leads (status_key)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_leads_source ON crm_leads (source_key)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_leads_lastcontact ON crm_leads (last_contacted_at)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_leads_campaign ON crm_leads (first_campaign_id, first_adset_id, first_ad_id)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_leads_ad ON crm_leads (first_ad_id)`,                                 // zip 159: the composite above cannot serve an ad-only filter or the ad re-link UPDATE
  `CREATE TABLE IF NOT EXISTS crm_lead_products (
  lead_id TEXT NOT NULL REFERENCES crm_leads(id),
  product_id TEXT NOT NULL REFERENCES crm_products(id),
  added_at INTEGER NOT NULL,
  added_by TEXT,
  PRIMARY KEY (lead_id, product_id)
)`,
  // ownership history; the row with ended_at IS NULL is the CURRENT owner (at most one per lead — enforced below)
  `CREATE TABLE IF NOT EXISTS crm_lead_owners (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES crm_leads(id),
  user_id TEXT REFERENCES crm_users(id),
  user_name TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('create','assign','claim','reassign','unassign','import','transfer','legacy')),
  from_user_id TEXT,
  by_user_id TEXT,
  by_name TEXT,
  reason TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_lead_one_owner ON crm_lead_owners (lead_id) WHERE ended_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS ix_crm_lead_owners_lead ON crm_lead_owners (lead_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_lead_owners_user ON crm_lead_owners (user_id)`,

  // ---- activity ----
  `CREATE TABLE IF NOT EXISTS crm_activities (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES crm_leads(id),
  user_id TEXT REFERENCES crm_users(id),
  user_name TEXT,
  type TEXT NOT NULL,
  summary TEXT,
  data TEXT,
  created_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_activities_lead ON crm_activities (lead_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_activities_user ON crm_activities (user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS crm_contact_attempts (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES crm_leads(id),
  user_id TEXT REFERENCES crm_users(id),
  user_name TEXT,
  method TEXT NOT NULL,
  outcome TEXT,
  notes TEXT,
  at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_contacts_lead ON crm_contact_attempts (lead_id, at)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_contacts_user ON crm_contact_attempts (user_id, at)`,
  `CREATE TABLE IF NOT EXISTS crm_followups (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES crm_leads(id),
  assigned_user_id TEXT REFERENCES crm_users(id),
  type TEXT NOT NULL DEFAULT 'call',
  due_at INTEGER NOT NULL,
  notes TEXT,
  remind_minutes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  completed_at INTEGER,
  completed_by TEXT,
  completion_notes TEXT,
  reminded_at INTEGER,
  overdue_notified_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_followups_due ON crm_followups (status, due_at)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_followups_lead ON crm_followups (lead_id)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_followups_user ON crm_followups (assigned_user_id, status, due_at)`,
  `CREATE TABLE IF NOT EXISTS crm_meetings (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES crm_leads(id),
  user_id TEXT REFERENCES crm_users(id),
  starts_at INTEGER NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 30,
  type TEXT NOT NULL DEFAULT 'call',
  location TEXT,
  link TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','confirmed','completed','rescheduled','cancelled','no_show')),
  reschedule_count INTEGER NOT NULL DEFAULT 0,
  first_starts_at INTEGER,
  reminded_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  legacy_id TEXT UNIQUE
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_meetings_start ON crm_meetings (starts_at)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_meetings_lead ON crm_meetings (lead_id)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_meetings_user ON crm_meetings (user_id, status)`,                 // zip 159: staff scorecard counts a person's meetings (was a full scan)

  // ---- WhatsApp inbox ----
  `CREATE TABLE IF NOT EXISTS crm_conversations (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  wa_id TEXT NOT NULL,
  contact_name TEXT,
  lead_id TEXT REFERENCES crm_leads(id),
  last_message_at INTEGER,
  last_message_text TEXT,
  last_direction TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  legacy_id TEXT UNIQUE,
  UNIQUE (channel, wa_id)
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_conv_lead ON crm_conversations (lead_id)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_conv_last ON crm_conversations (last_message_at)`,
  `CREATE TABLE IF NOT EXISTS crm_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES crm_conversations(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out','note')),
  ext_id TEXT UNIQUE,
  type TEXT NOT NULL DEFAULT 'text',
  text TEXT,
  sender_user_id TEXT REFERENCES crm_users(id),
  sender_name TEXT,
  status TEXT,
${colsSql('crm_messages')}
  at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_messages_conv ON crm_messages (conversation_id, at)`,

  // ---- customers link + revenue ----
  `CREATE TABLE IF NOT EXISTS crm_customers (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES crm_leads(id),
  license_client_id TEXT,
  license_type TEXT,
  product_key TEXT,
  name TEXT,
  phone TEXT,
  link TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_customers_lead ON crm_customers (lead_id)`,
  `CREATE TABLE IF NOT EXISTS crm_sales (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES crm_leads(id),
  customer_id TEXT REFERENCES crm_customers(id),
  product_id TEXT NOT NULL REFERENCES crm_products(id),
  product_label TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price REAL NOT NULL CHECK (unit_price >= 0),
  discount REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total REAL NOT NULL CHECK (total >= 0),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('paid','partial','unpaid')),
  amount_paid REAL NOT NULL DEFAULT 0,
  closed_by TEXT REFERENCES crm_users(id),
  closed_by_name TEXT,
  source_key TEXT,
  campaign_id TEXT,
  adset_id TEXT,
  ad_id TEXT,
  sold_at INTEGER NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_sales_sold ON crm_sales (sold_at)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_sales_lead ON crm_sales (lead_id)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_sales_staff ON crm_sales (closed_by, sold_at)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_sales_campaign ON crm_sales (campaign_id, adset_id, ad_id)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_sales_ad ON crm_sales (ad_id)`,                                       // zip 159: same, for sales
  `CREATE INDEX IF NOT EXISTS ix_crm_sales_product ON crm_sales (product_id)`,

  // ---- attribution ----
  `CREATE TABLE IF NOT EXISTS crm_attribution_events (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES crm_leads(id),
  kind TEXT NOT NULL,
  source_key TEXT,
  campaign_id TEXT REFERENCES crm_campaigns(id),
  adset_id TEXT REFERENCES crm_adsets(id),
  ad_id TEXT REFERENCES crm_ads(id),
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  referrer TEXT,
  landing_url TEXT,
  ext_campaign_id TEXT,
  ext_adset_id TEXT,
  ext_ad_id TEXT,
  click_id TEXT,
  headline TEXT,
  external_id TEXT UNIQUE,
  resolved INTEGER NOT NULL DEFAULT 1,
  raw TEXT,
  at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_attr_lead ON crm_attribution_events (lead_id, at)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_attr_unresolved ON crm_attribution_events (resolved)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_attr_ad ON crm_attribution_events (ad_id)`,                           // zip 159: the ad re-link UPDATE

  // ---- notifications + audit ----
  `CREATE TABLE IF NOT EXISTS crm_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES crm_users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  lead_id TEXT,
  entity TEXT,
  entity_id TEXT,
  dedupe_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  read_at INTEGER
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_notif_user ON crm_notifications (user_id, read_at, created_at)`,
  `CREATE TABLE IF NOT EXISTS crm_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  user_name TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  prev TEXT,
  next TEXT,
  ip TEXT,
  at INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_audit_entity ON crm_audit (entity, entity_id, at)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_audit_user ON crm_audit (user_id, at)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_audit_at ON crm_audit (at)`,

  // ---- automation-ready event log: every business event is appended here (lead.created, lead.claimed, lead.contacted, followup.created, meeting.created,
  // lead.converted, sale.recorded, message.received ...). A future worker / webhook / queue reads GET /api/crm/events and acknowledges what it handled. ----
  `CREATE TABLE IF NOT EXISTS crm_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  lead_id TEXT,
  actor_id TEXT,
  actor_name TEXT,
  data TEXT,
  at INTEGER NOT NULL,
  processed_at INTEGER
)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_events_name ON crm_events (name, id)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_events_pending ON crm_events (processed_at, id)`,
  `CREATE INDEX IF NOT EXISTS ix_crm_events_lead ON crm_events (lead_id, id)`,

  ...noDelete.map((t) => `CREATE TRIGGER IF NOT EXISTS no_delete_${t} BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, 'crm history is never deleted'); END`),
  `CREATE TRIGGER IF NOT EXISTS no_update_crm_audit BEFORE UPDATE ON crm_audit BEGIN SELECT RAISE(ABORT, 'the audit trail is append-only'); END`,
  // an event may only be acknowledged (processed_at), never rewritten
  `CREATE TRIGGER IF NOT EXISTS no_rewrite_crm_events BEFORE UPDATE OF name, entity, entity_id, lead_id, actor_id, actor_name, data, at ON crm_events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END`,
];

// ---------------- zip 161: objects added for speed (schema v5). migrations/0004_crm_speed.sql is GENERATED from this list. ----------------
// Every statement is IF NOT EXISTS and only adds an index (no table, no data change). EXPLAIN QUERY PLAN (tools/audit-d1-queries.mjs, tests/zip161-crm-speed.test.mjs)
// shows which list query each one serves.
export const CRM_SPEED_SCHEMA = [
  `CREATE INDEX IF NOT EXISTS ix_crm_leads_owner_created ON crm_leads (owner_id, created_at)`,             // "my leads" / a staff filter, newest first (was: ix_crm_leads_owner + a sort of every one of their leads)
  `CREATE INDEX IF NOT EXISTS ix_crm_leads_updated ON crm_leads (updated_at)`,                             // sort = updated, and the keyset cursor of that sort
  `CREATE INDEX IF NOT EXISTS ix_crm_leads_status_created ON crm_leads (status_key, created_at)`,          // the status filter, newest first
  `CREATE INDEX IF NOT EXISTS ix_crm_followups_lead_open ON crm_followups (lead_id, status, due_at)`,      // the "next follow-up" of every lead row and the follow=... filters: (lead, open, earliest) is one index probe
  `CREATE INDEX IF NOT EXISTS ix_crm_notif_created ON crm_notifications (user_id, created_at)`,            // the notification list is "mine, newest first"
  `CREATE INDEX IF NOT EXISTS ix_crm_conv_unread ON crm_conversations (last_message_at) WHERE unread_count > 0`,   // the inbox badge and the Unread filter
];
// OPTIONAL full-text search over leads (migrations-optional/0005_crm_search.sql). NOT part of CRM_SCHEMA: a database that has this virtual table cannot be exported with
// `wrangler d1 export` (a documented D1 limitation for virtual tables), so it is only created when the owner turns it on (CRM_FTS=1) or applies the migration by hand.
// trigram tokenizer = substring search like LIKE '%x%' (case-insensitive, 3+ characters); shorter terms use LIKE. The table is a copy of the searchable text, kept
// in step by triggers on every write path (INSERT and UPDATE of those columns; crm_leads rows are never deleted, a soft delete only sets deleted_at, and the query
// filters on deleted_at). rowid = crm_leads.rowid.
const FTS_COLS = `name, business_name, email, location, phones`;
const ftsVals = (r) => `${r}.name, ${r}.business_name, ${r}.email, ${r}.location, COALESCE(${r}.phone_norm, '') || ' ' || COALESCE(${r}.whatsapp_norm, '')`;
export const CRM_FTS_SCHEMA = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS crm_leads_fts USING fts5(${FTS_COLS}, tokenize = 'trigram')`,
  `CREATE TRIGGER IF NOT EXISTS crm_leads_fts_ai AFTER INSERT ON crm_leads BEGIN INSERT INTO crm_leads_fts (rowid, ${FTS_COLS}) VALUES (new.rowid, ${ftsVals('new')}); END`,
  `CREATE TRIGGER IF NOT EXISTS crm_leads_fts_au AFTER UPDATE OF name, business_name, email, location, phone_norm, whatsapp_norm ON crm_leads BEGIN DELETE FROM crm_leads_fts WHERE rowid = old.rowid; INSERT INTO crm_leads_fts (rowid, ${FTS_COLS}) VALUES (new.rowid, ${ftsVals('new')}); END`,
  `INSERT INTO crm_leads_fts (rowid, ${FTS_COLS}) SELECT l.rowid, ${ftsVals('l')} FROM crm_leads l WHERE l.rowid NOT IN (SELECT rowid FROM crm_leads_fts)`,        // back-fill of the leads that existed before (a no-op when nothing is missing)
];

// ---------------- permission catalogue + role defaults (also seeded into crm_roles) ----------------
export const PERM_KEYS = [
  'leads.view', 'leads.all', 'leads.create', 'leads.edit', 'leads.delete', 'leads.assign', 'leads.claim', 'leads.import', 'leads.export',
  'staff.view', 'staff.add', 'staff.edit', 'staff.deactivate', 'staff.roles',
  'campaigns.view', 'campaigns.create', 'campaigns.edit', 'campaigns.revenue',
  'revenue.own', 'revenue.team', 'revenue.company',
  'reports.own', 'reports.team', 'reports.company',
  'settings.manage', 'settings.integrations', 'settings.products', 'settings.statuses',
  'inbox.view', 'inbox.reply', 'meetings.manage', 'followups.manage', 'sales.record', 'audit.view',
];
const MANAGER = PERM_KEYS.filter((k) => !['leads.delete', 'staff.roles', 'settings.manage', 'settings.integrations', 'revenue.company', 'reports.company', 'audit.view'].includes(k));
const SALES = ['leads.view', 'leads.create', 'leads.edit', 'leads.claim', 'revenue.own', 'reports.own', 'inbox.view', 'inbox.reply', 'meetings.manage', 'followups.manage', 'sales.record'];
export const ROLE_DEFAULTS = {
  owner: { label: 'Owner', perms: PERM_KEYS },
  manager: { label: 'Manager', perms: MANAGER },
  sales: { label: 'Sales', perms: SALES },
};

// ---------------- default configuration ----------------
// The initial statuses of the CRM spec (section 22), in order. 'new', 'won' and 'lost' are built in (the rest can be renamed, re-ordered, switched off).
// 'lost'-type statuses need a lost reason; Not Interested / Invalid Number supply theirs (see LOST_REASON_OF in leads.js).
export const DEFAULT_STATUSES = [
  { key: 'new', label: 'New', color: '#3b82f6', system: 1 },
  { key: 'unassigned', label: 'Unassigned', color: '#94a3b8' },
  { key: 'assigned', label: 'Assigned', color: '#0ea5e9' },
  { key: 'contacting', label: 'Contacting', color: '#14b8a6' },
  { key: 'contacted', label: 'Contacted', color: '#06b6d4' },
  { key: 'awaiting_response', label: 'Awaiting response', color: '#eab308' },
  { key: 'followup_required', label: 'Follow-up required', color: '#fb923c' },
  { key: 'qualified', label: 'Qualified', color: '#8b5cf6' },
  { key: 'potential', label: 'Potential', color: '#a855f7' },
  { key: 'meeting', label: 'Meeting scheduled', color: '#f59e0b' },
  { key: 'proposal', label: 'Proposal / offer sent', color: '#ec4899' },
  { key: 'negotiation', label: 'Negotiating', color: '#f97316' },
  { key: 'won', label: 'Won / converted', color: '#16a34a', system: 1, won: 1 },
  { key: 'lost', label: 'Dead / lost', color: '#6b7280', system: 1, lost: 1 },
  { key: 'not_interested', label: 'Not interested', color: '#9ca3af', lost: 1 },
  { key: 'invalid_number', label: 'Invalid number', color: '#78716c', lost: 1 },
];
export const DEFAULT_CLASSES = [
  { key: 'hot', label: 'Hot', color: '#dc2626' }, { key: 'warm', label: 'Warm', color: '#f59e0b' }, { key: 'cold', label: 'Cold', color: '#3b82f6' },
  { key: 'potential', label: 'Potential', color: '#8b5cf6' }, { key: 'dead', label: 'Dead', color: '#6b7280' },
];
export const DEFAULT_SOURCES = [
  { key: 'website', label: 'Website form', system: 1 }, { key: 'signup', label: 'App sign-up / demo', system: 1 }, { key: 'whatsapp', label: 'WhatsApp', system: 1 }, { key: 'meta_ads', label: 'Meta ads (Facebook / Instagram)', system: 1 },
  { key: 'facebook', label: 'Facebook' }, { key: 'instagram', label: 'Instagram' },
  { key: 'google_ads', label: 'Google ads' }, { key: 'referral', label: 'Referral' }, { key: 'walk_in', label: 'Walk-in' }, { key: 'phone', label: 'Phone call' },
  { key: 'import', label: 'Imported list', system: 1 }, { key: 'manual', label: 'Added manually', system: 1 }, { key: 'legacy', label: 'Old Leads tab', system: 1 }, { key: 'other', label: 'Other' },
];
export const DEFAULT_LOST_REASONS = [
  { key: 'no_response', label: 'No response' }, { key: 'price', label: 'Price too high' }, { key: 'competitor', label: 'Chose a competitor' },
  { key: 'not_interested', label: 'Not interested' }, { key: 'wrong_number', label: 'Wrong / invalid number' }, { key: 'duplicate', label: 'Duplicate' }, { key: 'other', label: 'Other' },
];

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : q(v));
// Seeds as {sql,args}; created_at is a fixed 0 so the generated migration is deterministic. INSERT OR IGNORE: never overwrites what an admin changed.
export function crmSeeds() {
  const out = [];
  const cfgRows = (table, rows, pre, withFlags) => rows.forEach((r, i) => {
    out.push(withFlags
      ? { sql: `INSERT OR IGNORE INTO ${table} (id, key, label, color, position, active, is_system, is_won, is_lost, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 0, 0)`, args: [pre + r.key, r.key, r.label, r.color || null, i, r.system ? 1 : 0, r.won ? 1 : 0, r.lost ? 1 : 0] }
      : { sql: `INSERT OR IGNORE INTO ${table} (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, 0, 0)`, args: [pre + r.key, r.key, r.label, r.color || null, i, r.system ? 1 : 0] });
  });
  cfgRows('crm_statuses', DEFAULT_STATUSES, 'st_', true);
  cfgRows('crm_classifications', DEFAULT_CLASSES, 'cl_');
  cfgRows('crm_sources', DEFAULT_SOURCES, 'so_');
  cfgRows('crm_lost_reasons', DEFAULT_LOST_REASONS, 'lr_');
  for (const [key, r] of Object.entries(ROLE_DEFAULTS)) out.push({ sql: `INSERT OR IGNORE INTO crm_roles (key, label, perms, is_system) VALUES (?, ?, ?, 1)`, args: [key, r.label, JSON.stringify(r.perms)] });
  listProducts().forEach((p, i) => out.push({ sql: `INSERT OR IGNORE INTO crm_products (id, key, label, license_product, active, position, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, 0, 0)`, args: ['pr_' + p.id, p.id, p.label, p.id, i] }));
  return out;
}
export const CRM_SEEDS = crmSeeds();
export const seedSql = () => CRM_SEEDS.map((s) => { let i = 0; return s.sql.replace(/\?/g, () => lit(s.args[i++])) + ';'; });

const ready = new WeakMap();
// Adds the columns a table created at an older schema version lacks. A table that does not exist yet is left to CREATE TABLE.
async function upgradeColumns(db) {
  for (const [table, cols] of Object.entries(CRM_COLUMN_ADDS)) {
    let have;
    try { have = new Set(((await db.prepare(`PRAGMA table_info(${table})`).all()).results || []).map((r) => r.name)); } catch (e) { continue; }
    if (!have.size) continue;
    for (const [c, ddl] of cols) if (!have.has(c)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${c} ${ddl}`).run();
  }
}
// What the database can do beyond the basics, decided once per instance: { fts } (crm_leads_fts exists and may be used).
export const crmFeatures = (db) => ready.get((db && db._raw) || db) || { fts: false };
// Creates the CRM tables on first use and seeds the defaults (idempotent). Returns true when the database is usable.
// zip 161: the "is it already set up?" check is ONE round trip (schema version, seed tag and the FTS table together; it was two, then a third for the seed).
//   opts.fts === true: create the optional full-text table when it is missing (CRM_FTS=1). Whether to USE an existing one is the caller's call (CRM_FTS=0 in leads.js).
export async function ensureCrmSchema(db, opts = {}) {
  if (!db) return false;
  const key = db._raw || db;                                     // a request's counting wrapper (core.js) and the real handle are the same database
  const known = ready.get(key);
  if (known) {
    if (opts.fts === true && !known.fts && !known.ftsTried) { known.ftsTried = true; try { await db.batch(CRM_FTS_SCHEMA.map((s) => db.prepare(s))); known.fts = true; } catch (e) { console.error('crm fts unavailable, searching with LIKE', e && e.message); } }
    return true;
  }
  let schemaOk = false, seedCur = null, hasFts = false;
  try {
    const [rm, rf] = await db.batch([db.prepare(`SELECT k, v FROM crm_meta WHERE k IN ('schema', 'seed')`), db.prepare(`SELECT name FROM sqlite_master WHERE name = 'crm_leads_fts'`)]);
    for (const r of rm.results || []) { if (r.k === 'schema') schemaOk = Number(r.v) >= CRM_SCHEMA_VERSION; else if (r.k === 'seed') seedCur = r.v; }
    hasFts = !!(rf.results && rf.results.length);
  } catch (e) { schemaOk = false; }
  if (!schemaOk) {
    await upgradeColumns(db);                                    // v1 -> v2 (before the batch: it creates indexes on the new columns)
    await db.batch([...CRM_SCHEMA, ...CRM_SPEED_SCHEMA].map((s) => db.prepare(s)));
    await db.prepare(`INSERT INTO crm_meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(String(CRM_SCHEMA_VERSION)).run();
  }
  const seedTag = `${CRM_SEED_VERSION}:${listProducts().map((p) => p.id).join(',')}`;
  if (seedCur !== seedTag) {
    await db.batch(CRM_SEEDS.map((s) => db.prepare(s.sql).bind(...s.args)));
    // zip 164: people who created an account / asked for a demo are "App sign-up / demo", not "Website form" (the public website's own contact form). Once, when the seed version changes;
    // only leads that came from the sign-up flow (legacy_id 'demo:...') are moved, and never a lead someone changed to another source by hand.
    await db.batch([
      db.prepare(`UPDATE crm_leads SET source_key = 'signup' WHERE source_key = 'website' AND legacy_id LIKE 'demo:%'`),
      db.prepare(`UPDATE crm_leads SET first_source_key = 'signup' WHERE first_source_key = 'website' AND legacy_id LIKE 'demo:%'`),
    ]);
    await db.prepare(`INSERT INTO crm_meta (k, v) VALUES ('seed', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(seedTag).run();
  }
  let tried = false;
  if (!hasFts && opts.fts === true) {
    tried = true;
    try { await db.batch(CRM_FTS_SCHEMA.map((s) => db.prepare(s))); hasFts = true; }
    catch (e) { console.error('crm fts unavailable, searching with LIKE', e && e.message); }        // D1 without FTS5 / trigram: everything keeps working, search just scans
  }
  ready.set(key, { fts: hasFts, ftsTried: tried });
  return true;
}
