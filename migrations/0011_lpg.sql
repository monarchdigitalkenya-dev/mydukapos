-- GENERATED from functions/api/_lpg-schema.js by tools/gen-migration.mjs — do not edit by hand.
-- LPG / gas retail (zip 216). Safe to run more than once (IF NOT EXISTS) and never drops anything.

CREATE TABLE IF NOT EXISTS lpg_movements (
  client_id TEXT NOT NULL,
  mv_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  business_date TEXT,
  app TEXT,
  size_code TEXT NOT NULL,
  label TEXT,
  brand TEXT,
  state TEXT NOT NULL CHECK (state IN ('full','empty','away','damaged')),
  kind TEXT NOT NULL,
  qty REAL NOT NULL,
  before_qty REAL,
  after_qty REAL,
  reason TEXT,
  line_ref TEXT,
  reversal INTEGER NOT NULL DEFAULT 0,
  actor TEXT,
  PRIMARY KEY (client_id, mv_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS lpg_movements_by_day ON lpg_movements (client_id, business_date, size_code);

CREATE INDEX IF NOT EXISTS lpg_movements_by_line ON lpg_movements (client_id, line_ref);

CREATE TRIGGER IF NOT EXISTS lpg_movements_no_update BEFORE UPDATE ON lpg_movements BEGIN SELECT RAISE(ABORT, 'lpg_movements are append-only: record a new movement instead'); END;

CREATE TRIGGER IF NOT EXISTS lpg_movements_no_delete BEFORE DELETE ON lpg_movements BEGIN SELECT RAISE(ABORT, 'lpg_movements are append-only: record a new movement instead'); END;

CREATE TABLE IF NOT EXISTS lpg_sale_lines (
  client_id TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  size_code TEXT NOT NULL,
  label TEXT,
  brand TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('full','exchange','cylinder','set')),
  qty REAL NOT NULL,
  price REAL NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  margin REAL NOT NULL DEFAULT 0,
  empty_brand TEXT,
  empty_state TEXT,
  bundle_id TEXT,
  components TEXT,
  line_ref TEXT,
  ts INTEGER NOT NULL,
  business_date TEXT,
  app TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, sale_id, line_no)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS lpg_sale_lines_by_day ON lpg_sale_lines (client_id, business_date, mode);

CREATE TABLE IF NOT EXISTS lpg_stocktakes (
  client_id TEXT NOT NULL,
  st_id TEXT NOT NULL,
  size_code TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('full','empty','away','damaged')),
  label TEXT,
  expected REAL NOT NULL,
  counted REAL NOT NULL,
  variance REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  note TEXT,
  counted_by TEXT,
  counted_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  PRIMARY KEY (client_id, st_id, size_code, state)
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS lpg_stocktakes_decided_is_final BEFORE UPDATE ON lpg_stocktakes
   WHEN OLD.status <> 'pending' OR NEW.expected <> OLD.expected OR NEW.counted <> OLD.counted OR NEW.variance <> OLD.variance OR NEW.size_code <> OLD.size_code OR NEW.state <> OLD.state
   BEGIN SELECT RAISE(ABORT, 'a decided cylinder stock take cannot be changed'); END;

CREATE TRIGGER IF NOT EXISTS lpg_stocktakes_no_delete BEFORE DELETE ON lpg_stocktakes BEGIN SELECT RAISE(ABORT, 'cylinder stock takes cannot be deleted'); END;
