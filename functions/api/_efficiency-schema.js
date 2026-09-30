// functions/api/_efficiency-schema.js — zip 159. Additive D1 objects for speed and reliability. Single source of truth: the server creates
// them on first use (ensureEfficiencySchema) and migrations/0003_efficiency.sql is GENERATED from this list by `npm run gen:migration`.
export const EFFICIENCY_SCHEMA_VERSION = 1;
export const EFFICIENCY_SCHEMA = [
  // The write fence for shops still stored as ONE KV record. KV has no compare-and-set and reads can be up to ~60 s stale, so two devices
  // could each merge from an old copy and the later write erased the other's sales. D1 is strongly consistent: this row says, per shop, which
  // write is the latest (seq) and which KV version that write produced (kv_ver), so a writer can (1) wait until it can SEE that version and
  // (2) claim the next slot with one conditional upsert. Never holds shop data.
  `CREATE TABLE IF NOT EXISTS shop_write_fence (
  client_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  kv_ver INTEGER NOT NULL,
  at INTEGER NOT NULL
) WITHOUT ROWID`,
];
