// functions/api/_lpg.js — LPG / gas retail (zip 216). Turns the `lpg` note a till puts on a stock movement or a sale line into idempotent D1 statements
// for the tables in _lpg-schema.js. Called from buildGroups (_ledger.js), so these statements ride in the SAME atomic record group as the movement / sale
// itself: the structured gas tables can never disagree with the ledger, and a resend (same ids) changes nothing.
const STATES = new Set(['full', 'empty', 'away', 'damaged']);
const MODES = new Set(['full', 'exchange', 'cylinder', 'set']);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(num(n) * 100) / 100;
const r3 = (n) => Math.round(num(n) * 1000) / 1000;
const str = (v, n = 120) => (v == null || v === '' ? null : String(v).slice(0, n));

// One stock movement (an entry of stockMovementLog) that carries an `lpg` note -> the movement row (+ the stock-take row when it is part of a count).
export function lpgMovementStatements(db, clientId, m, ctx) {
  const out = [];
  const g = m && m.lpg;
  if (!g || typeof g !== 'object' || m.id == null || m._deleted) return out;
  const state = String(g.state || 'full');
  const size = str(g.size || m.code, 60);
  if (!STATES.has(state) || !size) return out;
  const d = g.d !== undefined && g.d !== null ? num(g.d) : num(m.delta);
  const kind = str(g.k || 'adjust', 30);
  const actor = str(m.by || m.user, 60);
  out.push(db.prepare(`INSERT OR IGNORE INTO lpg_movements (client_id, mv_id, ts, business_date, app, size_code, label, brand, state, kind, qty, before_qty, after_qty, reason, line_ref, reversal, actor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(clientId, String(m.id), ctx.ts, ctx.date, ctx.app, size, str(g.label || m.name, 120), str(g.brand, 60), state, kind, r3(d),
      g.before == null ? null : r3(g.before), g.after == null ? null : r3(g.after), str(m.reason, 160), str(g.ref, 80), g.rev || m.reverses ? 1 : 0, actor));
  const st = g.st;
  if (st && typeof st === 'object' && st.id) {
    const status = ['pending', 'approved', 'rejected'].includes(st.status) ? st.status : 'pending';
    const counted = r3(st.counted), expected = r3(st.expected);
    // a new row is always written as submitted ('pending'); the decision is a conditional move pending -> approved / rejected (the trigger refuses anything else)
    out.push(db.prepare(`INSERT OR IGNORE INTO lpg_stocktakes (client_id, st_id, size_code, state, label, expected, counted, variance, status, note, counted_by, counted_at, decided_by, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL)`)
      .bind(clientId, String(st.id), size, state, str(g.label || m.name, 120), expected, counted, r3(counted - expected), str(st.note, 200), str(st.by || actor, 60), ctx.ts));
    if (status !== 'pending') {
      out.push(db.prepare(`UPDATE lpg_stocktakes SET status = ?, decided_by = ?, decided_at = ? WHERE client_id = ? AND st_id = ? AND size_code = ? AND state = ? AND status = 'pending'`)
        .bind(status, str(st.decidedBy || actor, 60), ctx.ts, clientId, String(st.id), size, state));
    }
  }
  return out;
}

// The gas lines of one sale (items carrying an `lpg` note) -> lpg_sale_lines. Same version guard as ledger_sale_items: only the sale's current version writes.
export function lpgSaleStatements(db, clientId, saleId, items, ctx) {
  const out = [];
  (Array.isArray(items) ? items : []).forEach((it, i) => {
    const g = it && it.lpg;
    if (!g || typeof g !== 'object' || !MODES.has(String(g.mode))) return;
    const qty = num(it.qty), price = num(it.price);
    const unitCost = g.cost != null ? num(g.cost) : num(it.wholesalePrice);
    const empty = g.emptyState && STATES.has(String(g.emptyState)) ? String(g.emptyState) : null;
    out.push(db.prepare(`INSERT INTO lpg_sale_lines (client_id, sale_id, line_no, size_code, label, brand, mode, qty, price, cost, margin, empty_brand, empty_state, bundle_id, components, line_ref, ts, business_date, app, version)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ledger_sales WHERE client_id = ? AND sale_id = ? AND version = ?)
      ON CONFLICT (client_id, sale_id, line_no) DO UPDATE SET size_code = excluded.size_code, label = excluded.label, brand = excluded.brand, mode = excluded.mode, qty = excluded.qty, price = excluded.price,
        cost = excluded.cost, margin = excluded.margin, empty_brand = excluded.empty_brand, empty_state = excluded.empty_state, bundle_id = excluded.bundle_id, components = excluded.components,
        line_ref = excluded.line_ref, version = excluded.version`)
      .bind(clientId, saleId, i, str(g.size || it.code, 60) || '?', str(g.label || it.name, 120), str(g.brand, 60), String(g.mode), qty, price, r2(unitCost), r2((price - unitCost) * qty),
        str(g.emptyBrand, 60), empty, str(g.bundle, 60), Array.isArray(g.components) ? JSON.stringify(g.components).slice(0, 1500) : null, str(g.lid, 80), ctx.ts, ctx.date, ctx.app, ctx.version,
        clientId, saleId, ctx.version));
  });
  // lines that are no longer gas lines of this sale version (an edited sale) are removed, once this version is current
  const keep = (Array.isArray(items) ? items : []).map((it, i) => (it && it.lpg && MODES.has(String(it.lpg.mode)) ? i : -1)).filter((i) => i >= 0);
  out.push(db.prepare(`DELETE FROM lpg_sale_lines WHERE client_id = ? AND sale_id = ? AND line_no NOT IN (${(keep.length ? keep : [-1]).map(() => '?').join(',')}) AND EXISTS (SELECT 1 FROM ledger_sales WHERE client_id = ? AND sale_id = ? AND version = ?)`)
    .bind(clientId, saleId, ...(keep.length ? keep : [-1]), clientId, saleId, ctx.version));
  return out;
}
