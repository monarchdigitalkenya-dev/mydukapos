// functions/api/_stock.js - shared helper, NOT a route (zip 310). INVENTORY LOCATIONS, INTERNAL MOVES AND TRANSFERS BETWEEN BRANCHES.
//
// What a branch's stock IS did not change: each branch's items and quantities live in its own shop database, and every change to a quantity is a
// stock movement with its own id that the database applies exactly once (the stock ledger). That quantity is the branch's SHOP FLOOR (what the till
// sells from), location id 'floor'.
// New here, in the shared transaction database (LEDGER_DB), keyed by the business (group_id):
//   inv_location    the other places a branch keeps stock: main store / warehouse, kitchen store, bar store, pharmacy store, other.
//   inv_loc_stock   quantity per location and item code (CHECK qty >= 0: a location can never go below zero, even under concurrent moves).
//   inv_movement    append-only ledger of every change to a location's stock (PRIMARY KEY = a deterministic movement id, so the same step can never
//                   be counted twice), linked to the transfer that caused it.
//   xfer / xfer_line / xfer_event   transfers: internal (same branch, location to location) and between branches, with approval, dispatch
//                   (stock leaves the source and is IN TRANSIT), receipt (partial, damaged, missing) and resolution. Events are append-only.
// Branch total = shop floor + its locations. An internal move changes where stock is, never the total, and never creates a sale or a purchase.
import { shopMode, shopCall, readState } from './_state-store.js';
import { rid } from './_org.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS inv_location (group_id TEXT NOT NULL, location_id TEXT NOT NULL, client_id TEXT NOT NULL, name TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'store' CHECK (kind IN ('store','warehouse','kitchen','bar','pharmacy','other')), status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (group_id, location_id)) WITHOUT ROWID`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_inv_location_name ON inv_location (group_id, client_id, lower(name))`,
  `CREATE TABLE IF NOT EXISTS inv_loc_stock (group_id TEXT NOT NULL, location_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'pcs',
     unit_cost REAL NOT NULL DEFAULT 0, qty REAL NOT NULL DEFAULT 0 CHECK (qty >= 0), updated_at INTEGER NOT NULL, PRIMARY KEY (group_id, location_id, code)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS inv_movement (group_id TEXT NOT NULL, movement_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, client_id TEXT NOT NULL, location_id TEXT NOT NULL,
     code TEXT NOT NULL, name TEXT, unit TEXT, qty REAL NOT NULL, xfer_id TEXT, ref TEXT, actor TEXT, reason TEXT, reverses TEXT, PRIMARY KEY (group_id, movement_id)) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS ix_inv_movement_at ON inv_movement (group_id, at)`,
  `CREATE INDEX IF NOT EXISTS ix_inv_movement_loc ON inv_movement (group_id, client_id, location_id, at)`,
  `CREATE TABLE IF NOT EXISTS xfer (group_id TEXT NOT NULL, xfer_id TEXT NOT NULL, ref TEXT NOT NULL, internal INTEGER NOT NULL DEFAULT 0,
     from_client TEXT NOT NULL, from_loc TEXT NOT NULL, to_client TEXT NOT NULL, to_loc TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','cancelled','dispatching','in_transit','partial','discrepancy','completed')),
     value REAL NOT NULL DEFAULT 0, notes TEXT, requested_by TEXT, requested_at INTEGER NOT NULL, approved_by TEXT, approved_at INTEGER,
     dispatched_by TEXT, dispatched_at INTEGER, received_by TEXT, received_at INTEGER, closed_at INTEGER, reject_reason TEXT, reverses TEXT, updated_at INTEGER NOT NULL,
     PRIMARY KEY (group_id, xfer_id)) WITHOUT ROWID`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_xfer_ref ON xfer (group_id, ref)`,
  `CREATE INDEX IF NOT EXISTS ix_xfer_status ON xfer (group_id, status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS xfer_line (group_id TEXT NOT NULL, xfer_id TEXT NOT NULL, line_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'pcs',
     unit_cost REAL NOT NULL DEFAULT 0, unit_price REAL NOT NULL DEFAULT 0, qty_req REAL NOT NULL CHECK (qty_req > 0), qty_disp REAL NOT NULL DEFAULT 0, qty_recv REAL NOT NULL DEFAULT 0,
     qty_damaged REAL NOT NULL DEFAULT 0, qty_missing REAL NOT NULL DEFAULT 0, batch TEXT, expiry TEXT, resolution TEXT, resolved_qty REAL NOT NULL DEFAULT 0,
     CHECK (qty_disp <= qty_req + 0.000001), CHECK (qty_recv + qty_damaged + qty_missing <= qty_disp + 0.000001),
     PRIMARY KEY (group_id, xfer_id, line_id)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS xfer_event (group_id TEXT NOT NULL, event_id TEXT NOT NULL, xfer_id TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, detail TEXT,
     PRIMARY KEY (group_id, event_id)) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS ix_xfer_event_x ON xfer_event (group_id, xfer_id, at)`,
  `CREATE TABLE IF NOT EXISTS org_seq (group_id TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (group_id, name)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS org_setting (group_id TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (group_id, k)) WITHOUT ROWID`,
  `CREATE TRIGGER IF NOT EXISTS no_delete_inv_movement BEFORE DELETE ON inv_movement BEGIN SELECT RAISE(ABORT, 'stock movements are never deleted'); END`,
  `CREATE TRIGGER IF NOT EXISTS no_update_inv_movement BEFORE UPDATE ON inv_movement BEGIN SELECT RAISE(ABORT, 'stock movements are never changed: record a reversal'); END`,
  `CREATE TRIGGER IF NOT EXISTS no_delete_xfer BEFORE DELETE ON xfer BEGIN SELECT RAISE(ABORT, 'transfers are never deleted'); END`,
  `CREATE TRIGGER IF NOT EXISTS no_delete_xfer_line BEFORE DELETE ON xfer_line BEGIN SELECT RAISE(ABORT, 'transfers are never deleted'); END`,
  `CREATE TRIGGER IF NOT EXISTS no_delete_xfer_event BEFORE DELETE ON xfer_event BEGIN SELECT RAISE(ABORT, 'transfer history is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS no_update_xfer_event BEFORE UPDATE ON xfer_event BEGIN SELECT RAISE(ABORT, 'transfer history is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS no_edit_closed_xfer BEFORE UPDATE ON xfer WHEN OLD.status IN ('completed','rejected','cancelled') BEGIN SELECT RAISE(ABORT, 'a closed transfer cannot be changed'); END`,
];
export const STOCK_SQL = SCHEMA.map((s) => s.replace(/\s+/g, ' ').trim() + ';').join('\n');

const ready = new WeakMap();
export async function ensureStockSchema(db) {
  if (ready.get(db)) return db;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  ready.set(db, true);
  return db;
}
const all = async (db, sql, ...b) => ((await db.prepare(sql).bind(...b).all()).results || []);
const one = async (db, sql, ...b) => (await db.prepare(sql).bind(...b).first()) || null;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : 0; };

/* ---------- settings (approval rules) ---------- */
// zip 311: simple by default - a transfer goes straight out (no approval step) until the owner turns approvals on in Business HQ > More
export const DEFAULT_SETTINGS = { approval_mode: 'never', approval_threshold: 0, independent_approval: true, internal_approval: false };
export async function getSettings(db, groupId) {
  const rows = await all(db, 'SELECT k, v FROM org_setting WHERE group_id = ?', groupId);
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) { try { s[r.k] = JSON.parse(r.v); } catch (e) { /* default */ } }
  return s;
}
export async function saveSettings(db, groupId, f) {
  const out = {};
  if (f.approval_mode !== undefined) out.approval_mode = ['always', 'above', 'never'].includes(f.approval_mode) ? f.approval_mode : 'always';
  if (f.approval_threshold !== undefined) out.approval_threshold = Math.max(0, Math.round(Number(f.approval_threshold) || 0));
  if (f.independent_approval !== undefined) out.independent_approval = f.independent_approval !== false;
  if (f.internal_approval !== undefined) out.internal_approval = f.internal_approval === true;
  for (const [k, v] of Object.entries(out)) await db.prepare('INSERT INTO org_setting (group_id, k, v, updated_at) VALUES (?,?,?,?) ON CONFLICT (group_id, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').bind(groupId, k, JSON.stringify(v), Date.now()).run();
  return getSettings(db, groupId);
}
export function needsApproval(s, internal, value) {
  if (internal) return !!s.internal_approval;
  if (s.approval_mode === 'never') return false;
  if (s.approval_mode === 'above') return value > (Number(s.approval_threshold) || 0);
  return true;
}

/* ---------- locations ---------- */
export const KINDS = ['store', 'warehouse', 'kitchen', 'bar', 'pharmacy', 'other'];
export const locations = (db, groupId, clientIds) => all(db, `SELECT * FROM inv_location WHERE group_id = ? AND client_id IN (${clientIds.map(() => '?').join(',') || "''"}) ORDER BY client_id, name`, groupId, ...clientIds);
export const location = (db, groupId, locId) => one(db, 'SELECT * FROM inv_location WHERE group_id = ? AND location_id = ?', groupId, locId);
export async function createLocation(db, groupId, clientId, name, kind) {
  const nm = String(name || '').trim().slice(0, 60);
  if (!nm) return { ok: false, error: 'Give the location a name, e.g. Main store.' };
  if (/^shop floor$/i.test(nm)) return { ok: false, error: '"Shop floor" is what the till sells from; it already exists in every branch.' };
  const dup = await one(db, 'SELECT location_id FROM inv_location WHERE group_id = ? AND client_id = ? AND lower(name) = lower(?)', groupId, clientId, nm);
  if (dup) return { ok: false, error: 'This branch already has a location with that name.' };
  const id = rid('L'), now = Date.now();
  await db.prepare('INSERT INTO inv_location (group_id, location_id, client_id, name, kind, status, created_at, updated_at) VALUES (?,?,?,?,?,\'active\',?,?)').bind(groupId, id, clientId, nm, KINDS.includes(kind) ? kind : 'store', now, now).run();
  return { ok: true, location: await location(db, groupId, id) };
}
export const locStock = (db, groupId, locId) => all(db, 'SELECT * FROM inv_loc_stock WHERE group_id = ? AND location_id = ? ORDER BY name', groupId, locId);
export const movements = (db, groupId, { clientId, locId, limit = 200 } = {}) => clientId
  ? all(db, `SELECT * FROM inv_movement WHERE group_id = ? AND client_id = ?${locId ? ' AND location_id = ?' : ''} ORDER BY at DESC LIMIT ?`, groupId, clientId, ...(locId ? [locId] : []), Math.min(1000, limit))
  : all(db, 'SELECT * FROM inv_movement WHERE group_id = ? ORDER BY at DESC LIMIT ?', groupId, Math.min(1000, limit));

/* ---------- the branch's SHOP FLOOR (its own database, through the stock ledger) ---------- */
async function shopState(env, clientId) { return (await readState(env, 'pos-data:state:' + clientId, {})) || {}; }
export async function floorItems(env, clientId) {
  const st = await shopState(env, clientId);
  return (Array.isArray(st.inventory) ? st.inventory : []).filter((i) => i && !i._deleted && !i.removed && i.code != null);
}
async function requireDb(env, clientId) {
  if ((await shopMode(env, clientId)) !== 'do') { const e = new Error('This branch is not in its own database yet (it moves there by itself at its next sync). Open the branch once, then try again.'); e.code = 'not_db'; throw e; }
}
async function haveMovements(env, clientId, ids) {
  const r = await shopCall(env, clientId, 'have', { col: 'stockMovementLog', ids });
  const j = r.ok ? await r.json() : {};
  return new Set(Object.keys((j && j.have) || {}));
}
const mv = (id, code, delta, reason) => ({ id, code: String(code), delta, type: delta < 0 ? 'removed' : 'added', reason, timestamp: new Date().toISOString(), hq: 1 });
// Take stock OFF a branch's shop floor: one movement per line, checked and applied in ONE request of the branch's database (so a sale of the last
// unit at the same moment cannot slip between the check and the deduction). A retry with the same ids is a no-op. -> { ok } | { ok:false, short }
export async function floorOut(env, clientId, lines, reason) {
  await requireDb(env, clientId);
  const ids = lines.map((l) => l.mid);
  const done = await haveMovements(env, clientId, ids);
  const todo = lines.filter((l) => !done.has(l.mid));
  if (!todo.length) return { ok: true, repeated: true };
  const checks = todo.map((l) => ({ code: String(l.code), unit: 'qty', qty: l.qty }));
  const r = await shopCall(env, clientId, 'xb-sell', { checks, body: { stockMovementLog: todo.map((l) => mv(l.mid, l.code, -l.qty, reason)) }, serverNow: Date.now() });
  if (!r.ok) { const e = new Error('That branch’s database did not answer. Nothing was taken; try again.'); e.code = 'busy'; throw e; }
  const j = await r.json();
  if (j && j.ok === false) return { ok: false, short: j.short };
  await poke(env, clientId);
  return { ok: true };
}
// Put stock ON a branch's shop floor. An item the branch does not stock yet is created first (same code, name, unit and price; quantity 0),
// then the movement adds the quantity. Idempotent by movement id.
export async function floorIn(env, clientId, lines, reason) {
  await requireDb(env, clientId);
  const done = await haveMovements(env, clientId, lines.map((l) => l.mid));
  const todo = lines.filter((l) => !done.has(l.mid));
  if (!todo.length) return { ok: true, repeated: true };
  const have = new Set((await floorItems(env, clientId)).map((i) => String(i.code)));
  const missing = todo.filter((l) => !have.has(String(l.code)));
  if (missing.length) {
    const t = Date.now();
    const r0 = await shopCall(env, clientId, 'push', { body: { inventory: missing.map((l) => ({ code: String(l.code), name: l.name, unit: l.unit || 'pcs', price: num(l.unit_price), wholesalePrice: num(l.unit_cost), qty: 0, type: 'item', updatedAt: t, createdBy: 'hq-transfer' })) }, serverNow: t });
    if (!r0.ok) { const e = new Error('That branch’s database did not answer. Nothing was added; try again.'); e.code = 'busy'; throw e; }
  }
  const r = await shopCall(env, clientId, 'push', { body: { stockMovementLog: todo.map((l) => mv(l.mid, l.code, l.qty, reason)) }, serverNow: Date.now() });
  if (!r.ok) { const e = new Error('That branch’s database did not answer. Nothing was added; try again.'); e.code = 'busy'; throw e; }
  await poke(env, clientId);
  return { ok: true };
}
async function poke(env, clientId) {
  try { if (env.SYNC_ROOM) { const room = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(clientId)); Promise.resolve(room.fetch('https://sync-room/broadcast', { method: 'POST', body: JSON.stringify({ poke: true }) })).catch(() => {}); } } catch (e) { /* their next check */ }
}

/* ---------- a LOCATION's stock (this database), always with its movement rows in the same transaction ---------- */
// lines: [{ mid, code, name, unit, unit_cost, qty (signed) }]. One D1 batch = one transaction: a location going below zero (CHECK) or a movement id
// that exists already (PRIMARY KEY) rolls back the WHOLE batch. -> { ok } | { ok:false, short } | { ok:true, repeated:true }
export async function locApply(db, groupId, clientId, locId, lines, meta) {
  const ids = lines.map((l) => l.mid);
  const seen = await all(db, `SELECT movement_id FROM inv_movement WHERE group_id = ? AND movement_id IN (${ids.map(() => '?').join(',')})`, groupId, ...ids);
  if (seen.length === ids.length) return { ok: true, repeated: true };
  if (seen.length) { const s = new Set(seen.map((r) => r.movement_id)); lines = lines.filter((l) => !s.has(l.mid)); }
  for (const l of lines.filter((x) => x.qty < 0)) {
    const row = await one(db, 'SELECT qty FROM inv_loc_stock WHERE group_id = ? AND location_id = ? AND code = ?', groupId, locId, String(l.code));
    if (!row || row.qty + l.qty < -1e-9) return { ok: false, short: { code: String(l.code), available: row ? row.qty : 0 } };
  }
  const now = Date.now(), stmts = [];
  for (const l of lines) {
    if (l.qty >= 0) stmts.push(db.prepare('INSERT INTO inv_loc_stock (group_id, location_id, code, name, unit, unit_cost, qty, updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (group_id, location_id, code) DO UPDATE SET qty = qty + excluded.qty, name = excluded.name, updated_at = excluded.updated_at')
      .bind(groupId, locId, String(l.code), l.name || String(l.code), l.unit || 'pcs', num(l.unit_cost), num(l.qty), now));
    else stmts.push(db.prepare('UPDATE inv_loc_stock SET qty = qty + ?, updated_at = ? WHERE group_id = ? AND location_id = ? AND code = ?').bind(num(l.qty), now, groupId, locId, String(l.code)));
    stmts.push(db.prepare('INSERT INTO inv_movement (group_id, movement_id, at, kind, client_id, location_id, code, name, unit, qty, xfer_id, ref, actor, reason, reverses) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(groupId, l.mid, now, meta.kind, clientId, locId, String(l.code), l.name || null, l.unit || null, num(l.qty), meta.xfer_id || null, meta.ref || null, meta.actor || null, meta.reason || null, meta.reverses || null));
  }
  try { await db.batch(stmts); }
  catch (e) {
    const m = String(e && e.message || e);
    if (/CHECK constraint/i.test(m)) return { ok: false, short: { code: '?', available: 0 }, race: true };
    if (/UNIQUE|PRIMARY KEY/i.test(m)) return { ok: true, repeated: true };
    throw e;
  }
  return { ok: true };
}
// the floor side keeps its own ledger (the shop database); the business-wide history gets a row too, for the reports
export async function logFloor(db, groupId, clientId, lines, meta) {
  const now = Date.now();
  const stmts = lines.map((l) => db.prepare('INSERT INTO inv_movement (group_id, movement_id, at, kind, client_id, location_id, code, name, unit, qty, xfer_id, ref, actor, reason, reverses) VALUES (?,?,?,?,?,\'floor\',?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
    .bind(groupId, l.mid, now, meta.kind, clientId, String(l.code), l.name || null, l.unit || null, num(l.qty), meta.xfer_id || null, meta.ref || null, meta.actor || null, meta.reason || null, meta.reverses || null));
  if (stmts.length) await db.batch(stmts);
}
// Move stock at ONE end (floor or location) of a transfer: out (negative) or in (positive)
export async function applyAt(env, db, groupId, clientId, locId, lines, meta) {
  if (locId === 'floor') {
    const pos = lines.filter((l) => l.qty > 0), neg = lines.filter((l) => l.qty < 0);
    if (neg.length) { const r = await floorOut(env, clientId, neg.map((l) => ({ ...l, qty: -l.qty })), meta.reason); if (!r.ok) return r; }
    if (pos.length) await floorIn(env, clientId, pos, meta.reason);
    await logFloor(db, groupId, clientId, lines, meta);
    return { ok: true };
  }
  return locApply(db, groupId, clientId, locId, lines, meta);
}

/* ---------- transfers ---------- */
export async function nextRef(db, groupId, internal) {
  const name = internal ? 'move' : 'transfer';
  const r = await db.prepare('INSERT INTO org_seq (group_id, name, n) VALUES (?,?,1) ON CONFLICT (group_id, name) DO UPDATE SET n = n + 1 RETURNING n').bind(groupId, name).first();
  return (internal ? 'MV-' : 'TR-') + String(r.n).padStart(5, '0');
}
export const xferRow = (db, groupId, id) => one(db, 'SELECT * FROM xfer WHERE group_id = ? AND xfer_id = ?', groupId, id);
export const xferLines = (db, groupId, id) => all(db, 'SELECT * FROM xfer_line WHERE group_id = ? AND xfer_id = ? ORDER BY line_id', groupId, id);
export const xferEvents = (db, groupId, id) => all(db, 'SELECT * FROM xfer_event WHERE group_id = ? AND xfer_id = ? ORDER BY at', groupId, id);
export async function event(db, groupId, xferId, actor, action, detail, eventId) {
  await db.prepare('INSERT INTO xfer_event (group_id, event_id, xfer_id, at, actor, action, detail) VALUES (?,?,?,?,?,?,?)').bind(groupId, eventId || rid('E'), xferId, Date.now(), actor || null, action, detail == null ? null : JSON.stringify(detail)).run();
}
export async function listXfers(db, groupId, { status, clientIds, limit = 300 } = {}) {
  const rows = status
    ? await all(db, 'SELECT * FROM xfer WHERE group_id = ? AND status = ? ORDER BY updated_at DESC LIMIT ?', groupId, status, limit)
    : await all(db, 'SELECT * FROM xfer WHERE group_id = ? ORDER BY updated_at DESC LIMIT ?', groupId, limit);
  return clientIds ? rows.filter((x) => clientIds.includes(x.from_client) || clientIds.includes(x.to_client)) : rows;
}
// quantities still on the road, per line: dispatched minus everything accounted for at the destination
export const inTransitOf = (l) => num(l.qty_disp - l.qty_recv - l.qty_damaged - l.qty_missing);
export function statusAfterReceipt(lines) {
  const open = lines.some((l) => inTransitOf(l) > 1e-9);
  if (open) return 'partial';
  const unresolved = lines.some((l) => num(l.qty_damaged + l.qty_missing) > 1e-9 && !l.resolution);
  return unresolved ? 'discrepancy' : 'completed';
}
