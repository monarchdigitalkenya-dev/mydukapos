-- GENERATED from functions/api/_crm/schema.js by tools/gen-migration.mjs — do not edit by hand.
-- Safe to run more than once (IF NOT EXISTS / INSERT OR IGNORE) and never drops or changes existing data.

CREATE TABLE IF NOT EXISTS crm_meta (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS crm_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT);

CREATE TABLE IF NOT EXISTS crm_users (
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
);

CREATE INDEX IF NOT EXISTS ix_crm_users_status ON crm_users (status, archived);

CREATE TABLE IF NOT EXISTS crm_roles (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  perms TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS crm_user_perms (
  user_id TEXT NOT NULL REFERENCES crm_users(id),
  perm TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('grant','deny')),
  set_by TEXT,
  set_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, perm)
);

CREATE TABLE IF NOT EXISTS crm_invitations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES crm_users(id),
  kind TEXT NOT NULL CHECK (kind IN ('invite','reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_crm_inv_user ON crm_invitations (user_id, kind);

CREATE TABLE IF NOT EXISTS crm_statuses (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,
  is_won INTEGER NOT NULL DEFAULT 0,
  is_lost INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS crm_classifications (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS crm_sources (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS crm_lost_reasons (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS crm_products (
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
);

CREATE TABLE IF NOT EXISTS crm_campaigns (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_campaign_ext ON crm_campaigns (platform, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS crm_adsets (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES crm_campaigns(id),
  name TEXT NOT NULL,
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_crm_adsets_campaign ON crm_adsets (campaign_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_adset_ext ON crm_adsets (external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS crm_ads (
  id TEXT PRIMARY KEY,
  adset_id TEXT REFERENCES crm_adsets(id),
  campaign_id TEXT REFERENCES crm_campaigns(id),
  name TEXT NOT NULL,
  external_id TEXT,
  headline TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_crm_ads_adset ON crm_ads (adset_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_ad_ext ON crm_ads (external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS crm_spend (
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
);

CREATE INDEX IF NOT EXISTS ix_crm_spend_campaign ON crm_spend (campaign_id, date);

CREATE TABLE IF NOT EXISTS crm_imports (
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
);

CREATE TABLE IF NOT EXISTS crm_import_rows (
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
);

CREATE INDEX IF NOT EXISTS ix_crm_import_rows_status ON crm_import_rows (import_id, status, row_no);

CREATE TABLE IF NOT EXISTS crm_leads (
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
  country TEXT,
  estimated_value REAL CHECK (estimated_value IS NULL OR estimated_value >= 0),
  actual_value REAL,
  expected_close_date TEXT,
  next_action TEXT,
  contact_attempts INTEGER NOT NULL DEFAULT 0,
  last_contacted_at INTEGER,
  last_contacted_by TEXT REFERENCES crm_users(id),
  last_contacted_by_name TEXT,
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
);

CREATE INDEX IF NOT EXISTS ix_crm_leads_phone ON crm_leads (phone_norm);

CREATE INDEX IF NOT EXISTS ix_crm_leads_wa ON crm_leads (whatsapp_norm);

CREATE INDEX IF NOT EXISTS ix_crm_leads_email ON crm_leads (email);

CREATE INDEX IF NOT EXISTS ix_crm_leads_owner ON crm_leads (owner_id, status_key);

CREATE INDEX IF NOT EXISTS ix_crm_leads_created ON crm_leads (created_at);

CREATE INDEX IF NOT EXISTS ix_crm_leads_status ON crm_leads (status_key);

CREATE INDEX IF NOT EXISTS ix_crm_leads_source ON crm_leads (source_key);

CREATE INDEX IF NOT EXISTS ix_crm_leads_lastcontact ON crm_leads (last_contacted_at);

CREATE INDEX IF NOT EXISTS ix_crm_leads_campaign ON crm_leads (first_campaign_id, first_adset_id, first_ad_id);

CREATE TABLE IF NOT EXISTS crm_lead_products (
  lead_id TEXT NOT NULL REFERENCES crm_leads(id),
  product_id TEXT NOT NULL REFERENCES crm_products(id),
  added_at INTEGER NOT NULL,
  added_by TEXT,
  PRIMARY KEY (lead_id, product_id)
);

CREATE TABLE IF NOT EXISTS crm_lead_owners (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_lead_one_owner ON crm_lead_owners (lead_id) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_crm_lead_owners_lead ON crm_lead_owners (lead_id, started_at);

CREATE INDEX IF NOT EXISTS ix_crm_lead_owners_user ON crm_lead_owners (user_id);

CREATE TABLE IF NOT EXISTS crm_activities (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES crm_leads(id),
  user_id TEXT REFERENCES crm_users(id),
  user_name TEXT,
  type TEXT NOT NULL,
  summary TEXT,
  data TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_crm_activities_lead ON crm_activities (lead_id, created_at);

CREATE INDEX IF NOT EXISTS ix_crm_activities_user ON crm_activities (user_id, created_at);

CREATE TABLE IF NOT EXISTS crm_contact_attempts (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES crm_leads(id),
  user_id TEXT REFERENCES crm_users(id),
  user_name TEXT,
  method TEXT NOT NULL,
  outcome TEXT,
  notes TEXT,
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_crm_contacts_lead ON crm_contact_attempts (lead_id, at);

CREATE INDEX IF NOT EXISTS ix_crm_contacts_user ON crm_contact_attempts (user_id, at);

CREATE TABLE IF NOT EXISTS crm_followups (
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
);

CREATE INDEX IF NOT EXISTS ix_crm_followups_due ON crm_followups (status, due_at);

CREATE INDEX IF NOT EXISTS ix_crm_followups_lead ON crm_followups (lead_id);

CREATE INDEX IF NOT EXISTS ix_crm_followups_user ON crm_followups (assigned_user_id, status, due_at);

CREATE TABLE IF NOT EXISTS crm_meetings (
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
);

CREATE INDEX IF NOT EXISTS ix_crm_meetings_start ON crm_meetings (starts_at);

CREATE INDEX IF NOT EXISTS ix_crm_meetings_lead ON crm_meetings (lead_id);

CREATE TABLE IF NOT EXISTS crm_conversations (
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
);

CREATE INDEX IF NOT EXISTS ix_crm_conv_lead ON crm_conversations (lead_id);

CREATE INDEX IF NOT EXISTS ix_crm_conv_last ON crm_conversations (last_message_at);

CREATE TABLE IF NOT EXISTS crm_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES crm_conversations(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out','note')),
  ext_id TEXT UNIQUE,
  type TEXT NOT NULL DEFAULT 'text',
  text TEXT,
  sender_user_id TEXT REFERENCES crm_users(id),
  sender_name TEXT,
  status TEXT,
  media_id TEXT,
  media_mime TEXT,
  media_name TEXT,
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_crm_messages_conv ON crm_messages (conversation_id, at);

CREATE TABLE IF NOT EXISTS crm_customers (
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
);

CREATE INDEX IF NOT EXISTS ix_crm_customers_lead ON crm_customers (lead_id);

CREATE TABLE IF NOT EXISTS crm_sales (
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
);

CREATE INDEX IF NOT EXISTS ix_crm_sales_sold ON crm_sales (sold_at);

CREATE INDEX IF NOT EXISTS ix_crm_sales_lead ON crm_sales (lead_id);

CREATE INDEX IF NOT EXISTS ix_crm_sales_staff ON crm_sales (closed_by, sold_at);

CREATE INDEX IF NOT EXISTS ix_crm_sales_campaign ON crm_sales (campaign_id, adset_id, ad_id);

CREATE INDEX IF NOT EXISTS ix_crm_sales_product ON crm_sales (product_id);

CREATE TABLE IF NOT EXISTS crm_attribution_events (
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
);

CREATE INDEX IF NOT EXISTS ix_crm_attr_lead ON crm_attribution_events (lead_id, at);

CREATE INDEX IF NOT EXISTS ix_crm_attr_unresolved ON crm_attribution_events (resolved);

CREATE TABLE IF NOT EXISTS crm_notifications (
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
);

CREATE INDEX IF NOT EXISTS ix_crm_notif_user ON crm_notifications (user_id, read_at, created_at);

CREATE TABLE IF NOT EXISTS crm_audit (
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
);

CREATE INDEX IF NOT EXISTS ix_crm_audit_entity ON crm_audit (entity, entity_id, at);

CREATE INDEX IF NOT EXISTS ix_crm_audit_user ON crm_audit (user_id, at);

CREATE INDEX IF NOT EXISTS ix_crm_audit_at ON crm_audit (at);

CREATE TABLE IF NOT EXISTS crm_events (
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
);

CREATE INDEX IF NOT EXISTS ix_crm_events_name ON crm_events (name, id);

CREATE INDEX IF NOT EXISTS ix_crm_events_pending ON crm_events (processed_at, id);

CREATE INDEX IF NOT EXISTS ix_crm_events_lead ON crm_events (lead_id, id);

CREATE TRIGGER IF NOT EXISTS no_delete_crm_users BEFORE DELETE ON crm_users BEGIN SELECT RAISE(ABORT, 'crm history is never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_crm_leads BEFORE DELETE ON crm_leads BEGIN SELECT RAISE(ABORT, 'crm history is never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_crm_sales BEFORE DELETE ON crm_sales BEGIN SELECT RAISE(ABORT, 'crm history is never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_crm_activities BEFORE DELETE ON crm_activities BEGIN SELECT RAISE(ABORT, 'crm history is never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_crm_lead_owners BEFORE DELETE ON crm_lead_owners BEGIN SELECT RAISE(ABORT, 'crm history is never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_crm_audit BEFORE DELETE ON crm_audit BEGIN SELECT RAISE(ABORT, 'crm history is never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_crm_contact_attempts BEFORE DELETE ON crm_contact_attempts BEGIN SELECT RAISE(ABORT, 'crm history is never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_crm_events BEFORE DELETE ON crm_events BEGIN SELECT RAISE(ABORT, 'crm history is never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_update_crm_audit BEFORE UPDATE ON crm_audit BEGIN SELECT RAISE(ABORT, 'the audit trail is append-only'); END;

CREATE TRIGGER IF NOT EXISTS no_rewrite_crm_events BEFORE UPDATE OF name, entity, entity_id, lead_id, actor_id, actor_name, data, at ON crm_events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

-- default statuses, classifications, sources, lost reasons, roles and products (never overwrites edits)
INSERT OR IGNORE INTO crm_statuses (id, key, label, color, position, active, is_system, is_won, is_lost, created_at, updated_at) VALUES ('st_new', 'new', 'New', '#3b82f6', 0, 1, 1, 0, 0, 0, 0);
INSERT OR IGNORE INTO crm_statuses (id, key, label, color, position, active, is_system, is_won, is_lost, created_at, updated_at) VALUES ('st_unassigned', 'unassigned', 'Unassigned', '#94a3b8', 1, 1, 0, 0, 0, 0, 0);
INSERT OR IGNORE INTO crm_statuses (id, key, label, color, position, active, is_system, is_won, is_lost, created_at, updated_at) VALUES ('st_assigned', 'assigned', 'Assigned', '#0ea5e9', 2, 1, 0, 0, 0, 0, 0);
INSERT OR IGNORE INTO crm_statuses (id, key, label, color, position, active, is_system, is_won, is_lost, created_at, updated_at) VALUES ('st_contacting', 'contacting', 'Contacting', '#14b8a6', 3, 1, 0, 0, 0, 0, 0);
INSERT OR IGNORE INTO crm_statuses (id, key, label, color, position, active, is_system, is_won, is_lost, created_at, updated_at) VALUES ('st_contacted', 'contacted', 'Contacted', '#06b6d4', 4, 1, 0, 0, 0, 0, 0);
INSERT OR IGNORE INTO crm_statuses (id, key, label, color, position, active, is_system, is_won, is_lost, created_at, updated_at) VALUES ('st_awaiting_response', 'awaiting_response', 'Awaiting response', '#eab308', 5, 1, 0, 0, 0, 0, 0);
INSERT OR IGNORE INTO crm_statuses (id, key, label, color, position, active, is_system, is_won, is_lost, created_at, updated_at) VALUES ('st_followup_required', 'followup_required', 'Follow-up required', '#fb923c', 6, 1, 0, 0, 0, 0, 0);
INSERT OR IGNORE INTO crm_statuses (id, key, label, color, position, active, is_system, is_won, is_lost, created_at, updated_at) VALUES ('st_qualified', 'qualified', 'Qualified', '#8b5cf6', 7, 1, 0, 0, 0, 0, 0);
INSERT OR IGNORE INTO crm_statuses (id, key, label, color, position, active, is_system, is_won, is_lost, created_at, updated_at) VALUES ('st_potential', 'potential', 'Potential', '#a855f7', 8, 1, 0, 0, 0, 0, 0);
INSERT OR IGNORE INTO crm_statuses (id, key, label, color, position, active, is_system, is_won, is_lost, created_at, updated_at) VALUES ('st_meeting', 'meeting', 'Meeting scheduled', '#f59e0b', 9, 1, 0, 0, 0, 0, 0);
INSERT OR IGNORE INTO crm_statuses (id, key, label, color, position, active, is_system, is_won, is_lost, created_at, updated_at) VALUES ('st_proposal', 'proposal', 'Proposal / offer sent', '#ec4899', 10, 1, 0, 0, 0, 0, 0);
INSERT OR IGNORE INTO crm_statuses (id, key, label, color, position, active, is_system, is_won, is_lost, created_at, updated_at) VALUES ('st_negotiation', 'negotiation', 'Negotiating', '#f97316', 11, 1, 0, 0, 0, 0, 0);
INSERT OR IGNORE INTO crm_statuses (id, key, label, color, position, active, is_system, is_won, is_lost, created_at, updated_at) VALUES ('st_won', 'won', 'Won / converted', '#16a34a', 12, 1, 1, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_statuses (id, key, label, color, position, active, is_system, is_won, is_lost, created_at, updated_at) VALUES ('st_lost', 'lost', 'Dead / lost', '#6b7280', 13, 1, 1, 0, 1, 0, 0);
INSERT OR IGNORE INTO crm_statuses (id, key, label, color, position, active, is_system, is_won, is_lost, created_at, updated_at) VALUES ('st_not_interested', 'not_interested', 'Not interested', '#9ca3af', 14, 1, 0, 0, 1, 0, 0);
INSERT OR IGNORE INTO crm_statuses (id, key, label, color, position, active, is_system, is_won, is_lost, created_at, updated_at) VALUES ('st_invalid_number', 'invalid_number', 'Invalid number', '#78716c', 15, 1, 0, 0, 1, 0, 0);
INSERT OR IGNORE INTO crm_classifications (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('cl_hot', 'hot', 'Hot', '#dc2626', 0, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_classifications (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('cl_warm', 'warm', 'Warm', '#f59e0b', 1, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_classifications (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('cl_cold', 'cold', 'Cold', '#3b82f6', 2, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_classifications (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('cl_potential', 'potential', 'Potential', '#8b5cf6', 3, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_classifications (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('cl_dead', 'dead', 'Dead', '#6b7280', 4, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_sources (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('so_website', 'website', 'Website form', NULL, 0, 1, 1, 0, 0);
INSERT OR IGNORE INTO crm_sources (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('so_whatsapp', 'whatsapp', 'WhatsApp', NULL, 1, 1, 1, 0, 0);
INSERT OR IGNORE INTO crm_sources (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('so_meta_ads', 'meta_ads', 'Meta ads (Facebook / Instagram)', NULL, 2, 1, 1, 0, 0);
INSERT OR IGNORE INTO crm_sources (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('so_facebook', 'facebook', 'Facebook', NULL, 3, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_sources (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('so_instagram', 'instagram', 'Instagram', NULL, 4, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_sources (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('so_google_ads', 'google_ads', 'Google ads', NULL, 5, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_sources (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('so_referral', 'referral', 'Referral', NULL, 6, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_sources (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('so_walk_in', 'walk_in', 'Walk-in', NULL, 7, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_sources (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('so_phone', 'phone', 'Phone call', NULL, 8, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_sources (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('so_import', 'import', 'Imported list', NULL, 9, 1, 1, 0, 0);
INSERT OR IGNORE INTO crm_sources (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('so_manual', 'manual', 'Added manually', NULL, 10, 1, 1, 0, 0);
INSERT OR IGNORE INTO crm_sources (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('so_legacy', 'legacy', 'Old Leads tab', NULL, 11, 1, 1, 0, 0);
INSERT OR IGNORE INTO crm_sources (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('so_other', 'other', 'Other', NULL, 12, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_lost_reasons (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('lr_no_response', 'no_response', 'No response', NULL, 0, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_lost_reasons (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('lr_price', 'price', 'Price too high', NULL, 1, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_lost_reasons (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('lr_competitor', 'competitor', 'Chose a competitor', NULL, 2, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_lost_reasons (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('lr_not_interested', 'not_interested', 'Not interested', NULL, 3, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_lost_reasons (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('lr_wrong_number', 'wrong_number', 'Wrong / invalid number', NULL, 4, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_lost_reasons (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('lr_duplicate', 'duplicate', 'Duplicate', NULL, 5, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_lost_reasons (id, key, label, color, position, active, is_system, created_at, updated_at) VALUES ('lr_other', 'other', 'Other', NULL, 6, 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_roles (key, label, perms, is_system) VALUES ('owner', 'Owner', '["leads.view","leads.all","leads.create","leads.edit","leads.delete","leads.assign","leads.claim","leads.import","leads.export","staff.view","staff.add","staff.edit","staff.deactivate","staff.roles","campaigns.view","campaigns.create","campaigns.edit","campaigns.revenue","revenue.own","revenue.team","revenue.company","reports.own","reports.team","reports.company","settings.manage","settings.integrations","settings.products","settings.statuses","inbox.view","inbox.reply","meetings.manage","followups.manage","sales.record","audit.view"]', 1);
INSERT OR IGNORE INTO crm_roles (key, label, perms, is_system) VALUES ('manager', 'Manager', '["leads.view","leads.all","leads.create","leads.edit","leads.assign","leads.claim","leads.import","leads.export","staff.view","staff.add","staff.edit","staff.deactivate","campaigns.view","campaigns.create","campaigns.edit","campaigns.revenue","revenue.own","revenue.team","reports.own","reports.team","settings.products","settings.statuses","inbox.view","inbox.reply","meetings.manage","followups.manage","sales.record"]', 1);
INSERT OR IGNORE INTO crm_roles (key, label, perms, is_system) VALUES ('sales', 'Sales', '["leads.view","leads.create","leads.edit","leads.claim","revenue.own","reports.own","inbox.view","inbox.reply","meetings.manage","followups.manage","sales.record"]', 1);
INSERT OR IGNORE INTO crm_products (id, key, label, license_product, active, position, created_at, updated_at) VALUES ('pr_shop', 'shop', 'Shop POS', 'shop', 1, 0, 0, 0);
INSERT OR IGNORE INTO crm_products (id, key, label, license_product, active, position, created_at, updated_at) VALUES ('pr_hotel', 'hotel', 'Hotel/Restaurant/Bar POS', 'hotel', 1, 1, 0, 0);
INSERT OR IGNORE INTO crm_products (id, key, label, license_product, active, position, created_at, updated_at) VALUES ('pr_hospital', 'hospital', 'Hospital Management', 'hospital', 1, 2, 0, 0);
INSERT OR IGNORE INTO crm_products (id, key, label, license_product, active, position, created_at, updated_at) VALUES ('pr_production', 'production', 'Production POS', 'production', 1, 3, 0, 0);
INSERT OR IGNORE INTO crm_products (id, key, label, license_product, active, position, created_at, updated_at) VALUES ('pr_pharmacy', 'pharmacy', 'Pharmacy POS', 'pharmacy', 1, 4, 0, 0);
INSERT OR IGNORE INTO crm_products (id, key, label, license_product, active, position, created_at, updated_at) VALUES ('pr_services', 'services', 'Services POS (Bookings)', 'services', 1, 5, 0, 0);
INSERT OR IGNORE INTO crm_products (id, key, label, license_product, active, position, created_at, updated_at) VALUES ('pr_water', 'water', 'Water Refill Station POS (AquaPOS)', 'water', 1, 6, 0, 0);
