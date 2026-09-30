-- GENERATED from functions/api/_efficiency-schema.js by tools/gen-migration.mjs — do not edit by hand.
-- Safe to run more than once (IF NOT EXISTS) and never drops or changes existing data.

CREATE TABLE IF NOT EXISTS shop_write_fence (
  client_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  kv_ver INTEGER NOT NULL,
  at INTEGER NOT NULL
) WITHOUT ROWID;
