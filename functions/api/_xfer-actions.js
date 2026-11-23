// functions/api/_xfer-actions.js - shared helper, NOT a route (zip 310). The Business HQ actions for stock locations, internal moves and transfers
// between branches. Called by org.js AFTER it has authenticated the HQ user (ctx.who, ctx.can, ctx.inScope), so every rule here is a server rule.
//
// Permissions: inventory.manage (locations, counts, moves, creating / dispatching / receiving transfers), transfers.approve (approve, reject,
// resolve discrepancies). The owner has both. Scope: an administrator only acts at branches in their list - creating a transfer needs one end in
// scope, dispatching needs the SOURCE, receiving the DESTINATION. Independent approval (default on): an administrator cannot approve a transfer
// they requested.
//
// Lifecycle: pending (needs approval) -> approved -> dispatching -> in_transit -> partial / discrepancy -> completed;  pending|approved -> rejected
// | cancelled. Stock leaves the source at DISPATCH (it is then in transit, never counted at the destination) and reaches the destination at RECEIPT
// (only what was actually received). Every stock step has a fixed movement id (transfer + line + step), so a repeated or concurrent request can
// never take or add stock twice; the status changes are conditional updates ("only if it is still approved"), so two people pressing Dispatch at
// once get one dispatch.
import * as S from './_stock.js';
import { floorItems } from './_stock.js';
import { audit } from './_org.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : 0; };
const ok = (x) => ({ ok: true, ...x });

export async function handle(ctx, a, body) {
  const { env, db, groupId, who, can, inScope, reply, deny } = ctx;
  await S.ensureStockSchema(db);

  /* ---------------- settings ---------------- */
  if (a === 'inv.settings') {
    if (body.save) {
      if (who.kind !== 'owner') return deny('Only the owner can change the approval rules.');
      const s = await S.saveSettings(db, groupId, body.save);
      await audit(db, groupId, who.actor, 'settings.transfers', 'business', null, s, body.reason);
      return reply(ok({ settings: s }));
    }
    return reply(ok({ settings: await S.getSettings(db, groupId) }));
  }

  /* ---------------- locations ---------------- */
  if (a === 'inv.locations') {
    const ids = ctx.memberIds.filter(inScope);
    const locs = await S.locations(db, groupId, ids);
    const totals = new Map((await db.prepare(`SELECT location_id, COUNT(*) AS items, SUM(qty) AS qty FROM inv_loc_stock WHERE group_id = ? AND qty > 0 GROUP BY location_id`).bind(groupId).all()).results.map((r) => [r.location_id, r]));
    return reply(ok({ locations: locs.map((l) => ({ ...l, items: (totals.get(l.location_id) || {}).items || 0, qty: (totals.get(l.location_id) || {}).qty || 0 })) }));
  }
  if (a === 'inv.location.create') {
    if (!can('inventory.manage')) return deny();
    const cid = String(body.clientId || ''); if (!inScope(cid)) return deny('That branch is not one you manage.');
    const r = await S.createLocation(db, groupId, cid, body.name, body.kind);
    if (r.ok) await audit(db, groupId, who.actor, 'location.create', 'branch:' + cid, null, { name: r.location.name, kind: r.location.kind }, body.reason);
    return reply(r, r.ok ? 200 : 400);
  }
  if (a === 'inv.stock') {
    const cid = String(body.clientId || ''), loc = String(body.locId || 'floor'); if (!inScope(cid)) return deny('That branch is not one you manage.');
    if (loc === 'floor') {
      let items = []; try { items = await floorItems(env, cid); } catch (e) { return reply({ error: 'That branch’s database did not answer.' }, 503); }
      return reply(ok({ items: items.map((i) => ({ code: String(i.code), name: i.name || String(i.code), unit: i.unit || 'pcs', qty: num(i.qty), price: num(i.price), cost: num(i.wholesalePrice), batches: Array.isArray(i.batches) ? i.batches.length : 0, serials: !!(i.serialTracked || i.trackSerials) })) }));
    }
    const l = await S.location(db, groupId, loc); if (!l || l.client_id !== cid) return reply({ error: 'Location not found.' }, 404);
    return reply(ok({ items: (await S.locStock(db, groupId, loc)).map((r) => ({ code: r.code, name: r.name, unit: r.unit, qty: num(r.qty), cost: num(r.unit_cost) })) }));
  }
  if (a === 'inv.receive' || a === 'inv.adjust') {
    // stock arriving at a location (opening balance, goods delivered to the store) or a count of a location; the shop floor is counted in the till
    if (!can('inventory.manage')) return deny();
    const cid = String(body.clientId || ''), loc = String(body.locId || ''); if (!inScope(cid)) return deny('That branch is not one you manage.');
    const l = await S.location(db, groupId, loc); if (!l || l.client_id !== cid) return reply({ error: 'Choose one of the branch’s locations (the shop floor is counted in the till’s Stock Take).' }, 400);
    if (!String(body.reason || '').trim()) return reply({ error: 'Give a reason (e.g. opening balance, delivery from supplier, monthly count).' }, 400);
    const key = String(body.key || '').replace(/[^\w-]/g, '').slice(0, 40) || ('k' + Date.now());
    const cur = new Map((await S.locStock(db, groupId, loc)).map((r) => [r.code, r]));
    const floor = new Map((await floorItems(env, cid).catch(() => [])).map((i) => [String(i.code), i]));
    const lines = [];
    for (const x of (Array.isArray(body.lines) ? body.lines : []).slice(0, 300)) {
      const code = String(x.code || '').trim(); if (!code) continue;
      const f = floor.get(code), c = cur.get(code);
      const q = num(x.qty);
      const delta = a === 'inv.adjust' ? num(q - (c ? c.qty : 0)) : q;
      if (a === 'inv.receive' && !(q > 0)) return reply({ error: 'Quantities must be more than 0.' }, 400);
      if (a === 'inv.adjust' && q < 0) return reply({ error: 'A count cannot be below 0.' }, 400);
      if (!delta) continue;
      lines.push({ mid: `${a === 'inv.adjust' ? 'adj' : 'rcv'}:${loc}:${code}:${key}`, code, name: (f && f.name) || (c && c.name) || x.name || code, unit: (f && f.unit) || (c && c.unit) || x.unit || 'pcs', unit_cost: num((f && f.wholesalePrice) || (c && c.unit_cost) || x.unit_cost), qty: delta });
    }
    if (!lines.length) return a === 'inv.adjust' ? reply(ok({ unchanged: true })) : reply({ error: 'Nothing to change.' }, 400);
    const r = await S.locApply(db, groupId, cid, loc, lines, { kind: a === 'inv.adjust' ? 'adjust' : 'receive', actor: who.actor, reason: String(body.reason).slice(0, 200) });
    if (!r.ok) return reply({ error: 'Not enough stock at that location for this change.' }, 409);
    await audit(db, groupId, who.actor, a === 'inv.adjust' ? 'location.count' : 'location.receive', 'branch:' + cid, null, { location: l.name, lines: lines.map((x) => ({ code: x.code, qty: x.qty })) }, body.reason);
    return reply(ok({ repeated: !!r.repeated }));
  }
  if (a === 'inv.items') {
    // zip 311: ONE list per branch - every item with its quantity on the shop floor and in each store, so stock is moved right from the item.
    // A branch without a store gets its "Main store" here (once), for people who manage stock.
    const cid = String(body.clientId || ''); if (!inScope(cid)) return deny('That branch is not one you manage.');
    let locs = (await S.locations(db, groupId, [cid])).filter((l) => l.status === 'active');
    if (!locs.length && can('inventory.manage')) { await S.createLocation(db, groupId, cid, 'Main store', 'store'); locs = (await S.locations(db, groupId, [cid])).filter((l) => l.status === 'active'); }
    let fl = [], level = null, floorOk = true;
    try { const { readState } = await import('./_state-store.js'); const st = (await readState(env, 'pos-data:state:' + cid, {})) || {}; level = st.lowStockThreshold; fl = (Array.isArray(st.inventory) ? st.inventory : []).filter((i) => i && !i._deleted && !i.removed && !i.archived && i.code != null && i.type !== 'service'); } catch (e) { floorOk = false; }
    const items = new Map();
    for (const i of fl) {
      const own = [i.reorderLevel, i.minStock].map(Number).filter((x) => Number.isFinite(x) && x > 0);
      const lv = own.length ? Math.max(...own) : (Number.isFinite(Number(level)) && Number(level) >= 0 ? Number(level) : 3);
      items.set(String(i.code), { code: String(i.code), name: i.name || String(i.code), unit: i.unit || 'pcs', price: num(i.price), cost: num(i.wholesalePrice), floor: num(i.qty), at: {}, level: lv, batches: Array.isArray(i.batches) ? i.batches.length : 0 });
    }
    for (const l of locs) for (const r of await S.locStock(db, groupId, l.location_id)) {
      const it = items.get(r.code) || { code: r.code, name: r.name, unit: r.unit, price: 0, cost: num(r.unit_cost), floor: null, at: {}, level: 0 };
      it.at[l.location_id] = num(r.qty); items.set(r.code, it);
    }
    const list = [...items.values()].map((i) => ({ ...i, low: i.floor != null && i.floor <= i.level })).sort((a2, b2) => String(a2.name).localeCompare(String(b2.name)));
    return reply(ok({ locations: locs.map((l) => ({ location_id: l.location_id, name: l.name, kind: l.kind })), items: list, floorOk }));
  }
  if (a === 'inv.movements') {
    const cid = body.clientId ? String(body.clientId) : null;
    if (cid && !inScope(cid)) return deny('That branch is not one you manage.');
    let rows = await S.movements(db, groupId, { clientId: cid, locId: body.locId ? String(body.locId) : null, limit: Number(body.limit) || 300 });
    if (!cid) rows = rows.filter((m) => inScope(m.client_id));
    return reply(ok({ movements: rows }));
  }

  /* ---------------- transfers ---------------- */
  if (a === 'xfer.list') {
    const list = await S.listXfers(db, groupId, { status: body.status || undefined, clientIds: ctx.memberIds.filter(inScope) });
    const lines = list.length ? (await db.prepare(`SELECT xfer_id, COUNT(*) AS n, SUM(qty_req) AS req, SUM(qty_disp) AS disp, SUM(qty_recv) AS recv, SUM(qty_damaged + qty_missing) AS short FROM xfer_line WHERE group_id = ? GROUP BY xfer_id`).bind(groupId).all()).results : [];
    const by = new Map(lines.map((l) => [l.xfer_id, l]));
    return reply(ok({ transfers: list.map((x) => ({ ...x, lines: by.get(x.xfer_id) || { n: 0 } })) }));
  }
  if (a === 'xfer.get') {
    const x = await S.xferRow(db, groupId, String(body.xferId || '')); if (!x) return reply({ error: 'Transfer not found.' }, 404);
    if (!inScope(x.from_client) && !inScope(x.to_client)) return deny();
    const lines = (await S.xferLines(db, groupId, x.xfer_id)).map((l) => ({ ...l, in_transit: S.inTransitOf(l) }));
    return reply(ok({ transfer: x, lines, events: (await S.xferEvents(db, groupId, x.xfer_id)).map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null })) }));
  }
  if (a === 'xfer.create' || a === 'inv.move') {
    if (!can('inventory.manage')) return deny();
    const internal = a === 'inv.move' || String(body.fromClient) === String(body.toClient);
    const fromC = String(body.fromClient || body.clientId || ''), toC = internal ? fromC : String(body.toClient || '');
    const fromL = String(body.fromLoc || 'floor'), toL = String(body.toLoc || 'floor');
    if (!ctx.memberIds.includes(fromC) || !ctx.memberIds.includes(toC)) return reply({ error: 'Choose branches of this business.' }, 400);
    if (internal ? !inScope(fromC) : !(inScope(fromC) || inScope(toC))) return deny('That branch is not one you manage.');
    if (internal && fromL === toL) return reply({ error: 'Choose two different locations.' }, 400);
    for (const [c, l] of [[fromC, fromL], [toC, toL]]) if (l !== 'floor') { const row = await S.location(db, groupId, l); if (!row || row.client_id !== c || row.status !== 'active') return reply({ error: 'One of the locations does not belong to that branch.' }, 400); }
    // the lines, as the SOURCE knows them (name, unit, cost, price); never more than one line per item
    const src = fromL === 'floor' ? new Map((await floorItems(env, fromC)).map((i) => [String(i.code), { name: i.name, unit: i.unit || 'pcs', qty: num(i.qty), cost: num(i.wholesalePrice), price: num(i.price), batches: Array.isArray(i.batches) && i.batches.length }]))
      : await (async () => {
        // a store keeps no selling price: take it from the branch's till item, so an item that reaches a shop floor for the first time is never priced at 0
        const till = new Map((await floorItems(env, fromC).catch(() => [])).map((i) => [String(i.code), i]));
        return new Map((await S.locStock(db, groupId, fromL)).map((r) => [r.code, { name: r.name, unit: r.unit, qty: num(r.qty), cost: num(r.unit_cost), price: num((till.get(r.code) || {}).price) }]));
      })();
    const seen = new Set(), lines = [];
    for (const x of (Array.isArray(body.lines) ? body.lines : []).slice(0, 200)) {
      const code = String(x.code || ''), q = num(x.qty); if (!code) continue;
      if (seen.has(code)) return reply({ error: 'Each item can appear only once in a transfer.' }, 400);
      seen.add(code);
      if (!(q > 0)) return reply({ error: 'Quantities must be more than 0.' }, 400);
      const s = src.get(code); if (!s) return reply({ error: `Item ${code} is not stocked at the source.` }, 400);
      if (q > s.qty + 1e-9) return reply({ error: `Only ${s.qty} ${s.unit} of ${s.name} at the source.`, code: 'short', item: code, available: s.qty }, 409);
      lines.push({ code, name: s.name || code, unit: s.unit, unit_cost: s.cost, unit_price: s.price, qty_req: q, batch: x.batch ? String(x.batch).slice(0, 40) : null, expiry: x.expiry ? String(x.expiry).slice(0, 20) : null });
    }
    if (!lines.length) return reply({ error: 'Add at least one item.' }, 400);
    const value = lines.reduce((t, l) => t + l.qty_req * (l.unit_cost || 0), 0);
    const settings = await S.getSettings(db, groupId);
    const approval = S.needsApproval(settings, internal, value);
    const id = 'X' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ref = await S.nextRef(db, groupId, internal), now = Date.now();
    const stmts = [db.prepare('INSERT INTO xfer (group_id, xfer_id, ref, internal, from_client, from_loc, to_client, to_loc, status, value, notes, requested_by, requested_at, approved_by, approved_at, reverses, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(groupId, id, ref, internal ? 1 : 0, fromC, fromL, toC, toL, approval ? 'pending' : 'approved', Math.round(value * 100) / 100, body.notes ? String(body.notes).slice(0, 300) : null, who.actor, now, approval ? null : 'rule: no approval needed', approval ? null : now, ctx._reverses || null, now)];
    lines.forEach((l, i) => stmts.push(db.prepare('INSERT INTO xfer_line (group_id, xfer_id, line_id, code, name, unit, unit_cost, unit_price, qty_req, batch, expiry) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(groupId, id, 'L' + String(i + 1).padStart(3, '0'), l.code, l.name, l.unit, l.unit_cost, l.unit_price, l.qty_req, l.batch, l.expiry)));
    await db.batch(stmts);
    await S.event(db, groupId, id, who.actor, 'created', { lines: lines.length, value, approval });
    await audit(db, groupId, who.actor, internal ? 'move.create' : 'transfer.create', 'branch:' + fromC, null, { ref, from: fromC + '/' + fromL, to: toC + '/' + toL, lines: lines.length, value: Math.round(value * 100) / 100 }, body.notes || null);
    if (!approval) await S.event(db, groupId, id, 'system', 'approved', { rule: settings.approval_mode, internal });
    if (internal && !approval) {
      // an internal move with no approval needed is done at once: out of one location, into the other, total unchanged
      const d = await dispatch(ctx, id, null);
      if (d.error) {
        const t = Date.now();
        await db.prepare(`UPDATE xfer SET status = 'cancelled', reject_reason = ?, closed_at = ?, updated_at = ? WHERE group_id = ? AND xfer_id = ? AND status = 'approved'`).bind('not enough stock when moving', t, t, groupId, id).run();
        await S.event(db, groupId, id, 'system', 'cancelled', { reason: d.error });
        return reply(d, d.status || 409);
      }
      const r = await receiveAll(ctx, id, 'auto');
      if (r.error) return reply(r, r.status || 409);
      return reply(ok({ xferId: id, ref, status: 'completed' }));
    }
    if (body.send && !approval && inScope(fromC)) {
      // zip 311 "Send": no approval needed -> dispatched at once (stock leaves the source now and is on its way). If the source is short now,
      // the transfer stays approved and the error says why.
      const d = await dispatch(ctx, id, null);
      if (d.error) return reply({ ...d, xferId: id, ref }, d.status || 409);
      return reply(ok({ xferId: id, ref, status: 'in_transit' }));
    }
    return reply(ok({ xferId: id, ref, status: approval ? 'pending' : 'approved' }));
  }
  if (a === 'xfer.approve' || a === 'xfer.reject') {
    if (!can('transfers.approve')) return deny();
    const x = await S.xferRow(db, groupId, String(body.xferId || '')); if (!x) return reply({ error: 'Transfer not found.' }, 404);
    if (!inScope(x.from_client) && !inScope(x.to_client)) return deny();
    const settings = await S.getSettings(db, groupId);
    if (a === 'xfer.approve' && settings.independent_approval && who.kind !== 'owner' && x.requested_by === who.actor) return deny('You requested this transfer, so someone else must approve it.');
    if (a === 'xfer.reject' && !String(body.reason || '').trim()) return reply({ error: 'Give a reason for rejecting it.' }, 400);
    const to = a === 'xfer.approve' ? 'approved' : 'rejected', now = Date.now();
    const r = await db.prepare(`UPDATE xfer SET status = ?, approved_by = ?, approved_at = ?, reject_reason = ?, closed_at = ?, updated_at = ? WHERE group_id = ? AND xfer_id = ? AND status = 'pending'`)
      .bind(to, who.actor, now, to === 'rejected' ? String(body.reason).slice(0, 200) : null, to === 'rejected' ? now : null, now, groupId, x.xfer_id).run();
    if (!(r.meta && r.meta.changes)) return reply({ error: 'This transfer is no longer waiting for approval.' }, 409);
    await S.event(db, groupId, x.xfer_id, who.actor, to, body.reason ? { reason: body.reason } : null);
    await audit(db, groupId, who.actor, 'transfer.' + (to === 'approved' ? 'approve' : 'reject'), 'branch:' + x.from_client, null, { ref: x.ref }, body.reason || null);
    if (to === 'approved' && x.internal) {
      // an approved move between two places of one branch is carried out at once
      const d = await dispatch(ctx, x.xfer_id, null); if (d.error) return reply(d, d.status || 409);
      const r2 = await receiveAll(ctx, x.xfer_id, 'auto'); if (r2.error) return reply(r2, r2.status || 409);
      return reply(ok({ status: 'completed' }));
    }
    return reply(ok({ status: to }));
  }
  if (a === 'xfer.cancel') {
    const x = await S.xferRow(db, groupId, String(body.xferId || '')); if (!x) return reply({ error: 'Transfer not found.' }, 404);
    if (!(x.requested_by === who.actor || can('transfers.approve')) || (!inScope(x.from_client) && !inScope(x.to_client))) return deny();
    const now = Date.now();
    const r = await db.prepare(`UPDATE xfer SET status = 'cancelled', reject_reason = ?, closed_at = ?, updated_at = ? WHERE group_id = ? AND xfer_id = ? AND status IN ('pending','approved')`).bind(String(body.reason || 'cancelled').slice(0, 200), now, now, groupId, x.xfer_id).run();
    if (!(r.meta && r.meta.changes)) return reply({ error: 'Only a transfer that has not been dispatched can be cancelled.' }, 409);
    await S.event(db, groupId, x.xfer_id, who.actor, 'cancelled', { reason: body.reason || null });
    return reply(ok({ status: 'cancelled' }));
  }
  if (a === 'xfer.dispatch') {
    if (!can('inventory.manage')) return deny();
    const x = await S.xferRow(db, groupId, String(body.xferId || '')); if (!x) return reply({ error: 'Transfer not found.' }, 404);
    if (!inScope(x.from_client)) return deny('Only someone who manages the source branch can dispatch.');
    const d = await dispatch(ctx, x.xfer_id, Array.isArray(body.lines) ? body.lines : null);
    return d.error ? reply(d, d.status || 409) : reply(ok(d));
  }
  if (a === 'xfer.receive') {
    if (!can('inventory.manage')) return deny();
    const x = await S.xferRow(db, groupId, String(body.xferId || '')); if (!x) return reply({ error: 'Transfer not found.' }, 404);
    if (!inScope(x.to_client)) return deny('Only someone who manages the destination branch can receive.');
    const key = String(body.receiptId || '').replace(/[^\w-]/g, '').slice(0, 40);
    if (!key) return reply({ error: 'Missing receipt id.' }, 400);
    const r = await receive(ctx, x.xfer_id, key, Array.isArray(body.lines) ? body.lines : []);
    return r.error ? reply(r, r.status || 409) : reply(ok(r));
  }
  if (a === 'xfer.resolve') {
    if (!can('transfers.approve')) return deny();
    const x = await S.xferRow(db, groupId, String(body.xferId || '')); if (!x) return reply({ error: 'Transfer not found.' }, 404);
    if (!inScope(x.from_client) && !inScope(x.to_client)) return deny();
    if (!['discrepancy', 'partial'].includes(x.status)) return reply({ error: 'There is nothing to resolve on this transfer.' }, 409);
    const lines = await S.xferLines(db, groupId, x.xfer_id), want = new Map((Array.isArray(body.lines) ? body.lines : []).map((l) => [String(l.lineId), l]));
    for (const l of lines) {
      const w = want.get(l.line_id); const shortQ = num(l.qty_damaged + l.qty_missing);
      if (!w || !(shortQ > 0) || l.resolution) continue;
      const res = ['write_off', 'return_to_source', 'found_at_destination'].includes(w.resolution) ? w.resolution : '';
      if (!res) return reply({ error: 'Choose how to settle each short line: write off, return to the source, or found at the destination.' }, 400);
      if (!String(w.note || body.reason || '').trim()) return reply({ error: 'Add a note explaining the difference.' }, 400);
      if (res === 'return_to_source' || res === 'found_at_destination') {
        const at = res === 'return_to_source' ? [x.from_client, x.from_loc] : [x.to_client, x.to_loc];
        const r = await S.applyAt(env, db, groupId, at[0], at[1], [{ mid: `${x.xfer_id}:${l.line_id}:resolve`, code: l.code, name: l.name, unit: l.unit, unit_cost: l.unit_cost, unit_price: l.unit_price, qty: shortQ }], { kind: res === 'return_to_source' ? 'transfer_return' : 'transfer_in', xfer_id: x.xfer_id, ref: x.ref, actor: who.actor, reason: `${x.ref}: ${res.replace(/_/g, ' ')} - ${w.note || body.reason}` });
        if (!r.ok) return reply({ error: 'That branch’s stock could not be updated. Try again.' }, 503);
      }
      await db.prepare('UPDATE xfer_line SET resolution = ?, resolved_qty = ? WHERE group_id = ? AND xfer_id = ? AND line_id = ? AND resolution IS NULL').bind(res + ': ' + String(w.note || body.reason).slice(0, 160), shortQ, groupId, x.xfer_id, l.line_id).run();
      await S.event(db, groupId, x.xfer_id, who.actor, 'resolved', { line: l.line_id, code: l.code, qty: shortQ, resolution: res, note: w.note || body.reason });
    }
    const fresh = await S.xferLines(db, groupId, x.xfer_id), st = S.statusAfterReceipt(fresh), now = Date.now();
    await db.prepare('UPDATE xfer SET status = ?, closed_at = ?, updated_at = ? WHERE group_id = ? AND xfer_id = ?').bind(st, st === 'completed' ? now : null, now, groupId, x.xfer_id).run();
    if (st === 'completed') await S.event(db, groupId, x.xfer_id, who.actor, 'completed', null);
    return reply(ok({ status: st }));
  }
  if (a === 'xfer.reverse') {
    if (!can('inventory.manage')) return deny();
    const x = await S.xferRow(db, groupId, String(body.xferId || '')); if (!x) return reply({ error: 'Transfer not found.' }, 404);
    if (!x.internal || x.status !== 'completed') return reply({ error: 'Only a completed move between locations of one branch can be reversed here. For a transfer between branches, create a transfer back.' }, 400);
    if (!inScope(x.from_client)) return deny();
    const done = await db.prepare('SELECT ref FROM xfer WHERE group_id = ? AND reverses = ?').bind(groupId, x.xfer_id).first();
    if (done) return reply({ error: `Already reversed by ${done.ref}.` }, 409);
    const lines = await S.xferLines(db, groupId, x.xfer_id);
    // the reversal is a NEW move the other way (its own reference and movements, linked by `reverses`); the original stays exactly as it was
    const res = await handle({ ...ctx, _reverses: x.xfer_id, reply: (b) => b, deny: (m) => ({ error: m || 'You do not have permission for this.' }) }, 'inv.move',
      { clientId: x.from_client, fromLoc: x.to_loc, toLoc: x.from_loc, lines: lines.map((l) => ({ code: l.code, qty: num(l.qty_recv) })).filter((l) => l.qty > 0), notes: 'Reverses ' + x.ref });
    if (res && res.ok) { await S.event(db, groupId, x.xfer_id, who.actor, 'reversed', { by: res.ref }); await audit(db, groupId, who.actor, 'move.reverse', 'branch:' + x.from_client, null, { reversed: x.ref, by: res.ref }, body.reason); }
    return reply(res && res.ok ? res : (res || { error: 'Could not reverse.' }), res && res.ok ? 200 : 409);
  }
  return null;
}

// Dispatch: claim (approved -> dispatching, one winner), take the stock off the source (fixed movement ids), then in_transit. A source short of
// stock (checked again now, inside its own database) puts the transfer back to approved and says what is short. A dispatch that broke off halfway
// ('dispatching') is finished by the next press: the movements already taken are recognised by their ids.
async function dispatch(ctx, xferId, wanted) {
  const { env, db, groupId, who } = ctx;
  const x0 = await S.xferRow(db, groupId, xferId);
  if (!x0) return { error: 'Transfer not found.', status: 404 };
  if (x0.status !== 'approved' && x0.status !== 'dispatching') return { error: x0.status === 'pending' ? 'This transfer still needs approval.' : 'This transfer has already been dispatched or closed.', status: 409 };
  const now = Date.now();
  if (x0.status === 'approved') {
    const c = await db.prepare(`UPDATE xfer SET status = 'dispatching', updated_at = ? WHERE group_id = ? AND xfer_id = ? AND status = 'approved'`).bind(now, groupId, xferId).run();
    if (!(c.meta && c.meta.changes)) return { error: 'Someone else is dispatching this transfer right now.', status: 409 };
  }
  const lines = await S.xferLines(db, groupId, xferId), want = wanted ? new Map(wanted.map((l) => [String(l.lineId), num(l.qty)])) : null;
  const plan = [];
  for (const l of lines) {
    const q = want ? (want.has(l.line_id) ? want.get(l.line_id) : 0) : l.qty_req;
    if (q < 0 || q > l.qty_req + 1e-9) { await back(); return { error: `Dispatch at most the requested ${l.qty_req} of ${l.name}.`, status: 400 }; }
    if (q > 0) plan.push({ l, q });
  }
  if (!plan.length) { await back(); return { error: 'Dispatch at least one item.', status: 400 }; }
  async function back() { await db.prepare(`UPDATE xfer SET status = 'approved', updated_at = ? WHERE group_id = ? AND xfer_id = ? AND status = 'dispatching'`).bind(Date.now(), groupId, xferId).run(); }
  let r;
  try {
    r = await S.applyAt(env, db, groupId, x0.from_client, x0.from_loc, plan.map(({ l, q }) => ({ mid: `${xferId}:${l.line_id}:out`, code: l.code, name: l.name, unit: l.unit, unit_cost: l.unit_cost, qty: -q })),
      { kind: 'transfer_out', xfer_id: xferId, ref: x0.ref, actor: who.actor, reason: `${x0.ref} dispatched` });
  } catch (e) { await back(); return { error: e.message || 'The source branch did not answer.', status: 503 }; }
  if (!r.ok) {
    await back();
    const l = plan.find((p) => String(p.l.code) === String(r.short && r.short.code));
    await S.event(ctx.db, groupId, xferId, who.actor, 'dispatch_refused', { short: r.short });
    return { error: l ? `Not enough ${l.l.name} at the source now: ${r.short.available} ${l.l.unit} left (someone may have just sold or moved some).` : 'Not enough stock at the source now.', status: 409, code: 'short', short: r.short };
  }
  const stmts = plan.map(({ l, q }) => db.prepare('UPDATE xfer_line SET qty_disp = ? WHERE group_id = ? AND xfer_id = ? AND line_id = ?').bind(q, groupId, xferId, l.line_id));
  stmts.push(db.prepare(`UPDATE xfer SET status = 'in_transit', dispatched_by = ?, dispatched_at = ?, updated_at = ? WHERE group_id = ? AND xfer_id = ? AND status = 'dispatching'`).bind(who.actor, now, Date.now(), groupId, xferId));
  await db.batch(stmts);
  await S.event(db, groupId, xferId, who.actor, 'dispatched', { lines: plan.map(({ l, q }) => ({ line: l.line_id, code: l.code, qty: q })) });
  return { status: 'in_transit', ref: x0.ref };
}

// Receipt: one receiptId = one receipt (pressing Receive twice, or a retry, counts it once). received + damaged + missing per line can never exceed
// what is still in transit. Only RECEIVED quantities reach the destination's stock.
async function receive(ctx, xferId, key, wanted) {
  const { env, db, groupId, who } = ctx;
  const x = await S.xferRow(db, groupId, xferId);
  if (!x) return { error: 'Transfer not found.', status: 404 };
  const eid = 'rcv-' + xferId + '-' + key;
  const lines = await S.xferLines(db, groupId, xferId);
  let repeated = !!(await db.prepare('SELECT 1 AS y FROM xfer_event WHERE group_id = ? AND event_id = ?').bind(groupId, eid).first());
  if (!repeated && !['in_transit', 'partial'].includes(x.status)) return { error: 'This transfer is not on its way.', status: 409 };
  const w = new Map(wanted.map((l) => [String(l.lineId), l]));
  const plan = [];
  if (!repeated) {
    for (const l of lines) {
      const v = w.get(l.line_id); if (!v) continue;
      const rq = num(v.received), dq = num(v.damaged), mq = num(v.missing);
      if (rq < 0 || dq < 0 || mq < 0) return { error: 'Quantities cannot be negative.', status: 400 };
      if (rq + dq + mq > S.inTransitOf(l) + 1e-9) return { error: `${l.name}: only ${S.inTransitOf(l)} ${l.unit} are still on the way.`, status: 400 };
      if (rq + dq + mq > 0) plan.push({ l, rq, dq, mq });
    }
    if (!plan.length) return { error: 'Enter what arrived.', status: 400 };
    // 1) the receipt itself: this receipt's event + the line counters in ONE transaction. The same receipt id twice -> the event's key exists ->
    //    the whole transaction rolls back (nothing counted twice); two different receipts at once that together exceed what is on the way -> the
    //    line's CHECK fails -> rolled back. 2) the stock at the destination, by fixed movement ids (a retry adds nothing twice).
    const detail = { key, lines: plan.map(({ l, rq, dq, mq }) => ({ line: l.line_id, code: l.code, received: rq, damaged: dq, missing: mq })) };
    const stmts = [db.prepare('INSERT INTO xfer_event (group_id, event_id, xfer_id, at, actor, action, detail) VALUES (?,?,?,?,?,?,?)').bind(groupId, eid, xferId, Date.now(), who.actor, 'received', JSON.stringify(detail))];
    for (const { l, rq, dq, mq } of plan) stmts.push(db.prepare('UPDATE xfer_line SET qty_recv = qty_recv + ?, qty_damaged = qty_damaged + ?, qty_missing = qty_missing + ? WHERE group_id = ? AND xfer_id = ? AND line_id = ?').bind(rq, dq, mq, groupId, xferId, l.line_id));
    try { await db.batch(stmts); }
    catch (e) {
      const m = String(e && e.message || e);
      if (/CHECK/i.test(m)) return { error: 'Someone else has just received part of this transfer. Open it again to see what is still on the way.', status: 409 };
      if (!/UNIQUE|PRIMARY/i.test(m)) throw e;
      repeated = true;     // the same receipt, counted a moment ago by a parallel request
    }
  }
  let lines2 = plan;
  if (repeated) {
    const ev = await db.prepare('SELECT detail FROM xfer_event WHERE group_id = ? AND event_id = ?').bind(groupId, eid).first();
    const d = ev && ev.detail ? JSON.parse(ev.detail) : { lines: [] }, byLine = new Map(lines.map((l) => [l.line_id, l]));
    lines2 = d.lines.filter((x) => byLine.has(x.line)).map((x) => ({ l: byLine.get(x.line), rq: num(x.received) }));
  }
  const toIn = lines2.filter((p) => p.rq > 0).map(({ l, rq }) => ({ mid: `${xferId}:${l.line_id}:in:${key}`, code: l.code, name: l.name, unit: l.unit, unit_cost: l.unit_cost, unit_price: l.unit_price, qty: rq }));
  if (toIn.length) {
    let r;
    try { r = await S.applyAt(env, db, groupId, x.to_client, x.to_loc, toIn, { kind: 'transfer_in', xfer_id: xferId, ref: x.ref, actor: who.actor, reason: `${x.ref} received` }); }
    catch (e) { return { error: ((e && e.message) || 'The destination branch did not answer.') + ' The receipt is saved: press Receive again with the same screen and the stock will be added once.', status: 503, pending: true }; }
    if (!r.ok) return { error: 'The destination could not take the stock. Try again.', status: 503 };
  }
  const fresh = await S.xferLines(db, groupId, xferId), st = S.statusAfterReceipt(fresh), now = Date.now();
  await db.prepare(`UPDATE xfer SET status = ?, received_by = ?, received_at = ?, closed_at = ?, updated_at = ? WHERE group_id = ? AND xfer_id = ? AND status NOT IN ('completed','rejected','cancelled')`).bind(st, who.actor, now, st === 'completed' ? now : null, now, groupId, xferId).run();
  if (st === 'completed' && x.status !== 'completed') await S.event(db, groupId, xferId, who.actor, 'completed', null).catch(() => {});
  return { status: st, ref: x.ref, repeated };
}
async function receiveAll(ctx, xferId, key) {
  const lines = await S.xferLines(ctx.db, ctx.groupId, xferId);
  return receive(ctx, xferId, key, lines.map((l) => ({ lineId: l.line_id, received: S.inTransitOf(l) })));
}
