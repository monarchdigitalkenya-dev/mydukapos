-- GENERATED from functions/api/_ledger-schema.js by tools/gen-migration.mjs — do not edit by hand.
-- Safe to run more than once (IF NOT EXISTS) and never drops or changes existing data.

CREATE TABLE IF NOT EXISTS ledger_records (
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
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ix_ledger_records_day ON ledger_records (client_id, kind, business_date);

CREATE TABLE IF NOT EXISTS ledger_sales (
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
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ix_ledger_sales_day ON ledger_sales (client_id, business_date, status);

CREATE INDEX IF NOT EXISTS ix_ledger_sales_ref ON ledger_sales (client_id, ref_number);

CREATE INDEX IF NOT EXISTS ix_ledger_sales_bill ON ledger_sales (client_id, bill_id);

CREATE TABLE IF NOT EXISTS ledger_sale_items (
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
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ledger_payments (
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
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ix_ledger_payments_bill ON ledger_payments (client_id, bill_id);

CREATE INDEX IF NOT EXISTS ix_ledger_payments_day ON ledger_payments (client_id, business_date, method);

CREATE TABLE IF NOT EXISTS ledger_bills (
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
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ix_ledger_bills_tab ON ledger_bills (client_id, tab_id);

CREATE VIEW IF NOT EXISTS ledger_bill_balances AS
SELECT b.client_id, b.bill_id, b.tab_id, b.location, b.owner, b.total, b.status, b.opened_at, b.closed_at,
       COALESCE((SELECT SUM(p.amount) FROM ledger_payments p WHERE p.client_id = b.client_id AND p.bill_id = b.bill_id AND p.status = 'CONFIRMED'), 0) AS paid,
       b.total - COALESCE((SELECT SUM(p.amount) FROM ledger_payments p WHERE p.client_id = b.client_id AND p.bill_id = b.bill_id AND p.status = 'CONFIRMED'), 0) AS outstanding
FROM ledger_bills b;

CREATE TABLE IF NOT EXISTS ledger_gateway (
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
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ix_ledger_gateway_code ON ledger_gateway (client_id, code);

CREATE INDEX IF NOT EXISTS ix_ledger_gateway_day ON ledger_gateway (client_id, business_date, status);

CREATE TABLE IF NOT EXISTS ledger_audit (
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
);

CREATE INDEX IF NOT EXISTS ix_ledger_audit_rec ON ledger_audit (client_id, kind, rec_id);

CREATE TABLE IF NOT EXISTS ledger_batches (
  batch_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  records INTEGER NOT NULL,
  source TEXT,
  PRIMARY KEY (client_id, batch_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS qr_locations (
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
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_qr_locations_token ON qr_locations (token);

CREATE INDEX IF NOT EXISTS ix_qr_locations_label ON qr_locations (client_id, kind, label, active);

CREATE TABLE IF NOT EXISTS qr_orders (
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
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_qr_orders_idem ON qr_orders (client_id, idem_key);

CREATE INDEX IF NOT EXISTS ix_qr_orders_status ON qr_orders (client_id, status, created_at);

CREATE INDEX IF NOT EXISTS ix_qr_orders_loc ON qr_orders (client_id, loc_id, session_id);

CREATE TABLE IF NOT EXISTS qr_order_items (
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
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS qr_order_events (
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
);

CREATE INDEX IF NOT EXISTS ix_qr_order_events_order ON qr_order_events (client_id, order_id);

CREATE TABLE IF NOT EXISTS qr_order_requests (
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
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_qr_order_requests_idem ON qr_order_requests (client_id, idem_key);

CREATE INDEX IF NOT EXISTS ix_qr_order_requests_open ON qr_order_requests (client_id, status, order_id);

CREATE TABLE IF NOT EXISTS qr_order_payments (
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
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_qr_order_payments_idem ON qr_order_payments (client_id, idem_key);

CREATE INDEX IF NOT EXISTS ix_qr_order_payments_order ON qr_order_payments (client_id, order_id, status);

CREATE TABLE IF NOT EXISTS store_items (
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
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_store_items_code ON store_items (group_id, lower(code)) WHERE code IS NOT NULL AND archived = 0;

CREATE UNIQUE INDEX IF NOT EXISTS ux_store_items_name ON store_items (group_id, lower(name)) WHERE code IS NULL AND archived = 0;

CREATE TABLE IF NOT EXISTS store_movements (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_store_movements_idem ON store_movements (group_id, idem_key) WHERE idem_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_store_movements_dest ON store_movements (group_id, dest_client_id, status);

CREATE INDEX IF NOT EXISTS ix_store_movements_at ON store_movements (group_id, at);

CREATE TABLE IF NOT EXISTS ledger_meta (
  k TEXT PRIMARY KEY,
  v TEXT
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS no_delete_ledger_records BEFORE DELETE ON ledger_records BEGIN SELECT RAISE(ABORT, 'financial records are never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_ledger_sales BEFORE DELETE ON ledger_sales BEGIN SELECT RAISE(ABORT, 'financial records are never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_ledger_payments BEFORE DELETE ON ledger_payments BEGIN SELECT RAISE(ABORT, 'financial records are never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_ledger_bills BEFORE DELETE ON ledger_bills BEGIN SELECT RAISE(ABORT, 'financial records are never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_ledger_gateway BEFORE DELETE ON ledger_gateway BEGIN SELECT RAISE(ABORT, 'financial records are never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_ledger_audit BEFORE DELETE ON ledger_audit BEGIN SELECT RAISE(ABORT, 'financial records are never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_qr_orders BEFORE DELETE ON qr_orders BEGIN SELECT RAISE(ABORT, 'financial records are never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_qr_order_events BEFORE DELETE ON qr_order_events BEGIN SELECT RAISE(ABORT, 'financial records are never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_qr_order_payments BEFORE DELETE ON qr_order_payments BEGIN SELECT RAISE(ABORT, 'financial records are never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_qr_order_requests BEFORE DELETE ON qr_order_requests BEGIN SELECT RAISE(ABORT, 'financial records are never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_store_items BEFORE DELETE ON store_items BEGIN SELECT RAISE(ABORT, 'financial records are never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_delete_store_movements BEFORE DELETE ON store_movements BEGIN SELECT RAISE(ABORT, 'financial records are never deleted'); END;

CREATE TRIGGER IF NOT EXISTS no_update_ledger_audit BEFORE UPDATE ON ledger_audit BEGIN SELECT RAISE(ABORT, 'the audit trail is append-only'); END;

CREATE TRIGGER IF NOT EXISTS no_update_qr_order_events BEFORE UPDATE ON qr_order_events BEGIN SELECT RAISE(ABORT, 'order history is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_ledger_records_ins AFTER INSERT ON ledger_records BEGIN
  INSERT INTO ledger_audit (client_id, kind, rec_id, action, version, amount, status, actor, source, at, snapshot)
  VALUES (NEW.client_id, NEW.kind, NEW.rec_id, 'CREATE', NEW.version, NEW.amount, NEW.status, NEW.actor, NEW.source, NEW.updated_at, NEW.data);
END;

CREATE TRIGGER IF NOT EXISTS audit_ledger_records_upd AFTER UPDATE ON ledger_records BEGIN
  INSERT INTO ledger_audit (client_id, kind, rec_id, action, version, amount, status, actor, source, at, snapshot)
  VALUES (NEW.client_id, NEW.kind, NEW.rec_id, 'UPDATE', NEW.version, NEW.amount, NEW.status, NEW.actor, NEW.source, NEW.updated_at, NEW.data);
END;

CREATE TRIGGER IF NOT EXISTS payment_amount_locked BEFORE UPDATE OF amount, sale_id, bill_id, method ON ledger_payments
  WHEN NEW.amount IS NOT OLD.amount OR NEW.sale_id IS NOT OLD.sale_id OR NEW.bill_id IS NOT OLD.bill_id OR NEW.method IS NOT OLD.method
  BEGIN SELECT RAISE(ABORT, 'a payment cannot be edited — reverse it and record a new one'); END;
