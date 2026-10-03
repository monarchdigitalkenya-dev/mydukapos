-- GENERATED from functions/api/_owner-db.js (OWNER_SCHEMA). The owner database mydukapos-owner (zip 187): a READ MODEL of the Owner Console list; KV is the source of truth. Safe to run more than once.

CREATE TABLE IF NOT EXISTS owner_clients (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  business_name TEXT NOT NULL DEFAULT '',
  product TEXT,
  type TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  trashed_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER,
  updated_at INTEGER NOT NULL,
  summary_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_owner_clients_slug ON owner_clients (slug);

CREATE INDEX IF NOT EXISTS ix_owner_clients_trashed ON owner_clients (trashed_at);

CREATE INDEX IF NOT EXISTS ix_owner_clients_updated ON owner_clients (updated_at);

CREATE TABLE IF NOT EXISTS owner_group_income (
  person_key TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
