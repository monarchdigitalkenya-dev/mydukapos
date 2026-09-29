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

const NUM = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const iso = (t) => new Date(t).toISOString();

const rowToItem = (r) => ({ id: r.item_id, code: r.code || null, name: r.name, unit: r.unit, price: r.price, wholesaleSellingPrice: r.wholesale_selling_price, wholesalePrice: r.wholesale_price, qty: r.qty });

async function items(db, g) {
  const r = await db.prepare(`SELECT * FROM store_items WHERE group_id = ? AND archived = 0 ORDER BY lower(name)`).bind(g).all();
  return (r.results || []).map(rowToItem);
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

function addStatements(db, g, inc, actor, note) {
  const name = String(inc.name || '').trim();
  if (!name) return [];
  const qty = Math.max(0, NUM(inc.qty));
  const code = String(inc.code || '').trim();
  const m = matchSql(code);
  const key = code || name;
  const now = Date.now();
  const opt = (v) => { if (v === undefined || v === '') return null; const n = parseFloat(v); return n ? n : null; };
  const price = opt(inc.price), wss = opt(inc.wholesaleSellingPrice), wp = opt(inc.wholesalePrice);
  const unit = inc.unit ? String(inc.unit) : null;
  const newId = randomToken(10);
  return [
    // the movement records the level BEFORE this add (NULL for a brand-new item)
    db.prepare(`INSERT INTO store_movements (group_id, movement_id, kind, item_id, item_name, unit, qty, qty_before, qty_after, status, actor, at, detail)
      SELECT ?, ?, 'ADD', item_id, name, unit, ?, qty, qty + ?, 'DONE', ?, ?, ? FROM store_items WHERE ${m.where}`)
      .bind(g, 'm-' + randomToken(10), qty, qty, actor, now, note, g, key),
    db.prepare(`UPDATE store_items SET qty = qty + ?, price = COALESCE(?, price), wholesale_selling_price = COALESCE(?, wholesale_selling_price), wholesale_price = COALESCE(?, wholesale_price), unit = COALESCE(?, unit), updated_at = ? WHERE ${m.where}`)
      .bind(qty, price, wss, wp, unit, now, g, key),
    db.prepare(`INSERT INTO store_items (group_id, item_id, code, name, unit, price, wholesale_selling_price, wholesale_price, qty, archived, created_at, updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,0,?,? WHERE NOT EXISTS (SELECT 1 FROM store_items WHERE ${m.where})`)
      .bind(g, newId, code || null, name, unit || 'pcs', price || 0, wss || 0, wp || 0, qty, now, now, g, key),
    db.prepare(`INSERT INTO store_movements (group_id, movement_id, kind, item_id, item_name, unit, qty, qty_before, qty_after, status, actor, at, detail)
      SELECT ?, ?, 'ADD', ?, ?, ?, ?, NULL, ?, 'DONE', ?, ?, ? WHERE EXISTS (SELECT 1 FROM store_items WHERE group_id = ? AND item_id = ? AND created_at = ?)`)
      .bind(g, 'm-' + randomToken(10), newId, name, unit || 'pcs', qty, qty, actor, now, note, g, newId, now),
  ];
}

async function destInfo(env, groupId, caller, wanted, getLicense) {
  if (!wanted || wanted === caller.id) return { id: caller.id, label: caller.businessName || caller.name || caller.id };
  const d = await getLicense(env, wanted);
  if (!d || (d.branchGroupId || d.id) !== groupId) return null;
  return { id: d.id, label: d.businessName || d.name || d.id };
}

const KIND_ACTION = { ADD: 'add', EDIT: 'edit', QTY: 'qty_change', TRANSFER_OUT: 'withdraw', ARCHIVE: 'delete' };

export async function handleStoreD1(env, db, ctx) {
  const { body, groupId: g, record, getLicense, json } = ctx;
  await ensureLedgerSchema(db);
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
      if (k === 'TRANSFER_OUT') detail = `${m.qty} ${m.unit || 'pcs'} to ${m.dest_label || 'branch'} — ${String(m.status).toLowerCase().replace('_', ' ')}`;
      return { id: m.movement_id, timestamp: iso(m.at), action, itemName: m.item_name, detail, servedBy: m.actor, status: m.status, destination: m.dest_label || null, qtyBefore: m.qty_before, qtyAfter: m.qty_after };
    });
    return json({ log });
  }

  if (a === 'addManual') {
    if (!body.item || !body.item.name) return json({ error: 'Item name is required.' }, 400);
    await db.batch(addStatements(db, g, body.item, actor, `Added manually — ${NUM(body.item.qty)} ${body.item.unit || 'pcs'}`));
    return json({ items: await items(db, g) });
  }

  if (a === 'addFromCsv' || a === 'addFromInventory') {
    if (!Array.isArray(body.items) || !body.items.length) return json({ error: 'No items to add.' }, 400);
    const note = a === 'addFromCsv' ? 'Imported via CSV' : 'Imported from inventory (code/name/price only)';
    const st = [];
    for (const it of body.items) st.push(...addStatements(db, g, it, actor, note));
    // merge duplicates inside one import safely: statements run in order, so a repeat line hits the UPDATE branch
    if (st.length) await db.batch(st);
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
    try {
      await db.batch([
        db.prepare(`UPDATE store_items SET name=?, code=?, unit=?, price=?, wholesale_price=?, wholesale_selling_price=?, updated_at=? WHERE group_id=? AND item_id=?`)
          .bind(set.name, set.code, set.unit, set.price, set.wholesale_price, set.wholesale_selling_price, now, g, it.item_id),
        db.prepare(`INSERT INTO store_movements (group_id, movement_id, kind, item_id, item_name, unit, qty, qty_before, qty_after, status, actor, at, detail) VALUES (?,?,'EDIT',?,?,?,0,?,?,'DONE',?,?,?)`)
          .bind(g, 'm-' + randomToken(10), it.item_id, set.name, set.unit, it.qty, it.qty, actor, now, `Updated: ${Object.keys(f).join(', ')}`),
      ]);
    } catch (e) { return json({ error: 'Another item already uses that name or code.' }, 400); }
    return json({ items: await items(db, g) });
  }

  // Store -> Branch, atomic. `idemKey` makes a retry return the same transfer instead of taking the stock twice.
  if (a === 'removeFromStore') {
    if (!Array.isArray(body.items) || !body.items.length) return json({ error: 'No items selected.' }, 400);
    const dest = await destInfo(env, g, record, body.destClientId, getLicense);
    if (!dest) return json({ error: 'That destination is not in your branch group.' }, 400);
    const idem = body.idemKey ? String(body.idemKey).slice(0, 80) : null;
    const lines = [];
    for (const req of body.items) {
      const qty = NUM(req.qty);
      if (!req.storeItemId || qty <= 0) continue;
      lines.push({ id: String(req.storeItemId), qty });
    }
    if (!lines.length) return json({ error: 'No items selected.' }, 400);
    const shape = (m) => { const s = m.snapshot ? JSON.parse(m.snapshot) : {}; return { movementId: m.movement_id, storeItemId: m.item_id, code: s.code || null, name: m.item_name, unit: m.unit, price: s.price || 0, wholesaleSellingPrice: s.wholesaleSellingPrice || 0, wholesalePrice: s.wholesalePrice || 0, qty: m.qty, status: m.status, destClientId: m.dest_client_id, destLabel: m.dest_label }; };
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
      st.push(db.prepare(`INSERT INTO store_movements (group_id, movement_id, kind, item_id, item_name, unit, qty, qty_before, qty_after, source_client_id, dest_client_id, dest_label, status, actor, at, idem_key, detail, snapshot)
        SELECT group_id, ?, 'TRANSFER_OUT', item_id, name, unit, ?, qty, qty - ?, ?, ?, ?, 'IN_TRANSIT', ?, ?, ?, NULL,
          json_object('code', code, 'price', price, 'wholesaleSellingPrice', wholesale_selling_price, 'wholesalePrice', wholesale_price)
        FROM store_items WHERE group_id = ? AND item_id = ? AND archived = 0`)
        .bind(mid, qty, qty, record.id, dest.id, dest.label, actor, now, idem ? `${idem}:${n++}` : null, g, itemId));
      // CHECK (qty >= 0) makes this statement — and therefore the WHOLE batch — fail if the store holds less than asked
      st.push(db.prepare(`UPDATE store_items SET qty = qty - ?, updated_at = ? WHERE group_id = ? AND item_id = ? AND archived = 0 AND EXISTS (SELECT 1 FROM store_movements WHERE group_id = ? AND movement_id = ?)`)
        .bind(qty, now, g, itemId, g, mid));
    }
    try { await db.batch(st); }
    catch (e) { return json({ error: 'Not enough stock in the store for this withdrawal — nothing was taken. Refresh and try again.', items: await items(db, g) }, 409); }
    const got = await db.prepare(`SELECT * FROM store_movements WHERE group_id = ? AND movement_id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid`).bind(g, ...ids).all();
    const withdrawn = (got.results || []).map(shape);
    if (!withdrawn.length) return json({ error: 'Item not found.', items: await items(db, g) }, 404);
    return json({ items: await items(db, g), withdrawn });
  }

  if (a === 'pendingTransfers') {
    const r = await db.prepare(`SELECT * FROM store_movements WHERE group_id = ? AND kind = 'TRANSFER_OUT' AND status = 'IN_TRANSIT' AND dest_client_id = ? ORDER BY at`).bind(g, record.id).all();
    const transfers = (r.results || []).map((m) => { const s = m.snapshot ? JSON.parse(m.snapshot) : {}; return { movementId: m.movement_id, storeItemId: m.item_id, code: s.code || null, name: m.item_name, unit: m.unit, price: s.price || 0, wholesaleSellingPrice: s.wholesaleSellingPrice || 0, wholesalePrice: s.wholesalePrice || 0, qty: m.qty, at: iso(m.at) }; });
    return json({ transfers });
  }

  if (a === 'receive') {
    const ids = (Array.isArray(body.movementIds) ? body.movementIds : []).map(String).slice(0, 100);
    if (!ids.length) return json({ error: 'Nothing to confirm.' }, 400);
    await db.batch(ids.map((id) => db.prepare(`UPDATE store_movements SET status = 'RECEIVED', received_at = ? WHERE group_id = ? AND movement_id = ? AND kind = 'TRANSFER_OUT' AND status = 'IN_TRANSIT' AND dest_client_id = ?`).bind(now, g, id, record.id)));
    const r = await db.prepare(`SELECT movement_id, status FROM store_movements WHERE group_id = ? AND movement_id IN (${ids.map(() => '?').join(',')})`).bind(g, ...ids).all();
    return json({ ok: true, received: (r.results || []).filter((x) => x.status === 'RECEIVED').map((x) => x.movement_id) });
  }

  if (a === 'cancelTransfer') {
    const id = String(body.movementId || '');
    const m = await db.prepare(`SELECT * FROM store_movements WHERE group_id = ? AND movement_id = ? AND kind = 'TRANSFER_OUT'`).bind(g, id).first();
    if (!m) return json({ error: 'Transfer not found.' }, 404);
    if (m.status !== 'IN_TRANSIT') return json({ error: `This transfer is already ${String(m.status).toLowerCase()}.`, status: m.status }, 409);
    await db.batch([
      db.prepare(`UPDATE store_movements SET status = 'CANCELLED', received_at = ?, detail = 'Cancelled in transit — stock returned to the store' WHERE group_id = ? AND movement_id = ? AND status = 'IN_TRANSIT'`).bind(now, g, id),
      db.prepare(`UPDATE store_items SET qty = qty + ?, updated_at = ? WHERE group_id = ? AND item_id = ? AND changes() = 1`).bind(m.qty, now, g, m.item_id),
    ]);
    return json({ items: await items(db, g) });
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
