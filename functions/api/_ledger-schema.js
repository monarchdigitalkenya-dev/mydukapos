// functions/api/_ledger-schema.js — the D1 schema of the transactional ledger (zip 153). Single source of truth:
//   * the server creates any missing table on first use (ensureLedgerSchema in _ledger.js) — so a deploy never runs against an empty DB;
//   * migrations/0001_ledger.sql is GENERATED from this list by `npm run gen:migration` (a test fails if the two ever differ), so
//     `wrangler d1 migrations apply` and the runtime always agree.
// Rules the database itself enforces (not just the app):
//   * a financial record is NEVER deleted (triggers abort DELETE on the money tables) — a mistake is a new version / a void, kept in the audit;
//   * every insert or new version of a money record writes an audit row (trigger) — no code path can forget;
//   * a payment is unique per (shop, payment id): a retried request is the same row, never a second one;
//   * a QR order has at most ONE owner: the claim is a single conditional UPDATE, so two staff claiming at once cannot both win.
export const LEDGER_SCHEMA_VERSION = 4;          // 3 = zip 186: LEDGER_SCHEMA_0007 (quiet audit triggers, audit kill switch, prune-guarded audit delete trigger)

export const LEDGER_SCHEMA = [
  // One row per financial document of ANY module: sale, return, expense, purchase, trade credit, debt, tab, patient charge,
  // cash shift, facility booking, gateway transaction ... `data` is the whole record as the app sent it; the columns are what queries use.
  `CREATE TABLE IF NOT EXISTS ledger_records (
  client_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  rec_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  business_date TEXT,
  amount REAL,
  status TEXT,
  actor TEXT,
  source TEXT,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, kind, rec_id)
) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS ix_ledger_records_day ON ledger_records (client_id, kind, business_date)`,

  // Sales, with the columns Daily Sales and reports read.
  `CREATE TABLE IF NOT EXISTS ledger_sales (
  client_id TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  ref_number TEXT,
  ts INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  app TEXT,
  outlet TEXT,
  location TEXT,
  tab_id TEXT,
  bill_id TEXT,
  order_id TEXT,
  total REAL NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  method TEXT,
  cash_amount REAL NOT NULL DEFAULT 0,
  mpesa_amount REAL NOT NULL DEFAULT 0,
  card_amount REAL NOT NULL DEFAULT 0,
  credit_amount REAL NOT NULL DEFAULT 0,
  mpesa_code TEXT,
  staff TEXT,
  till TEXT,
  customer TEXT,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  full_settle INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, sale_id)
) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS ix_ledger_sales_day ON ledger_sales (client_id, business_date, status)`,
  `CREATE INDEX IF NOT EXISTS ix_ledger_sales_ref ON ledger_sales (client_id, ref_number)`,
  `CREATE INDEX IF NOT EXISTS ix_ledger_sales_bill ON ledger_sales (client_id, bill_id)`,

  `CREATE TABLE IF NOT EXISTS ledger_sale_items (
  client_id TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  code TEXT,
  name TEXT,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  station TEXT,
  PRIMARY KEY (client_id, sale_id, line_no),
  FOREIGN KEY (client_id, sale_id) REFERENCES ledger_sales (client_id, sale_id)
) WITHOUT ROWID`,

  // Money received. One row per (sale, method) — a split payment is two rows on one bill. UNIQUE per shop: a retry cannot add a second.
  `CREATE TABLE IF NOT EXISTS ledger_payments (
  client_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  sale_id TEXT,
  bill_id TEXT,
  order_id TEXT,
  method TEXT NOT NULL,
  amount REAL NOT NULL,
  mpesa_code TEXT,
  status TEXT NOT NULL DEFAULT 'CONFIRMED',
  confirmed_by TEXT,
  source TEXT,
  ts INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, payment_id)
) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS ix_ledger_payments_bill ON ledger_payments (client_id, bill_id)`,
  `CREATE INDEX IF NOT EXISTS ix_ledger_payments_day ON ledger_payments (client_id, business_date, method)`,

  // A bill (a guest's tab): its own unique identifier, the person / place it belongs to, and who owns it. What is PAID is never stored
  // here — it is the sum of its confirmed payments (see the view below), so it cannot disagree with them.
  `CREATE TABLE IF NOT EXISTS ledger_bills (
  client_id TEXT NOT NULL,
  bill_id TEXT NOT NULL,
  tab_id TEXT,
  location_id TEXT,
  location TEXT,
  owner TEXT,
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN',
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, bill_id)
) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS ix_ledger_bills_tab ON ledger_bills (client_id, tab_id)`,
  `CREATE VIEW IF NOT EXISTS ledger_bill_balances AS
SELECT b.client_id, b.bill_id, b.tab_id, b.location, b.owner, b.total, b.status, b.opened_at, b.closed_at,
       COALESCE((SELECT SUM(p.amount) FROM ledger_payments p WHERE p.client_id = b.client_id AND p.bill_id = b.bill_id AND p.status = 'CONFIRMED'), 0) AS paid,
       b.total - COALESCE((SELECT SUM(p.amount) FROM ledger_payments p WHERE p.client_id = b.client_id AND p.bill_id = b.bill_id AND p.status = 'CONFIRMED'), 0) AS outstanding
FROM ledger_bills b`,

  // Money the payment providers told us about (STK success, till payment, card, KCB, PayWave) — received, but not necessarily attached to a
  // sale yet. This is where "pending / unaccounted" comes from: a row here whose code is on no ledger_payments row is money nobody matched.
  `CREATE TABLE IF NOT EXISTS ledger_gateway (
  client_id TEXT NOT NULL,
  txn_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  code TEXT,
  amount REAL NOT NULL,
  phone TEXT,
  status TEXT NOT NULL,
  ts INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  trusted INTEGER NOT NULL DEFAULT 1,
  raw TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, txn_id)
) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS ix_ledger_gateway_code ON ledger_gateway (client_id, code)`,
  `CREATE INDEX IF NOT EXISTS ix_ledger_gateway_day ON ledger_gateway (client_id, business_date, status)`,

  // Append-only history of every change to a money record.
  `CREATE TABLE IF NOT EXISTS ledger_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  rec_id TEXT NOT NULL,
  action TEXT NOT NULL,
  version INTEGER,
  amount REAL,
  status TEXT,
  actor TEXT,
  source TEXT,
  at INTEGER NOT NULL,
  snapshot TEXT
)`,
  `CREATE INDEX IF NOT EXISTS ix_ledger_audit_rec ON ledger_audit (client_id, kind, rec_id)`,

  // Every push that carried money records, and what happened to it (idempotency + forensics).
  `CREATE TABLE IF NOT EXISTS ledger_batches (
  batch_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  records INTEGER NOT NULL,
  source TEXT,
  PRIMARY KEY (client_id, batch_id)
) WITHOUT ROWID`,

  // ---- QR / client ordering ----
  // A location (table, room, pool cabana ...). `loc_id` is permanent — the QR carries a random token that resolves to it, and a
  // rename changes only `label`. `session_id` changes when the location is released, so a QR session or order from the previous
  // guest cannot carry into the next one.
  `CREATE TABLE IF NOT EXISTS qr_locations (
  client_id TEXT NOT NULL,
  loc_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  token TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'AVAILABLE',
  session_id TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  revoked_at INTEGER,
  revoked_by TEXT,
  released_at INTEGER,
  PRIMARY KEY (client_id, loc_id)
) WITHOUT ROWID`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_qr_locations_token ON qr_locations (token)`,
  `CREATE INDEX IF NOT EXISTS ix_qr_locations_label ON qr_locations (client_id, kind, label, active)`,

  `CREATE TABLE IF NOT EXISTS qr_orders (
  client_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  loc_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT,
  owner_at INTEGER,
  bill_id TEXT,
  tab_label TEXT,
  total REAL NOT NULL,
  guest_name TEXT,
  guest_phone TEXT,
  note TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  printed_at INTEGER,
  printed_by TEXT,
  idem_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, order_id)
) WITHOUT ROWID`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_qr_orders_idem ON qr_orders (client_id, idem_key)`,
  `CREATE INDEX IF NOT EXISTS ix_qr_orders_status ON qr_orders (client_id, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS ix_qr_orders_loc ON qr_orders (client_id, loc_id, session_id)`,

  `CREATE TABLE IF NOT EXISTS qr_order_items (
  client_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  base_name TEXT,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  station TEXT,
  modifiers TEXT,
  note TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, order_id, line_no)
) WITHOUT ROWID`,

  // What happened to an order, in order — never edited, never deleted.
  `CREATE TABLE IF NOT EXISTS qr_order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT,
  actor_kind TEXT NOT NULL,
  event TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  detail TEXT
)`,
  `CREATE INDEX IF NOT EXISTS ix_qr_order_events_order ON qr_order_events (client_id, order_id)`,

  // A guest's request that needs staff to act on it once the order is being handled (cancel, or swap one item for another).
  `CREATE TABLE IF NOT EXISTS qr_order_requests (
  client_id TEXT NOT NULL,
  req_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  idem_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  PRIMARY KEY (client_id, req_id)
) WITHOUT ROWID`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_qr_order_requests_idem ON qr_order_requests (client_id, idem_key)`,
  `CREATE INDEX IF NOT EXISTS ix_qr_order_requests_open ON qr_order_requests (client_id, status, order_id)`,

  // What the guest submitted as payment. NOT proof of payment: it stays PENDING until a cashier confirms it (which writes the real
  // ledger_payments row). The M-Pesa code is optional.
  `CREATE TABLE IF NOT EXISTS qr_order_payments (
  client_id TEXT NOT NULL,
  pay_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  method TEXT NOT NULL,
  amount REAL NOT NULL,
  mpesa_code TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  idem_key TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  confirmed_by TEXT,
  confirmed_at INTEGER,
  payment_id TEXT,
  PRIMARY KEY (client_id, pay_id)
) WITHOUT ROWID`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_qr_order_payments_idem ON qr_order_payments (client_id, idem_key)`,
  `CREATE INDEX IF NOT EXISTS ix_qr_order_payments_order ON qr_order_payments (client_id, order_id, status)`,

  // ---- warehouse (Store) — zip 153: stock in the shared store, and EVERY movement of it. Quantity can never go below zero (CHECK), an item
  // is archived rather than deleted, and a movement is never edited or deleted (history). A Store -> Branch transfer is ONE batch:
  // the movement row (with its destination) and the quantity change succeed or fail together.
  `CREATE TABLE IF NOT EXISTS store_items (
  group_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  code TEXT,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  price REAL NOT NULL DEFAULT 0,
  wholesale_selling_price REAL NOT NULL DEFAULT 0,
  wholesale_price REAL NOT NULL DEFAULT 0,
  qty REAL NOT NULL DEFAULT 0 CHECK (qty >= 0),
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, item_id)
) WITHOUT ROWID`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_store_items_code ON store_items (group_id, lower(code)) WHERE code IS NOT NULL AND archived = 0`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_store_items_name ON store_items (group_id, lower(name)) WHERE code IS NULL AND archived = 0`,
  `CREATE TABLE IF NOT EXISTS store_movements (
  group_id TEXT NOT NULL,
  movement_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_id TEXT,
  item_name TEXT,
  unit TEXT,
  qty REAL NOT NULL DEFAULT 0,
  qty_before REAL,
  qty_after REAL,
  source_client_id TEXT,
  dest_client_id TEXT,
  dest_label TEXT,
  status TEXT NOT NULL DEFAULT 'DONE',
  actor TEXT,
  at INTEGER NOT NULL,
  received_at INTEGER,
  idem_key TEXT,
  detail TEXT,
  snapshot TEXT,
  PRIMARY KEY (group_id, movement_id)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_store_movements_idem ON store_movements (group_id, idem_key) WHERE idem_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ix_store_movements_dest ON store_movements (group_id, dest_client_id, status)`,
  `CREATE INDEX IF NOT EXISTS ix_store_movements_at ON store_movements (group_id, at)`,

  // small key/value: schema version, counters (bill numbers)
  `CREATE TABLE IF NOT EXISTS ledger_meta (
  k TEXT PRIMARY KEY,
  v TEXT
) WITHOUT ROWID`,

  // ---- integrity triggers ----
  ...['ledger_records', 'ledger_sales', 'ledger_payments', 'ledger_bills', 'ledger_gateway', 'ledger_audit', 'qr_orders', 'qr_order_events', 'qr_order_payments', 'qr_order_requests', 'store_items', 'store_movements'].map((t) =>
    `CREATE TRIGGER IF NOT EXISTS no_delete_${t} BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, 'financial records are never deleted'); END`),
  `CREATE TRIGGER IF NOT EXISTS no_update_ledger_audit BEFORE UPDATE ON ledger_audit BEGIN SELECT RAISE(ABORT, 'the audit trail is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS no_update_qr_order_events BEFORE UPDATE ON qr_order_events BEGIN SELECT RAISE(ABORT, 'order history is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS audit_ledger_records_ins AFTER INSERT ON ledger_records BEGIN
  INSERT INTO ledger_audit (client_id, kind, rec_id, action, version, amount, status, actor, source, at, snapshot)
  VALUES (NEW.client_id, NEW.kind, NEW.rec_id, 'CREATE', NEW.version, NEW.amount, NEW.status, NEW.actor, NEW.source, NEW.updated_at, NEW.data);
END`,
  `CREATE TRIGGER IF NOT EXISTS audit_ledger_records_upd AFTER UPDATE ON ledger_records BEGIN
  INSERT INTO ledger_audit (client_id, kind, rec_id, action, version, amount, status, actor, source, at, snapshot)
  VALUES (NEW.client_id, NEW.kind, NEW.rec_id, 'UPDATE', NEW.version, NEW.amount, NEW.status, NEW.actor, NEW.source, NEW.updated_at, NEW.data);
END`,
  // a payment can only be changed by reversing it (status), never re-amounted silently
  `CREATE TRIGGER IF NOT EXISTS payment_amount_locked BEFORE UPDATE OF amount, sale_id, bill_id, method ON ledger_payments
  WHEN NEW.amount IS NOT OLD.amount OR NEW.sale_id IS NOT OLD.sale_id OR NEW.bill_id IS NOT OLD.bill_id OR NEW.method IS NOT OLD.method
  BEGIN SELECT RAISE(ABORT, 'a payment cannot be edited — reverse it and record a new one'); END`,
];

// ---------------------------------------------------------------------------------------------------------------------------------
// zip 186 — migration 0007 (INCIDENT: ledger_audit grew to 21.8M rows / 10 GB from a sync retry storm). migrations/0007_audit_idempotency.sql is GENERATED
// from this list (tools/gen-migration.mjs; a test fails if they differ) and ensureLedgerSchema() applies the same list after LEDGER_SCHEMA, so the
// migration and the runtime bootstrap can never disagree. 0001 (= LEDGER_SCHEMA above) is NEVER edited: it still creates the OLD noisy triggers on a fresh
// database; these statements DROP and re-create them under the same names (IF NOT EXISTS in LEDGER_SCHEMA then keeps whichever is current).
//
// 1. VOLATILE_FIELDS: client-side retry / telemetry counters stamped INTO a record while it waits for the server (stampLocalContext: `tries`). They are
//    not part of the business record: they are removed before the record is stored or compared (JS: stripVolatile in _ledger.js; SQL: sqlStripVolatile).
// 2. audit_ledger_records_ins / _upd write an audit row ONLY when something real happened (upd: version, status, amount or the data minus VOLATILE_FIELDS
//    changed) and ONLY when the kill switch ledger_meta k='audit_disabled' is not '1'. NO unique index on ledger_audit (old duplicates would make it fail).
// 3. The audit snapshot is the full record, except a record whose JSON is longer than SNAPSHOT_MAX (2000 chars for a stock_move, 16000 for every money
//    kind) gets a small valid-JSON stub {"truncated":1,"len":..,"kind","status","amount","version"} so one record can never put kilobytes into every row.
//    (The full, current record is always in ledger_records.data; only the HISTORY copy of a huge record is shortened.)
// 4. no_delete_ledger_audit keeps 'financial records are never deleted', EXCEPT while ledger_meta k='audit_prune_open' is '1' AND the row is older than
//    10 minutes. tools/prune-audit.mjs opens the flag for the duration of a prune and closes it again. no_update_ledger_audit stays append-only.
export const VOLATILE_FIELDS = ['tries', '_tries', 'retries', 'retryCount', '_retryCount', 'lastTryAt'];
export const sqlStripVolatile = (expr) => `json_remove(${expr}, ${VOLATILE_FIELDS.map((f) => `'$.${f}'`).join(', ')})`;
const FLAG = (k) => `COALESCE((SELECT v FROM ledger_meta WHERE k = '${k}'), '0')`;
const SNAP = `CASE WHEN length(NEW.data) <= (CASE WHEN NEW.kind = 'stock_move' THEN 2000 ELSE 16000 END) THEN NEW.data
      ELSE json_object('truncated', 1, 'len', length(NEW.data), 'kind', NEW.kind, 'status', NEW.status, 'amount', NEW.amount, 'version', NEW.version) END`;
const AUDIT_INSERT = (action) => `INSERT INTO ledger_audit (client_id, kind, rec_id, action, version, amount, status, actor, source, at, snapshot)
  VALUES (NEW.client_id, NEW.kind, NEW.rec_id, '${action}', NEW.version, NEW.amount, NEW.status, NEW.actor, NEW.source, NEW.updated_at,
    ${SNAP});`;
export const LEDGER_SCHEMA_0007 = [
  `DROP TRIGGER IF EXISTS audit_ledger_records_ins`,
  `DROP TRIGGER IF EXISTS audit_ledger_records_upd`,
  `DROP TRIGGER IF EXISTS no_delete_ledger_audit`,
  `CREATE TRIGGER audit_ledger_records_ins AFTER INSERT ON ledger_records
WHEN ${FLAG('audit_disabled')} <> '1'
BEGIN
  ${AUDIT_INSERT('CREATE')}
END`,
  `CREATE TRIGGER audit_ledger_records_upd AFTER UPDATE ON ledger_records
WHEN ${FLAG('audit_disabled')} <> '1'
  AND (NEW.version IS NOT OLD.version OR NEW.status IS NOT OLD.status OR NEW.amount IS NOT OLD.amount
    OR (CASE WHEN json_valid(NEW.data) AND json_valid(OLD.data) THEN ${sqlStripVolatile('NEW.data')} IS NOT ${sqlStripVolatile('OLD.data')} ELSE NEW.data IS NOT OLD.data END))
BEGIN
  ${AUDIT_INSERT('UPDATE')}
END`,
  `CREATE TRIGGER no_delete_ledger_audit BEFORE DELETE ON ledger_audit
WHEN NOT (${FLAG('audit_prune_open')} = '1' AND OLD.at < (CAST(strftime('%s', 'now') AS INTEGER) - 600) * 1000)
BEGIN SELECT RAISE(ABORT, 'financial records are never deleted'); END`,
];
