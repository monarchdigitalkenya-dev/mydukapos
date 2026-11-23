// functions/api/_store-d1.js — the Store (warehouse) on D1 (zip 153).
//
// WHY: the KV version read the whole list, changed it in memory and wrote it back, so two people withdrawing at once could both
// succeed, a withdrawal was never tied to the branch that received the stock, and an item taken to zero was DELETED (its history
// gone). Here:
//   * quantity has CHECK (qty >= 0): a withdrawal that would go negative aborts the WHOLE batch — nothing partial;
//   * a Store -> Branch transfer is one batch: the movement row (with destination, who, when) + the quantity change together;
//   * zero stock stays as a row; "delete" only archives; movements are never edited away and rows are never deleted;
//   * a transfer is IN_TRANSIT until the receiving branch confirms it (idempotent), and can be cancelled while in transit
//     (stock returns to the store, once).
import { ensureLedgerSchema } from './_ledger.js';
import { randomToken } from './_license.js';
import { cleanExtras, applyExtras } from './_store-extra.js';
import { ensureIntegritySchema } from './_stock-integrity-schema.js';
import { requirePayProof } from './_pay-guard.js';

const NUM = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const iso = (t) => new Date(t).toISOString();

const rowToItem = (r) => ({ id: r.item_id, code: r.code || null, name: r.name, unit: r.unit, price: r.price, wholesaleSellingPrice: r.wholesale_selling_price, wholesalePrice: r.wholesale_price, qty: r.qty });

// zip 301: the descriptive extras (category, supplier, notes, reorder level, minimum price, variant link) live in ledger_meta under
// store_extra:<group>:<item> - no schema change, and a stock change never touches them.
const xKey = (g, id) => `store_extra:${g}:${id}`;
async function extrasMap(db, g) {
  const m = new Map();
  try {
    const r = await db.prepare(`SELECT k, v FROM ledger_meta WHERE k LIKE ?`).bind(`store_extra:${g}:%`).all();
    for (const row of r.results || []) { try { m.set(String(row.k).slice(`store_extra:${g}:`.length), JSON.parse(row.v)); } catch (e) { /* unreadable detail skipped */ } }
  } catch (e) { /* no extras yet */ }
  return m;
}
async function items(db, g) {
  const r = await db.prepare(`SELECT * FROM store_items WHERE group_id = ? AND archived = 0 ORDER BY lower(name)`).bind(g).all();
  const ex = await extrasMap(db, g);
  // zip 336: the batches held in the store for each item (lot number, expiry, cost, quantity) - only items that have any
  const lots = new Map();
  try {
    const lr = await db.prepare(`SELECT item_id, lot_id, batch, expiry, cost, qty FROM store_lots WHERE group_id = ? AND qty > 0 ORDER BY expiry`).bind(g).all();
    for (const l of lr.results || []) { if (!lots.has(l.item_id)) lots.set(l.item_id, []); lots.get(l.item_id).push({ id: l.lot_id, b: l.batch, e: l.expiry, c: l.cost, q: l.qty }); }
  } catch (e) { /* no batches table yet */ }
  return (r.results || []).map((row) => Object.assign(rowToItem(row), ex.get(row.item_id) || {}, lots.has(row.item_id) ? { lots: lots.get(row.item_id) } : {}));
}
async function writeExtras(db, g, itemId, ex) {
  const cur = await db.prepare(`SELECT v FROM ledger_meta WHERE k = ?`).bind(xKey(g, itemId)).first();
  let o = {}; try { o = cur ? JSON.parse(cur.v) : {}; } catch (e) { o = {}; }
  o = applyExtras(o, ex);
  return db.prepare(`INSERT INTO ledger_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(xKey(g, itemId), JSON.stringify(o));
}

// One-time import of the old KV store (items + log) into D1 for this group. Safe to race: every insert is OR IGNORE and the flag is set last.
async function migrateFromKv(env, db, g) {
  const flag = `store_migrated:${g}`;
  const done = await db.prepare(`SELECT v FROM ledger_meta WHERE k = ?`).bind(flag).first();
  if (done) return;
  let oldItems = [], oldLog = [];
  if (env.mydukapos_kv) {
    try { const raw = await env.mydukapos_kv.get(`store:${g}`); if (raw) oldItems = JSON.parse(raw); } catch (e) { /* unreadable legacy data is skipped, never fatal */ }
    try { const raw = await env.mydukapos_kv.get(`store-log:${g}`); if (raw) oldLog = JSON.parse(raw); } catch (e) { /* same */ }
  }
  const now = Date.now();
  const st = [];
  for (const it of oldItems) {
    if (!it || !it.name || !it.id) continue;
    st.push(db.prepare(`INSERT OR IGNORE INTO store_items (group_id, item_id, code, name, unit, price, wholesale_selling_price, wholesale_price, qty, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`)
      .bind(g, String(it.id), it.code || null, String(it.name), it.unit || 'pcs', NUM(it.price), NUM(it.wholesaleSellingPrice), NUM(it.wholesalePrice), Math.max(0, NUM(it.qty)), now, now));
  }
  for (const l of oldLog) {
    if (!l || !l.id) continue;
    const at = Date.parse(l.timestamp) || now;
    st.push(db.prepare(`INSERT OR IGNORE INTO store_movements (group_id, movement_id, kind, item_name, qty, status, actor, at, detail) VALUES (?,?,?,?,0,'DONE',?,?,?)`)
      .bind(g, 'legacy-' + l.id, 'LEGACY:' + (l.action || 'edit'), l.itemName || null, l.servedBy || null, at, l.detail || null));
  }
  st.push(db.prepare(`INSERT OR IGNORE INTO ledger_meta (k, v) VALUES (?, ?)`).bind(flag, String(now)));
  await db.batch(st);
}

const matchSql = (code) => code ? { where: `group_id = ? AND archived = 0 AND code IS NOT NULL AND lower(code) = lower(?)`, key: code }
  : { where: `group_id = ? AND archived = 0 AND code IS NULL AND lower(name) = lower(?)`, key: null };

// zip 336: WHICH store row an incoming line belongs to. The old rule was "same code, or - only when the line has NO code - same name", so stock
// coming in WITH a code (from Inventory, where every item has one) never found the store's own code-less row of the same item and made a second
// "Hospital gloves" line. Now, in this order:
//   1. the store item the person picked (storeItemId) - the till remembers which store line an item went to before;
//   2. the same code;
//   3. a store line of the same name that has NO code yet - it takes the incoming code, so from then on the code finds it;
//   4. (a line with no code) the ONE coded store line of that name.
// Two store lines of the same name with DIFFERENT codes are different products as far as the server can tell: never merged here (they show in the
// Store check, where a manager can merge them, audited). `seen` carries the rows created earlier in the same batch, so a repeated line in one
// import adds to the row the first line created instead of trying to create it twice.
export async function findStoreTarget(db, g, inc, seen = new Map()) {
  const name = String(inc.name || '').trim(), code = String(inc.code || '').trim();
  const kCode = code ? 'c:' + code.toLowerCase() : null, kName = 'n:' + name.toLowerCase();
  if (inc.storeItemId) {
    const r = await db.prepare(`SELECT * FROM store_items WHERE group_id = ? AND item_id = ? AND archived = 0`).bind(g, String(inc.storeItemId)).first();
    if (r) return { id: r.item_id, how: 'chosen', adopt: code && !r.code ? code : null };
  }
  if (kCode && seen.has(kCode)) return { id: seen.get(kCode), how: 'code' };
  if (code) {
    const r = await db.prepare(`SELECT item_id FROM store_items WHERE group_id = ? AND archived = 0 AND code IS NOT NULL AND lower(code) = lower(?)`).bind(g, code).first();
    if (r) return { id: r.item_id, how: 'code' };
  }
  if (seen.has(kName)) return { id: seen.get(kName), how: 'name' };
  const bare = await db.prepare(`SELECT item_id FROM store_items WHERE group_id = ? AND archived = 0 AND code IS NULL AND lower(name) = lower(?)`).bind(g, name).first();
  if (bare) return { id: bare.item_id, how: 'name', adopt: code || null };
  if (!code) {
    const coded = (await db.prepare(`SELECT item_id FROM store_items WHERE group_id = ? AND archived = 0 AND code IS NOT NULL AND lower(name) = lower(?) LIMIT 2`).bind(g, name).all()).results || [];
    if (coded.length === 1) return { id: coded[0].item_id, how: 'name' };
  }
  return null;
}

// lots (zip 336): [{ id, b, e, c, r, s, q }] as the till's batch engine records them -> statements that add them to the store line's batches
function lotAddStatements(db, g, itemId, lots, now) {
  return (Array.isArray(lots) ? lots : []).slice(0, 40).filter((l) => l && l.id && NUM(l.q) > 0).map((l) =>
    db.prepare(`INSERT INTO store_lots (group_id, item_id, lot_id, batch, expiry, cost, received_at, supplier, qty, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (group_id, item_id, lot_id) DO UPDATE SET qty = qty + excluded.qty, updated_at = excluded.updated_at`)
      .bind(g, itemId, String(l.id).slice(0, 60), l.b ? String(l.b).slice(0, 60) : null, l.e ? String(l.e).slice(0, 10) : null,
        (l.c === null || l.c === undefined || l.c === '' || !Number.isFinite(Number(l.c))) ? null : Number(l.c), Number(l.r) || null, l.s ? String(l.s).slice(0, 80) : null, NUM(l.q), now));
}

// how (zip 318): { kind, idem, source } - a branch putting its own stock into the store is kind 'TRANSFER_IN', with its idempotency key and
// the branch it came from on the movement. target (zip 336): the row findStoreTarget chose, or null for a new store line.
function addStatements(db, g, inc, actor, note, how = {}, target = null, seen = null) {
  const kind = how.kind || 'ADD', idem = how.idem || null, source = how.source || null;
  const name = String(inc.name || '').trim();
  if (!name) return [];
  const qty = Math.max(0, NUM(inc.qty));
  const code = String(inc.code || '').trim();
  const now = Date.now();
  const opt = (v) => { if (v === undefined || v === '') return null; const n = parseFloat(v); return n ? n : null; };
  const price = opt(inc.price), wss = opt(inc.wholesaleSellingPrice), wp = opt(inc.wholesalePrice);
  const unit = inc.unit ? String(inc.unit) : null;
  if (target) {
    return [
      // the movement records the level BEFORE this add
      db.prepare(`INSERT INTO store_movements (group_id, movement_id, kind, item_id, item_name, unit, qty, qty_before, qty_after, source_client_id, status, actor, at, idem_key, detail)
        SELECT ?, ?, ?, item_id, name, unit, ?, qty, qty + ?, ?, 'DONE', ?, ?, ?, ? FROM store_items WHERE group_id = ? AND item_id = ?`)
        .bind(g, 'm-' + randomToken(10), kind, qty, qty, source, actor, now, idem, note + (target.how === 'name' || target.how === 'chosen' ? ` (matched by ${target.how === 'chosen' ? 'the store line picked' : 'name'})` : ''), g, target.id),
      db.prepare(`UPDATE store_items SET qty = qty + ?, price = COALESCE(?, price), wholesale_selling_price = COALESCE(?, wholesale_selling_price), wholesale_price = COALESCE(?, wholesale_price), unit = COALESCE(?, unit),
        code = COALESCE(code, ?), updated_at = ? WHERE group_id = ? AND item_id = ?`)
        .bind(qty, price, wss, wp, unit, target.adopt || null, now, g, target.id),
      ...lotAddStatements(db, g, target.id, inc.lots, now),
    ];
  }
  const newId = randomToken(10);
  if (seen) { if (code) seen.set('c:' + code.toLowerCase(), newId); seen.set('n:' + name.toLowerCase(), newId); }
  return [
    db.prepare(`INSERT INTO store_items (group_id, item_id, code, name, unit, price, wholesale_selling_price, wholesale_price, qty, archived, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`)
      .bind(g, newId, code || null, name, unit || 'pcs', price || 0, wss || 0, wp || 0, qty, now, now),
    db.prepare(`INSERT INTO store_movements (group_id, movement_id, kind, item_id, item_name, unit, qty, qty_before, qty_after, source_client_id, status, actor, at, idem_key, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'DONE', ?, ?, ?, ?)`)
      .bind(g, 'm-' + randomToken(10), kind, newId, name, unit || 'pcs', qty, qty, source, actor, now, idem, note),
    ...lotAddStatements(db, g, newId, inc.lots, now),
  ];
}

// FEFO from the store's batches of one item (zip 336): earliest expiry first among batches still in date, then the expired ones (moving stock
// between places is not selling it - an expired batch can still go back to Inventory, where it can never be SOLD), oldest received breaks a tie.
// Returns { lots: [{ id, b, e, c, r, s, q }], statements } for `qty`; units the batches do not cover (stock from before batches were kept) are just not in `lots`.
async function lotTakeStatements(db, g, itemId, qty, now) {
  const rows = (await db.prepare(`SELECT * FROM store_lots WHERE group_id = ? AND item_id = ? AND qty > 0`).bind(g, itemId).all()).results || [];
  if (!rows.length) return { lots: [], statements: [] };
  const today = new Date(now + 3 * 3600000).toISOString().slice(0, 10);
  const exp = (r) => r.expiry || '9999-12-31';
  rows.sort((a, b) => ((exp(a) < today) - (exp(b) < today)) || exp(a).localeCompare(exp(b)) || ((a.received_at || 0) - (b.received_at || 0)));
  let need = qty; const lots = [], statements = [];
  for (const r of rows) {
    if (need <= 1e-9) break;
    const q = Math.min(need, NUM(r.qty));
    if (q <= 0) continue;
    need = Math.round((need - q) * 1000) / 1000;
    lots.push({ id: r.lot_id, b: r.batch, e: r.expiry, c: r.cost, r: r.received_at, s: r.supplier, q: Math.round(q * 1000) / 1000 });
    // CHECK (qty >= 0): if another withdrawal took this batch in the meantime the WHOLE batch of statements fails - nothing is taken twice
    statements.push(db.prepare(`UPDATE store_lots SET qty = qty - ?, updated_at = ? WHERE group_id = ? AND item_id = ? AND lot_id = ?`).bind(q, now, g, itemId, r.lot_id));
  }
  return { lots, statements };
}

async function destInfo(env, groupId, caller, wanted, getLicense) {
  if (!wanted || wanted === caller.id) return { id: caller.id, label: caller.businessName || caller.name || caller.id };
  const d = await getLicense(env, wanted);
  if (!d || (d.branchGroupId || d.id) !== groupId) return null;
  return { id: d.id, label: d.businessName || d.name || d.id };
}

const KIND_ACTION = { ADD: 'add', EDIT: 'edit', QTY: 'qty_change', TRANSFER_OUT: 'withdraw', ARCHIVE: 'delete', TRANSFER_IN: 'moved_in', BRANCH_OUT: 'branch_transfer', BRANCH_REQUEST: 'branch_request' };

export async function handleStoreD1(env, db, ctx) {
  const { body, groupId: g, record, getLicense, json } = ctx;
  await ensureLedgerSchema(db);
  await ensureIntegritySchema(db);
  await migrateFromKv(env, db, g);
  const actor = body.servedBy || null;
  const a = body.action;
  const now = Date.now();

  if (a === 'get') return json({ items: await items(db, g) });

  if (a === 'getLog') {
    const r = await db.prepare(`SELECT * FROM store_movements WHERE group_id = ? ORDER BY at DESC, rowid DESC LIMIT 500`).bind(g).all();
    const log = (r.results || []).map((m) => {
      const k = String(m.kind);
      const action = k.startsWith('LEGACY:') ? k.slice(7) : (KIND_ACTION[k] || k.toLowerCase());
      let detail = m.detail || '';
      if (k === 'BRANCH_OUT') detail = `${m.qty} ${m.unit || 'pcs'} ${m.detail || ''} to ${m.dest_label || 'branch'} (not through the store) — ${String(m.status).toLowerCase().replace('_', ' ')}`;
      if (k === 'TRANSFER_OUT') detail = `${m.qty} ${m.unit || 'pcs'} to ${m.dest_label || 'branch'} — ${String(m.status).toLowerCase().replace('_', ' ')}${m.detail ? ' — ' + m.detail : ''}`;
      if (k === 'BRANCH_REQUEST') detail = `${m.qty} ${m.unit || 'pcs'} asked from ${m.dest_label || 'a branch'} for the store — ${String(m.status).toLowerCase()}`;
      return { id: m.movement_id, timestamp: iso(m.at), action, itemName: m.item_name, detail, servedBy: m.actor, status: m.status, destination: m.dest_label || null, qtyBefore: m.qty_before, qtyAfter: m.qty_after };
    });
    return json({ log });
  }

  if (a === 'addManual') {
    if (!body.item || !body.item.name) return json({ error: 'Item name is required.' }, 400);
    const tgt = await findStoreTarget(db, g, body.item);
    try { await db.batch(addStatements(db, g, body.item, actor, `Added manually — ${NUM(body.item.qty)} ${body.item.unit || 'pcs'}`, {}, tgt)); }
    catch (e) { return json({ error: 'Another store item already uses that name or code - nothing was added. Refresh and try again.' }, 409); }
    return json({ items: await items(db, g) });
  }

  if (a === 'addFromCsv' || a === 'addFromInventory') {
    if (!Array.isArray(body.items) || !body.items.length) return json({ error: 'No items to add.' }, 400);
    const note = a === 'addFromCsv' ? 'Imported via CSV' : 'Imported from inventory (code/name/price only)';
    const st = [], seen = new Map();
    // merge duplicates inside one import safely: a repeat line targets the row the first one created (seen)
    for (const it of body.items) st.push(...addStatements(db, g, it, actor, note, {}, await findStoreTarget(db, g, it, seen), seen));
    if (st.length) { try { await db.batch(st); } catch (e) { return json({ error: 'Some of these clash with a store item changed at the same moment - nothing was added. Try again.' }, 409); } }
    return json({ items: await items(db, g) });
  }

  if (a === 'setQty') {
    if (!body.storeItemId) return json({ error: 'No item specified.' }, 400);
    const qty = parseFloat(body.qty);
    if (isNaN(qty) || qty < 0) return json({ error: 'Enter a valid quantity.' }, 400);
    const it = await db.prepare(`SELECT * FROM store_items WHERE group_id = ? AND item_id = ? AND archived = 0`).bind(g, body.storeItemId).first();
    if (!it) return json({ error: 'Item not found.' }, 404);
    await db.batch([
      db.prepare(`INSERT INTO store_movements (group_id, movement_id, kind, item_id, item_name, unit, qty, qty_before, qty_after, status, actor, at, detail)
        SELECT group_id, ?, 'QTY', item_id, name, unit, ? - qty, qty, ?, 'DONE', ?, ?, 'Quantity corrected from ' || qty || ' to ' || ? || ' ' || unit FROM store_items WHERE group_id = ? AND item_id = ?`)
        .bind('m-' + randomToken(10), qty, qty, actor, now, qty, g, body.storeItemId),
      db.prepare(`UPDATE store_items SET qty = ?, updated_at = ? WHERE group_id = ? AND item_id = ?`).bind(qty, now, g, body.storeItemId),
    ]);
    return json({ items: await items(db, g) });
  }

  if (a === 'updateFields') {
    if (!body.storeItemId) return json({ error: 'No item specified.' }, 400);
    if (!body.fields || typeof body.fields !== 'object') return json({ error: 'No fields to update.' }, 400);
    const it = await db.prepare(`SELECT * FROM store_items WHERE group_id = ? AND item_id = ? AND archived = 0`).bind(g, body.storeItemId).first();
    if (!it) return json({ error: 'Item not found.' }, 404);
    const f = body.fields;
    const set = { name: it.name, code: it.code, unit: it.unit, price: it.price, wholesale_price: it.wholesale_price, wholesale_selling_price: it.wholesale_selling_price };
    if (f.name !== undefined) { const n = String(f.name).trim(); if (!n) return json({ error: 'Item name cannot be blank.' }, 400); set.name = n; }
    if (f.code !== undefined) {
      const c = String(f.code).trim();
      if (c) {
        const clash = await db.prepare(`SELECT 1 x FROM store_items WHERE group_id = ? AND archived = 0 AND item_id <> ? AND code IS NOT NULL AND lower(code) = lower(?)`).bind(g, it.item_id, c).first();
        if (clash) return json({ error: `"${c}" is already used by another store item.` }, 400);
      }
      set.code = c || null;
    }
    for (const [k, col] of [['price', 'price'], ['wholesalePrice', 'wholesale_price'], ['wholesaleSellingPrice', 'wholesale_selling_price']]) {
      if (f[k] !== undefined) { const v = parseFloat(f[k]); if (isNaN(v) || v < 0) return json({ error: `Enter a valid ${k}.` }, 400); set[col] = v; }
    }
    if (f.unit !== undefined) { const u = String(f.unit).trim(); if (u) set.unit = u; }
    const ex = cleanExtras(f);
    if (ex.error) return json({ error: ex.error }, 400);
    const exStmt = (Object.keys(ex.set).length || ex.clear.length) ? [await writeExtras(db, g, it.item_id, ex)] : [];
    try {
      await db.batch([
        ...exStmt,
        db.prepare(`UPDATE store_items SET name=?, code=?, unit=?, price=?, wholesale_price=?, wholesale_selling_price=?, updated_at=? WHERE group_id=? AND item_id=?`)
          .bind(set.name, set.code, set.unit, set.price, set.wholesale_price, set.wholesale_selling_price, now, g, it.item_id),
        db.prepare(`INSERT INTO store_movements (group_id, movement_id, kind, item_id, item_name, unit, qty, qty_before, qty_after, status, actor, at, detail) VALUES (?,?,'EDIT',?,?,?,0,?,?,'DONE',?,?,?)`)
          .bind(g, 'm-' + randomToken(10), it.item_id, set.name, set.unit, it.qty, it.qty, actor, now, `Updated: ${Object.keys(f).join(', ')}`),
      ]);
    } catch (e) { return json({ error: 'Another item already uses that name or code.' }, 400); }
    return json({ items: await items(db, g) });
  }

  // zip 301: extra details of several items at once (found by id or by code). Descriptive only - quantity is never touched.
  if (a === 'setExtras') {
    const entries = (Array.isArray(body.entries) ? body.entries : []).slice(0, 200);
    if (!entries.length) return json({ error: 'Nothing to update.' }, 400);
    const st = [];
    for (const e of entries) {
      const row = e.storeItemId
        ? await db.prepare(`SELECT item_id FROM store_items WHERE group_id = ? AND item_id = ? AND archived = 0`).bind(g, String(e.storeItemId)).first()
        : (e.code ? await db.prepare(`SELECT item_id FROM store_items WHERE group_id = ? AND archived = 0 AND code IS NOT NULL AND lower(code) = lower(?)`).bind(g, String(e.code)).first() : null);
      if (!row) continue;
      const ex = cleanExtras(e.extras); if (ex.error) return json({ error: ex.error }, 400);
      st.push(await writeExtras(db, g, row.item_id, ex));
    }
    if (st.length) await db.batch(st);
    return json({ items: await items(db, g) });
  }

  // Store -> Branch, atomic. `idemKey` makes a retry return the same transfer instead of taking the stock twice.
  if (a === 'removeFromStore') {
    if (!Array.isArray(body.items) || !body.items.length) return json({ error: 'No items selected.' }, 400);
    const dest = await destInfo(env, g, record, body.destClientId, getLicense);
    if (!dest) return json({ error: 'That destination is not in your branch group.' }, 400);
    const idem = body.idemKey ? String(body.idemKey).slice(0, 80) : null;
    const purpose = body.purpose ? String(body.purpose).slice(0, 120) : null;   // zip 293: e.g. "taken to the sales counter"
    const lines = [];
    for (const req of body.items) {
      const qty = NUM(req.qty);
      if (!req.storeItemId || qty <= 0) continue;
      lines.push({ id: String(req.storeItemId), qty });
    }
    if (!lines.length) return json({ error: 'No items selected.' }, 400);
    const shape = (m) => { const s = m.snapshot ? JSON.parse(m.snapshot) : {}; return { movementId: m.movement_id, storeItemId: m.item_id, code: s.code || null, name: m.item_name, unit: m.unit, price: s.price || 0, wholesaleSellingPrice: s.wholesaleSellingPrice || 0, wholesalePrice: s.wholesalePrice || 0, qty: m.qty, status: m.status, destClientId: m.dest_client_id, destLabel: m.dest_label, ...(Array.isArray(s.lots) && s.lots.length ? { lots: s.lots } : {}) }; };
    if (idem) {
      const prev = await db.prepare(`SELECT * FROM store_movements WHERE group_id = ? AND idem_key LIKE ? ORDER BY rowid`).bind(g, idem + ':%').all();
      if ((prev.results || []).length) return json({ items: await items(db, g), withdrawn: prev.results.map(shape), replay: true });
    }
    // one movement per store item (a repeated item in the request is summed first)
    const sum = new Map(); lines.forEach((l) => sum.set(l.id, (sum.get(l.id) || 0) + l.qty));
    const st = [], ids = [];
    let n = 0;
    for (const [itemId, qty] of sum) {
      const mid = 'x-' + randomToken(10);
      ids.push(mid);
      // zip 336: the store's batches of this item go with it (earliest expiry first), so the branch gets the same batch, expiry and cost back
      const lt = await lotTakeStatements(db, g, itemId, qty, now);
      st.push(db.prepare(`INSERT INTO store_movements (group_id, movement_id, kind, item_id, item_name, unit, qty, qty_before, qty_after, source_client_id, dest_client_id, dest_label, status, actor, at, idem_key, detail, snapshot)
        SELECT group_id, ?, 'TRANSFER_OUT', item_id, name, unit, ?, qty, qty - ?, ?, ?, ?, 'IN_TRANSIT', ?, ?, ?, ?,
          json_set(json_object('code', code, 'price', price, 'wholesaleSellingPrice', wholesale_selling_price, 'wholesalePrice', wholesale_price), '$.lots', json(?))
        FROM store_items WHERE group_id = ? AND item_id = ? AND archived = 0`)
        .bind(mid, qty, qty, record.id, dest.id, dest.label, actor, now, idem ? `${idem}:${n++}` : null, purpose, JSON.stringify(lt.lots), g, itemId));
      // CHECK (qty >= 0) makes this statement — and therefore the WHOLE batch — fail if the store holds less than asked
      st.push(db.prepare(`UPDATE store_items SET qty = qty - ?, updated_at = ? WHERE group_id = ? AND item_id = ? AND archived = 0 AND EXISTS (SELECT 1 FROM store_movements WHERE group_id = ? AND movement_id = ?)`)
        .bind(qty, now, g, itemId, g, mid));
      st.push(...lt.statements);
    }
    try { await db.batch(st); }
    catch (e) {
      // the same request sent twice at the same moment: the second hits the idempotency key - answer with the first one's result
      if (idem) { const again = await db.prepare(`SELECT * FROM store_movements WHERE group_id = ? AND idem_key LIKE ? ORDER BY rowid`).bind(g, idem + ':%').all(); if ((again.results || []).length) return json({ items: await items(db, g), withdrawn: again.results.map(shape), replay: true }); }
      return json({ error: 'Not enough stock in the store for this withdrawal — nothing was taken. Refresh and try again.', items: await items(db, g) }, 409);
    }
    const got = await db.prepare(`SELECT * FROM store_movements WHERE group_id = ? AND movement_id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid`).bind(g, ...ids).all();
    const withdrawn = (got.results || []).map(shape);
    if (!withdrawn.length) return json({ error: 'Item not found.', items: await items(db, g) }, 404);
    return json({ items: await items(db, g), withdrawn });
  }

  // zip 318: Inventory -> "Move". A branch puts some of its OWN stock into the store (depositFromBranch), or sends it straight to another
  // branch (sendToBranch). The till takes the quantity off its own stock after this answers (it already checked it has that much); the server
  // side is idempotent on idemKey, so a lost reply and a retry never add the stock twice.
  //   depositFromBranch: { idemKey, items: [{ code, name, unit, price, wholesaleSellingPrice, wholesalePrice, qty }] } -> { items, moved }
  //   sendToBranch:      { idemKey, destClientId, items: [{ code, name, unit, price, ..., qty, variantCode?, variantName? }] } -> { moved }
  //     The other branch receives it exactly like a transfer from the store (pendingTransfers / receive): IN_TRANSIT until it is applied there.
  if (a === 'depositFromBranch' || a === 'sendToBranch') {
    const idem = String(body.idemKey || '').slice(0, 80);
    if (!idem) return json({ error: 'Missing request key.' }, 400);
    const lines = (Array.isArray(body.items) ? body.items : []).slice(0, 50).filter((x) => x && String(x.name || '').trim() && NUM(x.qty) > 0);
    if (!lines.length) return json({ error: 'Enter how many to move.' }, 400);
    const prev = await db.prepare(`SELECT movement_id FROM store_movements WHERE group_id = ? AND idem_key LIKE ?`).bind(g, idem + ':%').all();
    const replay = (prev.results || []).length > 0;
    const here = record.businessName || record.label || record.name || record.id;
    if (a === 'depositFromBranch') {
      if (!replay) {
        const st = [], seen = new Map();
        for (let i = 0; i < lines.length; i++) { const x = lines[i]; st.push(...addStatements(db, g, x, actor, `Moved in from ${here}`, { kind: 'TRANSFER_IN', idem: `${idem}:${i}`, source: record.id }, await findStoreTarget(db, g, x, seen), seen)); }
        try { await db.batch(st); } catch (e) { return json({ error: 'The store could not take that right now - nothing was moved. Try again.' }, 409); }
      }
      return json({ items: await items(db, g), moved: true, replay });
    }
    const dest = await destInfo(env, g, record, String(body.destClientId || ''), getLicense);
    if (!dest || dest.id === record.id) return json({ error: 'Choose another branch of this business.' }, 400);
    if (!replay) {
      await db.batch(lines.map((x, i) => db.prepare(`INSERT INTO store_movements (group_id, movement_id, kind, item_id, item_name, unit, qty, source_client_id, dest_client_id, dest_label, status, actor, at, idem_key, detail, snapshot)
        VALUES (?, ?, 'BRANCH_OUT', NULL, ?, ?, ?, ?, ?, ?, 'IN_TRANSIT', ?, ?, ?, ?, ?)`)
        .bind(g, 'b-' + randomToken(10), String(x.name).slice(0, 160), String(x.unit || 'pcs'), NUM(x.qty), record.id, dest.id, dest.label, actor, now, `${idem}:${i}`, `from ${here}`,
          JSON.stringify({ code: x.code ? String(x.code) : null, price: NUM(x.price), wholesaleSellingPrice: NUM(x.wholesaleSellingPrice), wholesalePrice: NUM(x.wholesalePrice), variantCode: x.variantCode ? String(x.variantCode) : null, variantName: x.variantName ? String(x.variantName) : null, fromLabel: here }))));
    }
    return json({ moved: true, replay, destLabel: dest.label });
  }

  // zip 340: Branch -> Store, started from the STORE side. Only a branch's own till can take stock off its own shelf, so this is a REQUEST:
  //   requestFromBranch: { idemKey, fromClientId, name, code?, unit?, qty, storeItemId? } -> { requested }   (kind BRANCH_REQUEST, status REQUESTED)
  //   pendingRequests:   {} -> { requests: [...] }       requests other branches made TO THIS branch
  //   fulfilRequest:     { movementId, qty? } -> { moved, qty, items }   this branch's till sends the stock into the Store (it takes the quantity
  //                      off its own stock after this answers, exactly like depositFromBranch). Idempotent: a second press / retry adds nothing.
  //   declineRequest:    { movementId } -> { ok }        this branch says no (or the asking branch withdraws the request)
  // Nothing moves until the asked branch confirms; a request never changes any quantity by itself.
  if (a === 'requestFromBranch') {
    const idem = String(body.idemKey || '').slice(0, 80);
    if (!idem) return json({ error: 'Missing request key.' }, 400);
    const qty = NUM(body.qty), name = String(body.name || '').trim().slice(0, 160);
    if (!name || !(qty > 0)) return json({ error: 'Choose the item and enter how many to ask for.' }, 400);
    const from = await destInfo(env, g, record, String(body.fromClientId || ''), getLicense);
    if (!from || from.id === record.id) return json({ error: 'Choose another branch of this business.' }, 400);
    const prev = await db.prepare(`SELECT movement_id FROM store_movements WHERE group_id = ? AND idem_key = ?`).bind(g, `${idem}:0`).first();
    if (!prev) {
      const here = record.businessName || record.label || record.name || record.id;
      await db.prepare(`INSERT INTO store_movements (group_id, movement_id, kind, item_id, item_name, unit, qty, source_client_id, dest_client_id, dest_label, status, actor, at, idem_key, detail, snapshot)
        VALUES (?, ?, 'BRANCH_REQUEST', ?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?, ?)`)
        .bind(g, 'q-' + randomToken(10), body.storeItemId ? String(body.storeItemId) : null, name, String(body.unit || 'pcs'), qty, record.id, from.id, from.label, actor, now, `${idem}:0`, `requested by ${here}`,
          JSON.stringify({ code: body.code ? String(body.code) : null, price: NUM(body.price), wholesaleSellingPrice: NUM(body.wholesaleSellingPrice), wholesalePrice: NUM(body.wholesalePrice) })).run();
    }
    return json({ requested: true, replay: !!prev, fromLabel: from.label });
  }

  if (a === 'pendingRequests') {
    const r = await db.prepare(`SELECT * FROM store_movements WHERE group_id = ? AND kind = 'BRANCH_REQUEST' AND status = 'REQUESTED' AND dest_client_id = ? ORDER BY at LIMIT 50`).bind(g, record.id).all();
    return json({ requests: (r.results || []).map((m) => { const sn = m.snapshot ? JSON.parse(m.snapshot) : {}; return { movementId: m.movement_id, storeItemId: m.item_id, code: sn.code || null, name: m.item_name, unit: m.unit, qty: m.qty, price: sn.price || 0, wholesaleSellingPrice: sn.wholesaleSellingPrice || 0, wholesalePrice: sn.wholesalePrice || 0, note: m.detail, at: iso(m.at), by: m.actor || null }; }) });
  }

  if (a === 'fulfilRequest') {
    const id = String(body.movementId || '');
    const m = await db.prepare(`SELECT * FROM store_movements WHERE group_id = ? AND movement_id = ? AND kind = 'BRANCH_REQUEST' AND dest_client_id = ?`).bind(g, id, record.id).first();
    if (!m) return json({ error: 'That request was not found (or it was not made to this branch).' }, 404);
    if (m.status === 'FULFILLED') return json({ items: await items(db, g), moved: true, replay: true, qty: NUM(m.qty_after) || NUM(m.qty) });
    if (m.status !== 'REQUESTED') return json({ error: `This request is already ${String(m.status).toLowerCase()}.`, status: m.status }, 409);
    const sn = m.snapshot ? JSON.parse(m.snapshot) : {};
    const qty = Math.min(NUM(m.qty), body.qty !== undefined && NUM(body.qty) > 0 ? NUM(body.qty) : NUM(m.qty));
    if (!(qty > 0)) return json({ error: 'Enter how many to send.' }, 400);
    const here = record.businessName || record.label || record.name || record.id;
    const line = { name: m.item_name, unit: m.unit, qty, code: sn.code, price: sn.price, wholesaleSellingPrice: sn.wholesaleSellingPrice, wholesalePrice: sn.wholesalePrice };
    const seen = new Map();
    const st = [
      // the request is closed ONLY if it is still open - a second press changes nothing, and the stock statements after it are tied to that change
      db.prepare(`UPDATE store_movements SET status = 'FULFILLED', received_at = ?, qty_after = ? WHERE group_id = ? AND movement_id = ? AND status = 'REQUESTED'`).bind(now, qty, g, id),
      ...addStatements(db, g, line, actor, `Moved in from ${here} (asked for by ${m.detail || 'another branch'})`, { kind: 'TRANSFER_IN', idem: `req:${id}`, source: record.id }, await findStoreTarget(db, g, line, seen), seen),
    ];
    try { await db.batch(st); } catch (e) { return json({ error: 'The store could not take that right now - nothing was moved. Try again.' }, 409); }
    return json({ items: await items(db, g), moved: true, qty });
  }

  if (a === 'declineRequest') {
    const id = String(body.movementId || '');
    const r = await db.prepare(`UPDATE store_movements SET status = 'DECLINED', received_at = ? WHERE group_id = ? AND movement_id = ? AND kind = 'BRANCH_REQUEST' AND status = 'REQUESTED' AND (dest_client_id = ? OR source_client_id = ?)`).bind(now, g, id, record.id, record.id).run();
    return json({ ok: true, declined: !!(r && r.meta && r.meta.changes) });
  }

  // zip 293: a sale of store stock at the sales counter. Log-only (the stock already left the store through removeFromStore); one row per
  // line, idempotent on saleId so a retried post never doubles the history.
  if (a === 'logSale') {
    const saleId = String(body.saleId || '').slice(0, 60);
    const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 60);
    if (!saleId || !lines.length) return json({ error: 'Nothing to log.' }, 400);
    const st = [];
    lines.forEach((l, i) => {
      const qty = NUM(l.qty);
      if (qty <= 0) return;
      const detail = `Sold ${qty} ${l.unit || 'pcs'}${NUM(l.amount) ? ' for KES ' + NUM(l.amount).toFixed(2) : ''} at the sales counter${body.receipt ? ' — receipt ' + String(body.receipt).slice(0, 40) : ''}`;
      st.push(db.prepare(`INSERT OR IGNORE INTO store_movements (group_id, movement_id, kind, item_id, item_name, unit, qty, status, actor, at, idem_key, detail)
        VALUES (?, ?, 'SALE', ?, ?, ?, ?, 'DONE', ?, ?, ?, ?)`)
        .bind(g, 's-' + randomToken(10), l.storeItemId ? String(l.storeItemId) : null, String(l.name || 'Item').slice(0, 120), l.unit || 'pcs', qty, actor, now, `sale:${saleId}:${i}`, detail));
    });
    if (st.length) await db.batch(st);
    return json({ ok: true });
  }

  if (a === 'pendingTransfers') {
    const r = await db.prepare(`SELECT * FROM store_movements WHERE group_id = ? AND kind IN ('TRANSFER_OUT', 'BRANCH_OUT') AND status = 'IN_TRANSIT' AND dest_client_id = ? ORDER BY at`).bind(g, record.id).all();
    const transfers = (r.results || []).map((m) => { const s = m.snapshot ? JSON.parse(m.snapshot) : {}; return { movementId: m.movement_id, storeItemId: m.item_id, code: s.code || null, name: m.item_name, unit: m.unit, price: s.price || 0, wholesaleSellingPrice: s.wholesaleSellingPrice || 0, wholesalePrice: s.wholesalePrice || 0, qty: m.qty, at: iso(m.at), ...(Array.isArray(s.lots) && s.lots.length ? { lots: s.lots } : {}), ...(m.kind === 'BRANCH_OUT' ? { fromBranch: s.fromLabel || 'another branch', variantCode: s.variantCode || null, variantName: s.variantName || null } : {}) }; });
    return json({ transfers });
  }

  if (a === 'receive') {
    const ids = (Array.isArray(body.movementIds) ? body.movementIds : []).map(String).slice(0, 100);
    if (!ids.length) return json({ error: 'Nothing to confirm.' }, 400);
    await db.batch(ids.map((id) => db.prepare(`UPDATE store_movements SET status = 'RECEIVED', received_at = ? WHERE group_id = ? AND movement_id = ? AND kind IN ('TRANSFER_OUT', 'BRANCH_OUT') AND status = 'IN_TRANSIT' AND dest_client_id = ?`).bind(now, g, id, record.id)));
    const r = await db.prepare(`SELECT movement_id, status FROM store_movements WHERE group_id = ? AND movement_id IN (${ids.map(() => '?').join(',')})`).bind(g, ...ids).all();
    return json({ ok: true, received: (r.results || []).filter((x) => x.status === 'RECEIVED').map((x) => x.movement_id) });
  }

  if (a === 'cancelTransfer') {
    const id = String(body.movementId || '');
    const m = await db.prepare(`SELECT * FROM store_movements WHERE group_id = ? AND movement_id = ? AND kind = 'TRANSFER_OUT'`).bind(g, id).first();
    if (!m) return json({ error: 'Transfer not found.' }, 404);
    if (m.status !== 'IN_TRANSIT') return json({ error: `This transfer is already ${String(m.status).toLowerCase()}.`, status: m.status }, 409);
    let snapLots = []; try { const sn = m.snapshot ? JSON.parse(m.snapshot) : {}; snapLots = Array.isArray(sn.lots) ? sn.lots : []; } catch (e) { snapLots = []; }
    const mark = 'Cancelled in transit — stock returned to the store #' + randomToken(8);
    await db.batch([
      db.prepare(`UPDATE store_movements SET status = 'CANCELLED', received_at = ?, detail = ? WHERE group_id = ? AND movement_id = ? AND status = 'IN_TRANSIT'`).bind(now, mark, g, id),
      db.prepare(`UPDATE store_items SET qty = qty + ?, updated_at = ? WHERE group_id = ? AND item_id = ? AND changes() = 1`).bind(m.qty, now, g, m.item_id),
      // zip 336: its batches go back too - only when THIS call is the one that cancelled it (status CANCELLED stamped with this very time)
      ...snapLots.filter((l) => l && l.id && NUM(l.q) > 0).map((l) => db.prepare(`UPDATE store_lots SET qty = qty + ?, updated_at = ? WHERE group_id = ? AND item_id = ? AND lot_id = ?
        AND EXISTS (SELECT 1 FROM store_movements WHERE group_id = ? AND movement_id = ? AND status = 'CANCELLED' AND detail = ?)`).bind(NUM(l.q), now, g, m.item_id, String(l.id), g, id, mark)),
    ]);
    return json({ items: await items(db, g) });
  }

  // zip 336: a store line that had no code takes the code of the inventory item it was matched to (by name, on the till), so the next transfer
  // matches by code. Only a line with NO code, and only a code no other store line uses.
  if (a === 'linkCode') {
    const id = String(body.storeItemId || ''), code = String(body.code || '').trim().slice(0, 80);
    if (!id || !code) return json({ error: 'Nothing to link.' }, 400);
    const clash = await db.prepare(`SELECT 1 x FROM store_items WHERE group_id = ? AND archived = 0 AND code IS NOT NULL AND lower(code) = lower(?)`).bind(g, code).first();
    if (clash) return json({ ok: false, reason: 'code in use' });
    try {
      const r = await db.prepare(`UPDATE store_items SET code = ?, updated_at = ? WHERE group_id = ? AND item_id = ? AND archived = 0 AND code IS NULL`).bind(code, now, g, id).run();
      return json({ ok: true, linked: !!(r && r.meta && r.meta.changes) });
    } catch (e) { return json({ ok: false, reason: 'clash' }); }
  }

  // zip 336: the Store check - read-only. Lines that look like the same product, transfers stuck in transit, batches that do not add up to the
  // line's quantity, and lines whose quantity is not what their own history says.
  if (a === 'reconcile') {
    const all = (await db.prepare(`SELECT * FROM store_items WHERE group_id = ? AND archived = 0`).bind(g).all()).results || [];
    const byName = new Map();
    all.forEach((r) => { const k = String(r.name).trim().toLowerCase().replace(/\s+/g, ' ') + '|' + String(r.unit || 'pcs').toLowerCase(); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(r); });
    const duplicates = [...byName.values()].filter((l) => l.length > 1).map((l) => l.map(rowToItem));
    const stuck = ((await db.prepare(`SELECT * FROM store_movements WHERE group_id = ? AND kind IN ('TRANSFER_OUT','BRANCH_OUT') AND status = 'IN_TRANSIT' AND at < ? ORDER BY at`).bind(g, now - 2 * 86400000).all()).results || [])
      .map((m) => ({ movementId: m.movement_id, name: m.item_name, qty: m.qty, unit: m.unit, to: m.dest_label, at: iso(m.at) }));
    const lotSum = new Map();
    ((await db.prepare(`SELECT item_id, SUM(qty) q FROM store_lots WHERE group_id = ? GROUP BY item_id`).bind(g).all()).results || []).forEach((r) => lotSum.set(r.item_id, NUM(r.q)));
    const lotGaps = all.filter((r) => lotSum.has(r.item_id) && Math.abs(lotSum.get(r.item_id) - NUM(r.qty)) > 0.0005)
      .map((r) => ({ storeItemId: r.item_id, name: r.name, qty: r.qty, inBatches: lotSum.get(r.item_id), note: lotSum.get(r.item_id) > r.qty ? 'batches hold MORE than the line - check' : 'part of the stock has no batch on file (from before batches were kept)' }));
    const mismatched = [];
    for (const r of all) {
      const last = await db.prepare(`SELECT * FROM store_movements WHERE group_id = ? AND item_id = ? AND qty_after IS NOT NULL ORDER BY at DESC, rowid DESC LIMIT 1`).bind(g, r.item_id).first();
      if (!last) continue;
      const expect = last.status === 'CANCELLED' ? NUM(last.qty_before) : NUM(last.qty_after);
      if (Math.abs(expect - NUM(r.qty)) > 0.0005) mismatched.push({ storeItemId: r.item_id, name: r.name, qty: r.qty, historySays: expect, lastChange: iso(last.at), kind: last.kind });
    }
    const negative = all.filter((r) => NUM(r.qty) < 0).map(rowToItem);
    return json({ ok: true, at: iso(now), lines: all.length, duplicates, stuck, lotGaps, mismatched, negative });
  }

  // zip 336: merge two store lines that are the same product (found by the Store check). A manager action: the Admin password or a manager PIN is
  // checked on the server. Without confirm it only answers with what WOULD happen. The quantity and batches move to the kept line as two movements
  // (MERGE_OUT / MERGE_IN) and the other line is archived - nothing is deleted, and the idempotency key makes a retry a no-op.
  if (a === 'mergeItems') {
    const fromId = String(body.fromId || ''), intoId = String(body.intoId || '');
    if (!fromId || !intoId || fromId === intoId) return json({ error: 'Pick two different store lines.' }, 400);
    const from = await db.prepare(`SELECT * FROM store_items WHERE group_id = ? AND item_id = ? AND archived = 0`).bind(g, fromId).first();
    const into = await db.prepare(`SELECT * FROM store_items WHERE group_id = ? AND item_id = ? AND archived = 0`).bind(g, intoId).first();
    if (!from || !into) return json({ error: 'One of these lines is no longer in the store.' }, 404);
    if (String(from.unit || 'pcs').toLowerCase() !== String(into.unit || 'pcs').toLowerCase()) return json({ error: `These are counted in different units (${from.unit} / ${into.unit}) - they cannot be merged.` }, 400);
    const preview = { from: rowToItem(from), into: rowToItem(into), after: { qty: Math.round((NUM(into.qty) + NUM(from.qty)) * 1000) / 1000 } };
    if (!body.confirm) return json({ ok: true, preview });
    const reason = String(body.reason || '').trim().slice(0, 200);
    if (reason.length < 3) return json({ error: 'Say why these are the same product.' }, 400);
    const proof = await requirePayProof(ctx.request, env, record.id, ctx.cors || {});
    if (proof.denied) return proof.denied;
    const idem = String(body.idemKey || '').slice(0, 80) || ('merge:' + fromId + ':' + intoId);
    const done = await db.prepare(`SELECT 1 x FROM store_movements WHERE group_id = ? AND idem_key = ?`).bind(g, idem + ':out').first();
    if (done) return json({ ok: true, replay: true, items: await items(db, g) });
    const who = (actor || proof.who.name) + ' (' + proof.who.kind + ')';
    const st = [
      db.prepare(`INSERT INTO store_movements (group_id, movement_id, kind, item_id, item_name, unit, qty, qty_before, qty_after, status, actor, at, idem_key, detail) VALUES (?,?,'MERGE_OUT',?,?,?,?,?,0,'DONE',?,?,?,?)`)
        .bind(g, 'm-' + randomToken(10), from.item_id, from.name, from.unit, NUM(from.qty), NUM(from.qty), who, now, idem + ':out', `Merged into "${into.name}"${into.code ? ' (' + into.code + ')' : ''}: ${reason}`),
      db.prepare(`INSERT INTO store_movements (group_id, movement_id, kind, item_id, item_name, unit, qty, qty_before, qty_after, status, actor, at, idem_key, detail) VALUES (?,?,'MERGE_IN',?,?,?,?,?,?,'DONE',?,?,?,?)`)
        .bind(g, 'm-' + randomToken(10), into.item_id, into.name, into.unit, NUM(from.qty), NUM(into.qty), preview.after.qty, who, now, idem + ':in', `From "${from.name}"${from.code ? ' (' + from.code + ')' : ''}: ${reason}`),
      db.prepare(`UPDATE store_items SET qty = qty + ?, updated_at = ? WHERE group_id = ? AND item_id = ?`).bind(NUM(from.qty), now, g, into.item_id),
      db.prepare(`UPDATE store_items SET qty = 0, archived = 1, updated_at = ? WHERE group_id = ? AND item_id = ?`).bind(now, g, from.item_id),
      db.prepare(`INSERT INTO store_lots (group_id, item_id, lot_id, batch, expiry, cost, received_at, supplier, qty, updated_at)
        SELECT group_id, ?, lot_id, batch, expiry, cost, received_at, supplier, qty, ? FROM store_lots WHERE group_id = ? AND item_id = ? AND qty > 0
        ON CONFLICT (group_id, item_id, lot_id) DO UPDATE SET qty = qty + excluded.qty, updated_at = excluded.updated_at`).bind(into.item_id, now, g, from.item_id),
      db.prepare(`UPDATE store_lots SET qty = 0, updated_at = ? WHERE group_id = ? AND item_id = ?`).bind(now, g, from.item_id),
    ];
    try { await db.batch(st); } catch (e) { return json({ error: 'The store changed while merging - nothing was merged. Refresh and try again.' }, 409); }
    return json({ ok: true, items: await items(db, g) });
  }

  if (a === 'deleteItem') {
    if (!body.storeItemId) return json({ error: 'No item specified.' }, 400);
    await db.batch([
      db.prepare(`INSERT INTO store_movements (group_id, movement_id, kind, item_id, item_name, unit, qty, qty_before, qty_after, status, actor, at, detail)
        SELECT group_id, ?, 'ARCHIVE', item_id, name, unit, 0, qty, qty, 'DONE', ?, ?, 'Removed from the store list (history kept; had ' || qty || ' ' || unit || ')' FROM store_items WHERE group_id = ? AND item_id = ? AND archived = 0`)
        .bind('m-' + randomToken(10), actor, now, g, body.storeItemId),
      db.prepare(`UPDATE store_items SET archived = 1, updated_at = ? WHERE group_id = ? AND item_id = ?`).bind(now, g, body.storeItemId),
    ]);
    return json({ items: await items(db, g) });
  }

  return json({ error: 'Unknown action.' }, 400);
}
