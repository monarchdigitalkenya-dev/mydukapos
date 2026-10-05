// functions/api/_lpg-schema.js — LPG / gas retail (zip 216). The D1 tables behind the gas workflow. Single source of truth:
//   * ensureLedgerSchema (_ledger.js) creates any missing table on first use, so a deploy never meets an empty database;
//   * migrations/0011_lpg.sql is GENERATED from this list by `npm run gen:migration` (a test fails if the two ever differ).
// What the DATABASE itself enforces:
//   * every row carries client_id (the shop / branch link) — one branch can never read or write another branch's cylinders;
//   * lpg_movements is APPEND-ONLY (no UPDATE, no DELETE): a cylinder that moved can be corrected only by a NEW, opposite movement;
//   * a cylinder stock take that has been approved or rejected can never change again (its figures never change at all).
// These tables are a structured projection of what the tills already record (stock movements and sale lines carrying an `lpg` note): they are filled from
// the same atomic record group as the sale / movement itself, with idempotent statements — a resend adds nothing.
export const LPG_SCHEMA_VERSION = 1;

export const LPG_SCHEMA = [
  // Every change to a cylinder count: which size / brand, which state (full, empty, away, damaged), how many, before -> after, why, and the sale it belongs to.
  `CREATE TABLE IF NOT EXISTS lpg_movements (
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
) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS lpg_movements_by_day ON lpg_movements (client_id, business_date, size_code)`,
  `CREATE INDEX IF NOT EXISTS lpg_movements_by_line ON lpg_movements (client_id, line_ref)`,
  `CREATE TRIGGER IF NOT EXISTS lpg_movements_no_update BEFORE UPDATE ON lpg_movements BEGIN SELECT RAISE(ABORT, 'lpg_movements are append-only: record a new movement instead'); END`,
  `CREATE TRIGGER IF NOT EXISTS lpg_movements_no_delete BEFORE DELETE ON lpg_movements BEGIN SELECT RAISE(ABORT, 'lpg_movements are append-only: record a new movement instead'); END`,

  // Every gas line of every sale: what was bought (mode), how many, the price, the cost and the margin, and the empty handed in with an exchange.
  `CREATE TABLE IF NOT EXISTS lpg_sale_lines (
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
) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS lpg_sale_lines_by_day ON lpg_sale_lines (client_id, business_date, mode)`,

  // Cylinder stock takes: one row per size and state. Counted by one person, approved (or rejected) by an admin. Only pending -> approved / rejected.
  `CREATE TABLE IF NOT EXISTS lpg_stocktakes (
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
) WITHOUT ROWID`,
  `CREATE TRIGGER IF NOT EXISTS lpg_stocktakes_decided_is_final BEFORE UPDATE ON lpg_stocktakes
   WHEN OLD.status <> 'pending' OR NEW.expected <> OLD.expected OR NEW.counted <> OLD.counted OR NEW.variance <> OLD.variance OR NEW.size_code <> OLD.size_code OR NEW.state <> OLD.state
   BEGIN SELECT RAISE(ABORT, 'a decided cylinder stock take cannot be changed'); END`,
  `CREATE TRIGGER IF NOT EXISTS lpg_stocktakes_no_delete BEFORE DELETE ON lpg_stocktakes BEGIN SELECT RAISE(ABORT, 'cylinder stock takes cannot be deleted'); END`,
];
