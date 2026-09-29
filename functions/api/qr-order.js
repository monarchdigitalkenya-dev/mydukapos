// functions/api/qr-order.js — Cloudflare Pages Function. zip 136 (QR ordering), rebuilt on Cloudflare D1 in zip 153.
//
// Every table, room, poolside seat, cabana … has ONE permanent location record (loc_id) and a QR code that carries only a random
// 192-bit token which the server resolves to it. A rename changes the label, never the id or the token; regenerating a code changes the
// token, never the id. Orders, who claimed them, cancellations, exchanges and the guest's payment submissions are rows in D1
// (qr_locations / qr_orders / qr_order_items / qr_order_events / qr_order_requests / qr_order_payments — see _ledger-schema.js), so the
// order state is durable, auditable and updated with conditional SQL — never read-modify-write.
//
// SECURITY MODEL (unchanged in spirit)
//  * The QR never contains "/table/12": nothing in it can be edited to reach another table, room, branch or business. The token must belong
//    to the shop of the request; revoked / disabled / expired tokens are simply "not found".
//  * Guests read only what the shop PUBLISHED (names, prices, photos, payment instructions) and see only THEIR OWN orders. Prices come from
//    the published menu — whatever the phone sends as a price is ignored. A guest can never perform a financial action: what they submit as
//    payment is only information (PENDING) until a cashier confirms it against a real sale.
//  * Every order / cancel / exchange / payment is idempotent (the page sends a key): a double tap or a retry is ONE record.
//  * Managing codes, claiming, moving an order along, confirming money need the licence and — where the shop requires it — a paired device
//    and a signed-in staff member (orders.manage / payments).
//
// ORDER LIFECYCLE
//   SUBMITTED -> CLAIMED (owner = the staff member who claimed it, once) -> PREPARING -> READY -> SERVED -> BILLED -> PAID
//   SUBMITTED -> REJECTED | CANCELLED        CLAIMED / PREPARING -> CANCELLED (staff)        BILLED = the owner printed the bill
//
// PUBLIC (customer phone, no app):
//   GET  ?t=<token>                          -> { business, location:{label,kind}, session, open, menu, payment }
//   GET  ?t=<token>&o=<orderId>              -> { order:{ id,status,items,total,owner,billNo,paid,outstanding,payments,requests,canCancel,canExchange,... } }
//   POST { action:'order', t, key, items:[{code,qty,modifiers,note}], name?, phone?, note? }
//   POST { action:'cancel', t, orderId, key }                    (SUBMITTED: cancelled now; CLAIMED/PREPARING: a request staff must approve)
//   POST { action:'exchange', t, orderId, line, toCode, key }    (SUBMITTED: done now; CLAIMED: a request staff approve; later: refused)
//   POST { action:'pay', t, orderId, method:'mpesa'|'cash', mpesaCode?, key }   (submits payment INFORMATION; never marks anything paid)
// STAFF (a till):
//   list | create{kind,label} | ensure{kind,labels[]} | rename{locId,label} | revoke{token|locId} | regenerate{token|locId} | publishMenu{menu}
//   pending | claim{orderId} | decide{orderId,accept} | reject{orderId,reason} | link{orderId,billNo,tabId} | status{orderId,status,override?}
//   billPrinted{orderId} | requests | decideRequest{reqId,approve} | payments | confirmPayment{payId,saleId} | release{locId|label,kind}
import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { staffGuard } from './_staff-auth.js';
import { deviceGuard } from './_device-auth.js';
import { checkRateLimit, rateLimitResponse } from './_ratelimit.js';
import { ledgerDb, ensureLedgerSchema, round2 } from './_ledger.js';

export const QR_KINDS = ['table', 'room', 'pool', 'cabana', 'facility', 'location'];
export const ORDER_STATUSES = ['SUBMITTED', 'CLAIMED', 'PREPARING', 'READY', 'SERVED', 'BILLED', 'PAID', 'CANCELLED', 'REJECTED'];
const TERMINAL = ['PAID', 'CANCELLED', 'REJECTED'];
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MPESA_RE = /^[A-Z0-9]{8,14}$/;
const MAX_ITEMS = 40, MAX_QTY = 50;
// what staff may move an order to, from where (claiming is its own action; BILLED comes from billPrinted; PAID from a confirmed payment)
const MOVES = { CLAIMED: ['PREPARING', 'READY', 'SERVED', 'CANCELLED'], PREPARING: ['READY', 'SERVED', 'CANCELLED'], READY: ['SERVED', 'CANCELLED'], SERVED: [], BILLED: [], SUBMITTED: [] };

const kv = (env) => env.mydukapos_kv;
const menuKey = (c) => `qr:menu:${c}`;
export function newToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const newId = (prefix) => prefix + newToken().slice(0, 16);
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
async function getJson(env, key, dflt) { const raw = await kv(env).get(key); if (!raw) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}

// ---- rows -> objects ----
const first = async (db, sql, ...a) => db.prepare(sql).bind(...a).first();
const all = async (db, sql, ...a) => ((await db.prepare(sql).bind(...a).all()).results) || [];
async function liveLocationByToken(db, token, clientId) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const r = await first(db, `SELECT * FROM qr_locations WHERE token = ?`, token);
  if (!r || r.client_id !== clientId || !r.active) return null;
  if (r.expires_at && Date.now() > r.expires_at) return null;
  return r;
}
const itemRows = (db, clientId, orderId) => all(db, `SELECT line_no, code, name, base_name, qty, price, station, modifiers, note, removed FROM qr_order_items WHERE client_id = ? AND order_id = ? ORDER BY line_no`, clientId, orderId);
const shapeItem = (i) => ({ line: i.line_no, code: i.code, name: i.name, baseName: i.base_name, qty: i.qty, price: i.price, station: i.station, modifiers: i.modifiers ? JSON.parse(i.modifiers) : [], note: i.note || '', removed: !!i.removed });
async function paidFor(db, clientId, order) {
  // what the ORDER's guests have had confirmed: confirmed QR payments, plus (when the bill is on the ledger) the bill's own numbers
  const q = await first(db, `SELECT COALESCE(SUM(amount), 0) AS paid FROM qr_order_payments WHERE client_id = ? AND order_id = ? AND status = 'CONFIRMED'`, clientId, order.order_id);
  return round2(q ? q.paid : 0);
}
async function shapeOrder(db, clientId, o, opt = {}) {
  const items = (await itemRows(db, clientId, o.order_id)).map(shapeItem);
  const paid = await paidFor(db, clientId, o);
  const pays = await all(db, `SELECT pay_id, method, amount, mpesa_code, status, submitted_at FROM qr_order_payments WHERE client_id = ? AND order_id = ? ORDER BY submitted_at`, clientId, o.order_id);
  const reqs = await all(db, `SELECT req_id, type, payload, status, created_at FROM qr_order_requests WHERE client_id = ? AND order_id = ? ORDER BY created_at`, clientId, o.order_id);
  const events = opt.staff ? await all(db, `SELECT at, actor, actor_kind, event, from_status, to_status, detail FROM qr_order_events WHERE client_id = ? AND order_id = ? ORDER BY id`, clientId, o.order_id) : undefined;
  const loc = await first(db, `SELECT label, kind FROM qr_locations WHERE client_id = ? AND loc_id = ?`, clientId, o.loc_id);
  const editable = o.status === 'SUBMITTED';
  const live = !TERMINAL.includes(o.status) && o.status !== 'SERVED' && o.status !== 'BILLED';
  return {
    id: o.order_id, status: o.status, items, total: o.total, name: o.guest_name || '', note: o.note || '', createdAt: o.created_at, updatedAt: o.updated_at,
    label: loc ? loc.label : '', kind: loc ? loc.kind : '', locId: o.loc_id, owner: o.owner || null, ownerAt: o.owner_at || null, billNo: o.bill_id || null, tabLabel: o.tab_label || '',
    cancelRequested: !!o.cancel_requested, printedAt: o.printed_at || null,
    paid, outstanding: round2(Math.max(0, o.total - paid)),
    pendingPay: round2(pays.filter((p) => p.status === 'PENDING').reduce((n, p) => n + p.amount, 0)),
    payments: pays.map((p) => ({ id: p.pay_id, method: p.method, amount: p.amount, mpesaCode: p.mpesa_code || '', status: p.status, at: p.submitted_at })),
    requests: reqs.map((r) => ({ id: r.req_id, type: r.type, payload: r.payload ? JSON.parse(r.payload) : null, status: r.status, at: r.created_at })),
    canCancel: (editable || o.status === 'CLAIMED' || o.status === 'PREPARING') && !o.cancel_requested,
    cancelMode: editable ? 'now' : (o.status === 'CLAIMED' || o.status === 'PREPARING') ? 'request' : null,
    canExchange: editable || o.status === 'CLAIMED',
    exchangeMode: editable ? 'now' : o.status === 'CLAIMED' ? 'request' : null,
    canPay: !['CANCELLED', 'REJECTED', 'SUBMITTED'].includes(o.status) && o.total - paid > 0.004,
    live,
    ...(events ? { events } : {}),
  };
}
const eventStmt = (db, clientId, orderId, actor, kind, event, from, to, detail) => db.prepare(
  `INSERT INTO qr_order_events (client_id, order_id, at, actor, actor_kind, event, from_status, to_status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(clientId, orderId, Date.now(), actor || null, kind, event, from || null, to || null, detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)));
const recalcTotal = (db, clientId, orderId) => db.prepare(
  `UPDATE qr_orders SET total = COALESCE((SELECT ROUND(SUM(price * qty), 2) FROM qr_order_items WHERE client_id = ? AND order_id = ? AND removed = 0), 0), updated_at = ? WHERE client_id = ? AND order_id = ?`)
  .bind(clientId, orderId, Date.now(), clientId, orderId);

// A bare poke to the shop's other devices (the WebSocket room), so a new order shows up in about a second instead of on the next poll.
function poke(context, clientId, what) {
  const env = context.env;
  if (!env.SYNC_ROOM) return;
  try {
    const room = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(clientId));
    const p = room.fetch('https://sync-room/broadcast', { method: 'POST', body: JSON.stringify({ poke: true, qr: what || true }) }).catch(() => {});
    if (context.waitUntil) context.waitUntil(p);
  } catch (e) { /* the poll is the fallback */ }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ error: 'This business is not taking orders here right now.' }, 404);
  const db = ledgerDb(env);
  if (!db) return reply({ error: 'Ordering is not available right now. Please ask a member of staff.', code: 'no_d1' }, 503);
  try {
    await ensureLedgerSchema(db);
    const u = new URL(request.url);
    const loc = await liveLocationByToken(db, u.searchParams.get('t'), license.clientId);
    if (!loc) return reply({ error: 'This code is not valid any more. Please ask a member of staff.' }, 404);
    const o = u.searchParams.get('o');
    if (o) {
      const row = await first(db, `SELECT * FROM qr_orders WHERE client_id = ? AND order_id = ?`, license.clientId, clean(o, 40));
      // a guest sees only THEIR order, and only through the code of the place it was made at
      if (!row || row.loc_id !== loc.loc_id) return reply({ error: 'Order not found.' }, 404);
      return reply({ order: await shapeOrder(db, license.clientId, row), session: loc.session_id });
    }
    const menu = await getJson(env, menuKey(license.clientId), null);
    return reply({
      business: (menu && menu.business) || '', location: { label: loc.label, kind: loc.kind }, session: loc.session_id,
      open: !!(menu && menu.open !== false && (menu.items || []).length),
      payment: (menu && menu.payment) || null,
      menu: menu ? { categories: menu.categories || [], items: (menu.items || []).filter((i) => i.available !== false), modifierGroups: menu.modifierGroups || [], note: menu.note || '' } : null,
    });
  } catch (e) {
    return reply({ error: 'Ordering is busy — please try again in a moment.', code: 'busy' }, 503);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ error: 'This business is not taking orders here right now.' }, 404);
  const clientId = license.clientId;
  let body;
  try { body = await request.json(); } catch (e) { return reply({ error: 'Invalid request.' }, 400); }
  if (!body || typeof body !== 'object') return reply({ error: 'Invalid request.' }, 400);
  const db = ledgerDb(env);
  if (!db) return reply({ error: 'The transaction database (D1) is not connected yet, so QR ordering is switched off. Ask the owner to finish the D1 setup.', code: 'no_d1' }, 503);
  try {
    await ensureLedgerSchema(db);
    return await handle(context, { env, cors, reply, clientId, body, db, request });
  } catch (e) {
    try { console.error('qr-order failed:', e && e.message); } catch (x) { /* logging only */ }
    return reply({ error: 'The server is busy — nothing was lost. Please try again in a moment.', code: 'busy', detail: String((e && e.message) || e).slice(0, 120) }, 503);
  }
}

async function handle(context, { env, cors, reply, clientId, body, db, request }) {
  const guestActions = ['order', 'cancel', 'exchange', 'pay'];

  /* ================= GUEST ================= */
  if (guestActions.includes(body.action)) {
    const loc = await liveLocationByToken(db, body.t, clientId);
    if (!loc) return reply({ error: 'This code is not valid any more. Please ask a member of staff.' }, 404);
    const key = clean(body.key, 64);
    if (!KEY_RE.test(key)) return reply({ error: 'Invalid request.' }, 400);
    const rlTok = await checkRateLimit(env, 'qrtok', loc.token);
    if (!rlTok.ok) return rateLimitResponse('requests from this code', rlTok, cors);
    const rlShop = await checkRateLimit(env, 'qr', clientId);
    if (!rlShop.ok) return rateLimitResponse('QR orders', rlShop, cors);

    if (body.action === 'order') {
      const prior = await first(db, `SELECT * FROM qr_orders WHERE client_id = ? AND idem_key = ?`, clientId, key);
      if (prior) return prior.loc_id === loc.loc_id ? reply({ ok: true, orderId: prior.order_id, status: prior.status, total: prior.total, repeated: true }) : reply({ error: 'Invalid request.' }, 400);
      const menu = await getJson(env, menuKey(clientId), null);
      if (!menu || menu.open === false) return reply({ error: 'Ordering by phone is closed right now. Please ask a member of staff.' }, 409);
      const byCode = new Map((menu.items || []).map((i) => [String(i.code), i]));
      const groups = new Map((menu.modifierGroups || []).map((g) => [g.id, g]));
      const raw = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
      if (!raw.length) return reply({ error: 'Your order is empty.' }, 400);
      const lines = [];
      for (const r of raw) {
        const it = byCode.get(String(r && r.code));
        if (!it || it.available === false) return reply({ error: `"${clean(r && r.name, 60) || 'An item'}" is not available any more.`, code: 'unavailable' }, 409);
        const qty = Number(r.qty);
        if (!(qty > 0 && qty <= MAX_QTY) || Math.round(qty * 2) !== qty * 2) return reply({ error: 'Check the quantities.' }, 400);   // whole or half portions only
        const mods = [];
        const want = new Set((Array.isArray(r.modifiers) ? r.modifiers : []).map((x) => String(x)));
        for (const gid of it.modifierGroupIds || []) {
          const g = groups.get(gid); if (!g) continue;
          const chosen = (g.options || []).filter((o) => want.has(o.name));
          if (g.required && !chosen.length) return reply({ error: `Choose ${g.name} for ${it.name}.` }, 400);
          if (g.max && chosen.length > g.max) return reply({ error: `${g.name}: at most ${g.max}.` }, 400);
          chosen.forEach((o) => mods.push({ group: g.name, name: o.name, price: Math.max(0, Number(o.price) || 0) }));
        }
        const unit = round2(Number(it.price) + mods.reduce((s, m) => s + m.price, 0));
        lines.push({ code: String(it.code), name: it.name + (mods.length ? ` (${mods.map((m) => m.name).join(', ')})` : ''), baseName: it.name, qty, price: unit, station: it.station || null, modifiers: mods, note: clean(r.note, 140) });
      }
      const total = round2(lines.reduce((s, i) => s + i.price * i.qty, 0));
      const id = newId('qo-'), now = Date.now();
      const st = [db.prepare(`INSERT INTO qr_orders (client_id, order_id, loc_id, session_id, status, total, guest_name, guest_phone, note, idem_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'SUBMITTED', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (client_id, idem_key) DO NOTHING`)
        .bind(clientId, id, loc.loc_id, loc.session_id, total, clean(body.name, 60), clean(body.phone, 20), clean(body.note, 200), key, now, now)];
      lines.forEach((l, i) => st.push(db.prepare(`INSERT INTO qr_order_items (client_id, order_id, line_no, code, name, base_name, qty, price, station, modifiers, note)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM qr_orders WHERE client_id = ? AND order_id = ? AND idem_key = ?)`)
        .bind(clientId, id, i, l.code, l.name, l.baseName, l.qty, l.price, l.station, JSON.stringify(l.modifiers), l.note, clientId, id, key)));
      st.push(db.prepare(`INSERT INTO qr_order_events (client_id, order_id, at, actor, actor_kind, event, from_status, to_status, detail)
        SELECT ?, ?, ?, ?, 'guest', 'SUBMITTED', NULL, 'SUBMITTED', ? WHERE EXISTS (SELECT 1 FROM qr_orders WHERE client_id = ? AND order_id = ? AND idem_key = ?)`)
        .bind(clientId, id, now, clean(body.name, 60) || 'guest', JSON.stringify({ items: lines.length, total }), clientId, id, key));
      // the place becomes ACTIVE when a guest orders at an AVAILABLE table / room
      st.push(db.prepare(`UPDATE qr_locations SET state = 'ACTIVE' WHERE client_id = ? AND loc_id = ? AND state = 'AVAILABLE'`).bind(clientId, loc.loc_id));
      await db.batch(st);
      const row = await first(db, `SELECT * FROM qr_orders WHERE client_id = ? AND idem_key = ?`, clientId, key);
      poke(context, clientId, 'order');
      return reply({ ok: true, orderId: row.order_id, status: row.status, total: row.total, repeated: row.order_id !== id ? true : undefined });
    }

    // the rest act on ONE order that was made at THIS place
    const orderId = clean(body.orderId, 40);
    const ord = await first(db, `SELECT * FROM qr_orders WHERE client_id = ? AND order_id = ?`, clientId, orderId);
    if (!ord || ord.loc_id !== loc.loc_id) return reply({ error: 'Order not found.' }, 404);
    const now = Date.now();

    if (body.action === 'cancel') {
      const seen = await first(db, `SELECT * FROM qr_order_requests WHERE client_id = ? AND idem_key = ?`, clientId, key);
      if (seen) return reply({ ok: true, requested: true, repeated: true, order: await shapeOrder(db, clientId, ord) });
      if (ord.status === 'SUBMITTED') {
        const r = await db.batch([
          db.prepare(`UPDATE qr_orders SET status = 'CANCELLED', updated_at = ? WHERE client_id = ? AND order_id = ? AND status = 'SUBMITTED'`).bind(now, clientId, orderId),
          db.prepare(`INSERT INTO qr_order_events (client_id, order_id, at, actor, actor_kind, event, from_status, to_status, detail)
            SELECT ?, ?, ?, ?, 'guest', 'CANCELLED_BY_GUEST', 'SUBMITTED', 'CANCELLED', ? WHERE changes() = 1`).bind(clientId, orderId, now, ord.guest_name || 'guest', key),
        ]);
        const done = r[0].meta && r[0].meta.changes === 1;
        const cur = await first(db, `SELECT * FROM qr_orders WHERE client_id = ? AND order_id = ?`, clientId, orderId);
        if (!done) return reply({ ok: false, error: `Sorry — the order is already ${String(cur.status).toLowerCase()}, so it can no longer be cancelled here. Please speak to your waiter.`, order: await shapeOrder(db, clientId, cur) }, 409);
        poke(context, clientId, 'cancel');
        return reply({ ok: true, cancelled: true, order: await shapeOrder(db, clientId, cur) });
      }
      if (ord.status === 'CLAIMED' || ord.status === 'PREPARING') {
        if (ord.cancel_requested) return reply({ ok: true, requested: true, repeated: true, order: await shapeOrder(db, clientId, ord) });
        await db.batch([
          db.prepare(`INSERT INTO qr_order_requests (client_id, req_id, order_id, type, payload, status, idem_key, created_at) VALUES (?, ?, ?, 'CANCEL', NULL, 'PENDING', ?, ?)`).bind(clientId, newId('rq-'), orderId, key, now),
          db.prepare(`UPDATE qr_orders SET cancel_requested = 1, updated_at = ? WHERE client_id = ? AND order_id = ?`).bind(now, clientId, orderId),
          eventStmt(db, clientId, orderId, ord.guest_name || 'guest', 'guest', 'CANCEL_REQUESTED', ord.status, ord.status, null),
        ]);
        poke(context, clientId, 'request');
        const cur = await first(db, `SELECT * FROM qr_orders WHERE client_id = ? AND order_id = ?`, clientId, orderId);
        return reply({ ok: true, requested: true, message: ord.status === 'PREPARING' ? 'Your order is already being prepared. We have asked the staff — they will confirm.' : 'We have asked the staff to cancel it — they will confirm.', order: await shapeOrder(db, clientId, cur) });
      }
      if (ord.status === 'CANCELLED') return reply({ ok: true, cancelled: true, repeated: true, order: await shapeOrder(db, clientId, ord) });   // a retry of a cancel that already worked
      return reply({ ok: false, error: `This order is already ${ord.status === 'PAID' ? 'paid' : ord.status.toLowerCase()} and can no longer be cancelled here. Please speak to your waiter.` }, 409);
    }

    if (body.action === 'exchange') {
      const menu = await getJson(env, menuKey(clientId), null);
      const to = ((menu && menu.items) || []).find((i) => String(i.code) === String(body.toCode) && i.available !== false);
      if (!to) return reply({ error: 'That item is not available.', code: 'unavailable' }, 409);
      const line = Number(body.line);
      const cur = await first(db, `SELECT * FROM qr_order_items WHERE client_id = ? AND order_id = ? AND line_no = ? AND removed = 0`, clientId, orderId, line);
      if (!cur) return reply({ error: 'That item is not on the order.' }, 404);
      const seen = await first(db, `SELECT * FROM qr_order_requests WHERE client_id = ? AND idem_key = ?`, clientId, key);
      if (seen) return reply({ ok: true, repeated: true, order: await shapeOrder(db, clientId, ord) });
      if (ord.status === 'SUBMITTED') {
        const next = (await first(db, `SELECT COALESCE(MAX(line_no), -1) + 1 AS n FROM qr_order_items WHERE client_id = ? AND order_id = ?`, clientId, orderId)).n;
        const r = await db.batch([
          db.prepare(`UPDATE qr_order_items SET removed = 1 WHERE client_id = ? AND order_id = ? AND line_no = ? AND removed = 0 AND EXISTS (SELECT 1 FROM qr_orders WHERE client_id = ? AND order_id = ? AND status = 'SUBMITTED')`).bind(clientId, orderId, line, clientId, orderId),
          db.prepare(`INSERT INTO qr_order_items (client_id, order_id, line_no, code, name, base_name, qty, price, station, modifiers, note)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ? WHERE changes() = 1`).bind(clientId, orderId, next, String(to.code), to.name, to.name, cur.qty, round2(Number(to.price)), to.station || null, cur.note),
          recalcTotal(db, clientId, orderId),
          db.prepare(`INSERT INTO qr_order_events (client_id, order_id, at, actor, actor_kind, event, from_status, to_status, detail)
            SELECT ?, ?, ?, ?, 'guest', 'EXCHANGED', 'SUBMITTED', 'SUBMITTED', ? WHERE EXISTS (SELECT 1 FROM qr_order_items WHERE client_id = ? AND order_id = ? AND line_no = ?)`)
            .bind(clientId, orderId, now, ord.guest_name || 'guest', JSON.stringify({ from: cur.name, to: to.name, key }), clientId, orderId, next),
        ]);
        const now2 = await first(db, `SELECT * FROM qr_orders WHERE client_id = ? AND order_id = ?`, clientId, orderId);
        if (!(r[0].meta && r[0].meta.changes === 1)) return reply({ ok: false, error: 'The order has just been picked up by the staff, so it can no longer be changed here — ask your waiter.', order: await shapeOrder(db, clientId, now2) }, 409);
        // a swap the guest made on their own order only counts once; remember the key so a retry is the same swap
        await db.prepare(`INSERT INTO qr_order_requests (client_id, req_id, order_id, type, payload, status, idem_key, created_at, decided_by, decided_at) VALUES (?, ?, ?, 'EXCHANGE', ?, 'APPLIED', ?, ?, 'guest', ?)`)
          .bind(clientId, newId('rq-'), orderId, JSON.stringify({ line, toCode: String(to.code) }), key, now, now).run();
        poke(context, clientId, 'exchange');
        return reply({ ok: true, exchanged: true, order: await shapeOrder(db, clientId, now2) });
      }
      if (ord.status === 'CLAIMED') {
        await db.batch([
          db.prepare(`INSERT INTO qr_order_requests (client_id, req_id, order_id, type, payload, status, idem_key, created_at) VALUES (?, ?, ?, 'EXCHANGE', ?, 'PENDING', ?, ?)`)
            .bind(clientId, newId('rq-'), orderId, JSON.stringify({ line, fromCode: cur.code, fromName: cur.name, toCode: String(to.code), toName: to.name, qty: cur.qty, price: round2(Number(to.price)) }), key, now),
          eventStmt(db, clientId, orderId, ord.guest_name || 'guest', 'guest', 'EXCHANGE_REQUESTED', ord.status, ord.status, { from: cur.name, to: to.name }),
        ]);
        poke(context, clientId, 'request');
        return reply({ ok: true, requested: true, message: 'We have asked the staff to swap it — they will confirm.', order: await shapeOrder(db, clientId, ord) });
      }
      return reply({ ok: false, error: `This order is already ${ord.status === 'PAID' ? 'paid' : ord.status.toLowerCase()}, so items can no longer be changed here. Please speak to your waiter.` }, 409);
    }

    if (body.action === 'pay') {
      const method = String(body.method || '').toLowerCase();
      if (!['mpesa', 'cash'].includes(method)) return reply({ error: 'Choose M-Pesa or cash.' }, 400);
      const seen = await first(db, `SELECT * FROM qr_order_payments WHERE client_id = ? AND idem_key = ?`, clientId, key);
      if (seen) return reply({ ok: true, repeated: true, order: await shapeOrder(db, clientId, ord) });
      if (['CANCELLED', 'REJECTED', 'SUBMITTED'].includes(ord.status)) return reply({ error: ord.status === 'SUBMITTED' ? 'Please wait — the staff have not confirmed your order yet.' : 'This order was cancelled.' }, 409);
      const paid = await paidFor(db, clientId, ord);
      const pend = await first(db, `SELECT COALESCE(SUM(amount), 0) AS s FROM qr_order_payments WHERE client_id = ? AND order_id = ? AND status = 'PENDING'`, clientId, orderId);
      const due = round2(ord.total - paid - (pend ? pend.s : 0));       // what is still unclaimed: confirmed AND waiting-for-the-cashier amounts both count
      if (!(due > 0.004)) return reply({ error: 'Your payment is already with the cashier — nothing more to pay on this order.' }, 409);
      // the code is OPTIONAL and is only a reference for the cashier — never proof of payment
      let code = clean(body.mpesaCode, 20).toUpperCase().replace(/\s+/g, '');
      if (method !== 'mpesa') code = '';
      if (code && !MPESA_RE.test(code)) return reply({ error: 'That M-Pesa code does not look right (10 letters and numbers, like QGH7XY2LMN). Check it, or leave it blank.', code: 'bad_code' }, 400);
      const amount = body.amount != null && body.amount !== '' ? round2(Number(body.amount)) : due;
      if (!(amount > 0) || amount > due + 0.004) return reply({ error: `The amount must be between 1 and ${due}.` }, 400);
      const payId = newId('qp-');
      await db.batch([
        db.prepare(`INSERT INTO qr_order_payments (client_id, pay_id, order_id, method, amount, mpesa_code, status, idem_key, submitted_at) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?) ON CONFLICT (client_id, idem_key) DO NOTHING`)
          .bind(clientId, payId, orderId, method, amount, code || null, key, now),
        db.prepare(`INSERT INTO qr_order_events (client_id, order_id, at, actor, actor_kind, event, from_status, to_status, detail)
          SELECT ?, ?, ?, ?, 'guest', 'PAYMENT_SUBMITTED', ?, ?, ? WHERE EXISTS (SELECT 1 FROM qr_order_payments WHERE client_id = ? AND pay_id = ?)`)
          .bind(clientId, orderId, now, ord.guest_name || 'guest', ord.status, ord.status, JSON.stringify({ method, amount, code: code || null }), clientId, payId),
      ]);
      poke(context, clientId, 'payment');
      const cur = await first(db, `SELECT * FROM qr_orders WHERE client_id = ? AND order_id = ?`, clientId, orderId);
      return reply({ ok: true, message: method === 'mpesa' ? 'Thank you. The cashier will confirm your M-Pesa payment.' : 'Thank you. Please pay the cashier or your waiter.', order: await shapeOrder(db, clientId, cur) });
    }
  }

  /* ================= STAFF: licence + paired device (+ signed-in staff where required) ================= */
  const denied = await deviceGuard(request, env, clientId, cors);
  if (denied) return denied;
  const need = ['create', 'ensure', 'rename', 'revoke', 'regenerate', 'publishMenu'].includes(body.action) ? 'orders.manage'
    : body.action === 'confirmPayment' ? 'payments' : body.action === 'release' ? 'orders.manage' : null;
  const sg = await staffGuard(request, env, clientId, need, cors);
  if (sg.denied) return sg.denied;
  const actor = clean(sg.claims ? sg.claims.name : body.by, 60) || 'staff';
  const isManager = !sg.claims || (sg.claims.perms || []).includes('*') || (sg.claims.perms || []).includes('orders.manage');
  const now = Date.now();
  const locOut = (r, extra = {}) => ({ locId: r.loc_id, token: r.token, kind: r.kind, label: r.label, active: !!r.active, state: r.state, session: r.session_id, createdAt: r.created_at, createdBy: r.created_by, expiresAt: r.expires_at || null, revokedAt: r.revoked_at || null, revokedBy: r.revoked_by || null, ...extra });

  if (body.action === 'list') {
    const rows = await all(db, `SELECT * FROM qr_locations WHERE client_id = ? AND (active = 1 OR revoked_at > ?) ORDER BY kind, label`, clientId, now - 30 * 86400000);
    return reply({ codes: rows.map((r) => locOut(r)) });
  }

  const createOne = async (kind, label, expiresAt) => {
    const ex = await first(db, `SELECT * FROM qr_locations WHERE client_id = ? AND kind = ? AND label = ? AND active = 1`, clientId, kind, label);
    if (ex) return { row: ex, existed: true };
    const row = { loc_id: newId('loc_'), token: newToken(), session_id: newId('ses_') };
    await db.prepare(`INSERT INTO qr_locations (client_id, loc_id, kind, label, token, active, state, session_id, expires_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, 1, 'AVAILABLE', ?, ?, ?, ?)`)
      .bind(clientId, row.loc_id, kind, label, row.token, row.session_id, expiresAt || null, now, actor).run();
    return { row: await first(db, `SELECT * FROM qr_locations WHERE client_id = ? AND loc_id = ?`, clientId, row.loc_id), existed: false };
  };

  if (body.action === 'create') {
    const kind = QR_KINDS.includes(body.kind) ? body.kind : 'location';
    const label = clean(body.label, 60);
    if (!label) return reply({ error: 'Name the table / room / location.' }, 400);
    const r = await createOne(kind, label, Number(body.expiresAt) > now ? Number(body.expiresAt) : null);
    if (r.existed) return reply({ error: 'That location already has an active code — regenerate it instead.' }, 409);
    return reply({ ok: true, code: locOut(r.row) });
  }
  // every table / room in one call (idempotent): what "generate 10 tables" needs so each has its own permanent code
  if (body.action === 'ensure') {
    const kind = QR_KINDS.includes(body.kind) ? body.kind : 'location';
    const labels = (Array.isArray(body.labels) ? body.labels : []).map((l) => clean(l, 60)).filter(Boolean).slice(0, 500);
    const codes = [];
    for (const label of labels) codes.push(locOut((await createOne(kind, label)).row));
    return reply({ ok: true, codes });
  }
  const findLoc = async () => {
    if (body.locId) return first(db, `SELECT * FROM qr_locations WHERE client_id = ? AND loc_id = ?`, clientId, clean(body.locId, 40));
    if (body.token) return first(db, `SELECT * FROM qr_locations WHERE client_id = ? AND token = ?`, clientId, clean(body.token, 40));
    if (body.label) return first(db, `SELECT * FROM qr_locations WHERE client_id = ? AND kind = ? AND label = ? AND active = 1`, clientId, QR_KINDS.includes(body.kind) ? body.kind : 'table', clean(body.label, 60));
    return null;
  };
  if (body.action === 'rename') {
    const loc = await findLoc(); const label = clean(body.newLabel || body.label2 || body.name, 60);
    if (!loc || !label) return reply({ error: 'No such location, or no new name.' }, 404);
    const clash = await first(db, `SELECT loc_id FROM qr_locations WHERE client_id = ? AND kind = ? AND label = ? AND active = 1 AND loc_id <> ?`, clientId, loc.kind, label, loc.loc_id);
    if (clash) return reply({ error: 'Another place already has that name.' }, 409);
    await db.prepare(`UPDATE qr_locations SET label = ? WHERE client_id = ? AND loc_id = ?`).bind(label, clientId, loc.loc_id).run();
    return reply({ ok: true, code: locOut({ ...loc, label }) });
  }
  if (body.action === 'revoke' || body.action === 'regenerate') {
    const loc = await findLoc();
    if (!loc || !loc.active) return reply({ error: 'No such active code.' }, 404);
    if (body.action === 'revoke') {
      await db.prepare(`UPDATE qr_locations SET active = 0, revoked_at = ?, revoked_by = ? WHERE client_id = ? AND loc_id = ?`).bind(now, actor, clientId, loc.loc_id).run();
      return reply({ ok: true, code: null });
    }
    const token = newToken();       // the place (loc_id) stays; only the code changes, and the old one stops at once
    await db.prepare(`UPDATE qr_locations SET token = ?, created_by = ?, created_at = ? WHERE client_id = ? AND loc_id = ?`).bind(token, actor, now, clientId, loc.loc_id).run();
    return reply({ ok: true, code: locOut({ ...loc, token, created_by: actor, created_at: now }, { replaces: loc.token }) });
  }

  if (body.action === 'publishMenu') {
    const m = body.menu || {};
    const items = (Array.isArray(m.items) ? m.items : []).slice(0, 2000).map((i) => ({
      code: clean(i.code, 60), name: clean(i.name, 80), price: Math.max(0, round2(Number(i.price) || 0)), category: clean(i.category, 40),
      description: clean(i.description, 200), image: /^\/api\/media\?k=p&id=[A-Za-z0-9_-]{6,80}$/.test(String(i.image || '')) ? String(i.image) : '',
      station: ['bar', 'kitchen'].includes(String(i.station)) ? String(i.station) : '',
      available: i.available !== false, modifierGroupIds: (Array.isArray(i.modifierGroupIds) ? i.modifierGroupIds : []).map((x) => clean(x, 60)).slice(0, 10),
    })).filter((i) => i.code && i.name);
    const modifierGroups = (Array.isArray(m.modifierGroups) ? m.modifierGroups : []).slice(0, 100).map((g) => ({ id: clean(g.id, 60), name: clean(g.name, 60), required: !!g.required, max: Math.max(0, Number(g.max) || 0),
      options: (Array.isArray(g.options) ? g.options : []).slice(0, 30).map((o) => ({ name: clean(o.name, 60), price: Math.max(0, round2(Number(o.price) || 0)) })).filter((o) => o.name) })).filter((g) => g.id && g.name);
    const p = m.payment && typeof m.payment === 'object' ? m.payment : null;
    // Payment instructions shown to the guest come from the shop's own settings (published with the menu) — never typed into the guest page.
    const payment = p ? { mpesa: !!p.mpesa, cash: p.cash !== false, tillNumber: clean(p.tillNumber, 20), paybill: clean(p.paybill, 20), accountNumber: clean(p.accountNumber, 30), accountName: clean(p.accountName, 60), instructions: clean(p.instructions, 300) } : null;
    const menu = { business: clean(m.business, 80), open: m.open !== false, note: clean(m.note, 300), categories: Array.from(new Set(items.map((i) => i.category).filter(Boolean))), items, modifierGroups, payment, publishedAt: now };
    await kv(env).put(menuKey(clientId), JSON.stringify(menu));
    return reply({ ok: true, items: items.length });
  }

  const orderOf = async () => first(db, `SELECT * FROM qr_orders WHERE client_id = ? AND order_id = ?`, clientId, clean(body.orderId, 40));

  if (body.action === 'pending') {
    // unclaimed orders (waiting for a member of staff) + the orders staff are handling, newest last
    const rows = await all(db, `SELECT * FROM qr_orders WHERE client_id = ? AND status IN ('SUBMITTED', 'CLAIMED', 'PREPARING', 'READY', 'SERVED', 'BILLED') ORDER BY created_at LIMIT 200`, clientId);
    const orders = [];
    for (const r of rows) orders.push(await shapeOrder(db, clientId, r));
    const reqs = await all(db, `SELECT r.req_id, r.order_id, r.type, r.payload, r.created_at FROM qr_order_requests r WHERE r.client_id = ? AND r.status = 'PENDING' ORDER BY r.created_at`, clientId);
    const pays = await all(db, `SELECT p.pay_id, p.order_id, p.method, p.amount, p.mpesa_code, p.submitted_at FROM qr_order_payments p WHERE p.client_id = ? AND p.status = 'PENDING' ORDER BY p.submitted_at`, clientId);
    return reply({ orders, requests: reqs.map((r) => ({ id: r.req_id, orderId: r.order_id, type: r.type, payload: r.payload ? JSON.parse(r.payload) : null, at: r.created_at })),
      payments: pays.map((p) => ({ id: p.pay_id, orderId: p.order_id, method: p.method, amount: p.amount, mpesaCode: p.mpesa_code || '', at: p.submitted_at })) });
  }

  // CLAIM: ONE conditional UPDATE. Two staff at the same instant: the database lets exactly one row change, the other is told who has it.
  if (body.action === 'claim' || (body.action === 'decide' && body.accept)) {
    const o = await orderOf();
    if (!o) return reply({ error: 'Order not found.' }, 404);
    const r = await db.batch([
      db.prepare(`UPDATE qr_orders SET status = 'CLAIMED', owner = ?, owner_at = ?, tab_label = COALESCE(?, tab_label), updated_at = ? WHERE client_id = ? AND order_id = ? AND status = 'SUBMITTED' AND owner IS NULL`)
        .bind(actor, now, body.tabLabel ? clean(body.tabLabel, 80) : null, now, clientId, o.order_id),
      db.prepare(`INSERT INTO qr_order_events (client_id, order_id, at, actor, actor_kind, event, from_status, to_status, detail) SELECT ?, ?, ?, ?, 'staff', 'CLAIMED', 'SUBMITTED', 'CLAIMED', NULL WHERE changes() = 1`)
        .bind(clientId, o.order_id, now, actor),
    ]);
    const cur = await orderOf();
    if (!(r[0].meta && r[0].meta.changes === 1)) {
      const who = cur.owner ? `Already claimed by ${cur.owner}.` : `This order is already ${String(cur.status).toLowerCase()}.`;
      return reply({ ok: false, already: true, message: who, order: await shapeOrder(db, clientId, cur, { staff: true }) }, 409);
    }
    return reply({ ok: true, claimed: true, order: await shapeOrder(db, clientId, cur, { staff: true }) });
  }

  if (body.action === 'reject' || (body.action === 'decide' && !body.accept)) {
    const o = await orderOf();
    if (!o) return reply({ error: 'Order not found.' }, 404);
    const r = await db.batch([
      db.prepare(`UPDATE qr_orders SET status = 'REJECTED', updated_at = ? WHERE client_id = ? AND order_id = ? AND status = 'SUBMITTED'`).bind(now, clientId, o.order_id),
      db.prepare(`INSERT INTO qr_order_events (client_id, order_id, at, actor, actor_kind, event, from_status, to_status, detail) SELECT ?, ?, ?, ?, 'staff', 'REJECTED', 'SUBMITTED', 'REJECTED', ? WHERE changes() = 1`)
        .bind(clientId, o.order_id, now, actor, clean(body.reason, 140)),
    ]);
    const cur = await orderOf();
    if (!(r[0].meta && r[0].meta.changes === 1)) return reply({ ok: false, already: true, message: cur.owner ? `Already claimed by ${cur.owner}.` : `This order is already ${String(cur.status).toLowerCase()}.`, order: await shapeOrder(db, clientId, cur) }, 409);
    return reply({ ok: true, order: await shapeOrder(db, clientId, cur, { staff: true }) });
  }

  // the OWNER (or a supervisor who says so) manages the order from here
  const requireOwner = (o) => {
    if (!o.owner || o.owner === actor || (body.override && isManager)) return null;
    return reply({ ok: false, code: 'not_owner', message: `${o.owner} is responsible for this order — only they (or a supervisor) can do this.`, owner: o.owner }, 403);
  };

  if (body.action === 'link') {          // the claimed order became a round on a bill: remember the bill number (so the guest and the cashier see the same one)
    const o = await orderOf(); if (!o) return reply({ error: 'Order not found.' }, 404);
    const no = requireOwner(o); if (no) return no;
    const billNo = clean(body.billNo, 60);
    if (!billNo) return reply({ error: 'No bill number.' }, 400);
    await db.batch([
      db.prepare(`UPDATE qr_orders SET bill_id = COALESCE(bill_id, ?), tab_label = COALESCE(?, tab_label), updated_at = ? WHERE client_id = ? AND order_id = ?`).bind(billNo, body.tabLabel ? clean(body.tabLabel, 80) : null, now, clientId, o.order_id),
      eventStmt(db, clientId, o.order_id, actor, 'staff', 'LINKED_TO_BILL', o.status, o.status, { billNo, tabId: clean(body.tabId, 60) }),
    ]);
    return reply({ ok: true, order: await shapeOrder(db, clientId, await orderOf(), { staff: true }) });
  }

  if (body.action === 'status') {
    const o = await orderOf(); if (!o) return reply({ error: 'Order not found.' }, 404);
    const to = String(body.status || '');
    if (!ORDER_STATUSES.includes(to) || !(MOVES[o.status] || []).includes(to)) return reply({ error: `An order that is ${o.status.toLowerCase()} cannot be marked ${to.toLowerCase()}.` }, 400);
    // kitchen / bar staff move the preparation status (they are not the order's owner); the owner-only actions are billing ones
    const r = await db.batch([
      db.prepare(`UPDATE qr_orders SET status = ?, updated_at = ? WHERE client_id = ? AND order_id = ? AND status = ?`).bind(to, now, clientId, o.order_id, o.status),
      db.prepare(`INSERT INTO qr_order_events (client_id, order_id, at, actor, actor_kind, event, from_status, to_status, detail) SELECT ?, ?, ?, ?, 'staff', 'STATUS', ?, ?, ? WHERE changes() = 1`)
        .bind(clientId, o.order_id, now, actor, o.status, to, clean(body.reason, 140)),
    ]);
    if (!(r[0].meta && r[0].meta.changes === 1)) return reply({ ok: false, error: 'The order changed on another device — refresh.' }, 409);
    return reply({ ok: true, order: await shapeOrder(db, clientId, await orderOf(), { staff: true }) });
  }

  if (body.action === 'billPrinted') {
    // Printing the bill is the owner's job and changes nothing financial: no sale, no second order. Reprints are counted, not blocked.
    const o = await orderOf(); if (!o) return reply({ error: 'Order not found.' }, 404);
    const no = requireOwner(o); if (no) return no;
    if (TERMINAL.includes(o.status)) return reply({ ok: true, order: await shapeOrder(db, clientId, o) });
    const billable = ['CLAIMED', 'PREPARING', 'READY', 'SERVED'].includes(o.status);
    await db.batch([
      db.prepare(`UPDATE qr_orders SET status = CASE WHEN status IN ('CLAIMED', 'PREPARING', 'READY', 'SERVED') THEN 'BILLED' ELSE status END, printed_at = COALESCE(printed_at, ?), printed_by = COALESCE(printed_by, ?), updated_at = ? WHERE client_id = ? AND order_id = ?`)
        .bind(now, actor, now, clientId, o.order_id),
      eventStmt(db, clientId, o.order_id, actor, 'staff', billable ? 'BILL_PRINTED' : 'BILL_REPRINTED', o.status, billable ? 'BILLED' : o.status, { billNo: o.bill_id }),
    ]);
    return reply({ ok: true, order: await shapeOrder(db, clientId, await orderOf(), { staff: true }) });
  }

  if (body.action === 'decideRequest') {
    const rq = await first(db, `SELECT * FROM qr_order_requests WHERE client_id = ? AND req_id = ?`, clientId, clean(body.reqId, 40));
    if (!rq) return reply({ error: 'Request not found.' }, 404);
    const o = await first(db, `SELECT * FROM qr_orders WHERE client_id = ? AND order_id = ?`, clientId, rq.order_id);
    const no = requireOwner(o); if (no) return no;
    const approve = !!body.approve;
    const st = [db.prepare(`UPDATE qr_order_requests SET status = ?, decided_by = ?, decided_at = ? WHERE client_id = ? AND req_id = ? AND status = 'PENDING'`).bind(approve ? 'APPROVED' : 'DECLINED', actor, now, clientId, rq.req_id)];
    if (approve && rq.type === 'CANCEL') {
      st.push(db.prepare(`UPDATE qr_orders SET status = 'CANCELLED', cancel_requested = 0, updated_at = ? WHERE client_id = ? AND order_id = ? AND changes() = 1 AND status IN ('CLAIMED', 'PREPARING')`).bind(now, clientId, o.order_id));
    } else if (approve && rq.type === 'EXCHANGE') {
      const p = JSON.parse(rq.payload || '{}');
      const next = (await first(db, `SELECT COALESCE(MAX(line_no), -1) + 1 AS n FROM qr_order_items WHERE client_id = ? AND order_id = ?`, clientId, o.order_id)).n;
      st.push(db.prepare(`UPDATE qr_order_items SET removed = 1 WHERE client_id = ? AND order_id = ? AND line_no = ? AND changes() = 1`).bind(clientId, o.order_id, p.line));
      st.push(db.prepare(`INSERT INTO qr_order_items (client_id, order_id, line_no, code, name, base_name, qty, price, station, modifiers, note) SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', NULL WHERE changes() = 1`)
        .bind(clientId, o.order_id, next, p.toCode, p.toName, p.toName, p.qty, p.price));
      st.push(recalcTotal(db, clientId, o.order_id));
    }
    if (!approve && rq.type === 'CANCEL') st.push(db.prepare(`UPDATE qr_orders SET cancel_requested = 0, updated_at = ? WHERE client_id = ? AND order_id = ?`).bind(now, clientId, o.order_id));
    st.push(eventStmt(db, clientId, o.order_id, actor, 'staff', (approve ? 'APPROVED_' : 'DECLINED_') + rq.type, o.status, o.status, rq.payload));
    const r = await db.batch(st);
    if (!(r[0].meta && r[0].meta.changes === 1)) return reply({ ok: false, already: true, message: 'This request was already handled.' }, 409);
    return reply({ ok: true, order: await shapeOrder(db, clientId, await first(db, `SELECT * FROM qr_orders WHERE client_id = ? AND order_id = ?`, clientId, rq.order_id), { staff: true }), request: { ...rq, status: approve ? 'APPROVED' : 'DECLINED' } });
  }

  // The cashier confirms a guest's payment AGAINST A REAL SALE: the sale (made through the till's normal settlement, which is what the
  // ledger counts) must already be in D1 for this bill. The guest's typed code proves nothing by itself. Once per payment, however many
  // tills press the button.
  if (body.action === 'confirmPayment') {
    const pay = await first(db, `SELECT * FROM qr_order_payments WHERE client_id = ? AND pay_id = ?`, clientId, clean(body.payId, 40));
    if (!pay) return reply({ error: 'Payment not found.' }, 404);
    const o = await first(db, `SELECT * FROM qr_orders WHERE client_id = ? AND order_id = ?`, clientId, pay.order_id);
    if (pay.status === 'CONFIRMED') return reply({ ok: true, repeated: true, order: await shapeOrder(db, clientId, o, { staff: true }) });
    if (pay.status !== 'PENDING') return reply({ ok: false, error: `This payment was ${pay.status.toLowerCase()}.` }, 409);
    const saleId = clean(body.saleId, 80);
    const sale = saleId ? await first(db, `SELECT * FROM ledger_sales WHERE client_id = ? AND sale_id = ? AND status = 'COMPLETED'`, clientId, saleId) : null;
    if (!sale) return reply({ ok: false, pending: true, code: 'sale_not_in_ledger', error: 'The payment has not reached the transaction database yet — it will be confirmed as soon as the sale syncs. Nothing is lost.' }, 202);
    const st = [
      // the sale must cover this amount on top of what other guests' payments already claimed from it
      db.prepare(`UPDATE qr_order_payments SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = ?, payment_id = ? WHERE client_id = ? AND pay_id = ? AND status = 'PENDING'
        AND ? + (SELECT COALESCE(SUM(amount), 0) FROM qr_order_payments WHERE client_id = ? AND payment_id = ? AND status = 'CONFIRMED') <= (SELECT total FROM ledger_sales WHERE client_id = ? AND sale_id = ?) + 0.004`)
        .bind(actor, now, `sale:${saleId}`, clientId, pay.pay_id, pay.amount, clientId, `sale:${saleId}`, clientId, saleId),
      db.prepare(`INSERT INTO qr_order_events (client_id, order_id, at, actor, actor_kind, event, from_status, to_status, detail) SELECT ?, ?, ?, ?, 'staff', 'PAYMENT_CONFIRMED', ?, ?, ? WHERE changes() = 1`)
        .bind(clientId, o.order_id, now, actor, o.status, o.status, JSON.stringify({ payId: pay.pay_id, saleId, amount: pay.amount, method: pay.method, code: pay.mpesa_code })),
      // fully paid -> PAID (the order's confirmed payments cover its total)
      db.prepare(`UPDATE qr_orders SET status = 'PAID', updated_at = ? WHERE client_id = ? AND order_id = ? AND status IN ('CLAIMED', 'PREPARING', 'READY', 'SERVED', 'BILLED')
        AND (SELECT COALESCE(SUM(amount), 0) FROM qr_order_payments WHERE client_id = ? AND order_id = ? AND status = 'CONFIRMED') >= total - 0.004`).bind(now, clientId, o.order_id, clientId, o.order_id),
    ];
    const r = await db.batch(st);
    const cur = await first(db, `SELECT * FROM qr_orders WHERE client_id = ? AND order_id = ?`, clientId, o.order_id);
    if (!(r[0].meta && r[0].meta.changes === 1)) {
      const now2 = await first(db, `SELECT status FROM qr_order_payments WHERE client_id = ? AND pay_id = ?`, clientId, pay.pay_id);
      if (now2 && now2.status === 'CONFIRMED') return reply({ ok: true, repeated: true, order: await shapeOrder(db, clientId, cur, { staff: true }) });     // another till confirmed it a moment ago
      return reply({ ok: false, code: 'sale_too_small', error: `That sale (${sale.total}) does not cover this payment on top of the ones already matched to it.` }, 409);
    }
    return reply({ ok: true, confirmed: true, order: await shapeOrder(db, clientId, cur, { staff: true }) });
  }
  if (body.action === 'rejectPayment') {
    const r = await db.batch([
      db.prepare(`UPDATE qr_order_payments SET status = 'REJECTED', confirmed_by = ?, confirmed_at = ? WHERE client_id = ? AND pay_id = ? AND status = 'PENDING'`).bind(actor, now, clientId, clean(body.payId, 40)),
    ]);
    return reply({ ok: r[0].meta && r[0].meta.changes === 1 });
  }

  // SETTLE: the till closed the bill for these orders (a real sale, already in the ledger). Orders -> PAID; a guest's still-unmatched payment
  // note for them is marked SUPERSEDED (the cashier took the money at the till instead) so nothing dangles. Once only: a repeat changes nothing.
  if (body.action === 'settle') {
    const saleId = clean(body.saleId, 80);
    const ids = (Array.isArray(body.orderIds) ? body.orderIds : []).map((x) => clean(x, 40)).filter(Boolean).slice(0, 50);
    if (!ids.length || !saleId) return reply({ error: 'Nothing to settle.' }, 400);
    const sale = await first(db, `SELECT sale_id FROM ledger_sales WHERE client_id = ? AND sale_id = ? AND status = 'COMPLETED'`, clientId, saleId);
    if (!sale) return reply({ ok: false, pending: true, code: 'sale_not_in_ledger', error: 'The sale has not reached the transaction database yet — try again in a moment.' }, 202);
    const st = [];
    for (const id of ids) {
      st.push(db.prepare(`UPDATE qr_order_payments SET status = 'SUPERSEDED', confirmed_by = ?, confirmed_at = ? WHERE client_id = ? AND order_id = ? AND status = 'PENDING'`).bind(actor, now, clientId, id));
      st.push(db.prepare(`UPDATE qr_orders SET status = 'PAID', updated_at = ? WHERE client_id = ? AND order_id = ? AND status IN ('CLAIMED', 'PREPARING', 'READY', 'SERVED', 'BILLED')`).bind(now, clientId, id));
      st.push(db.prepare(`INSERT INTO qr_order_events (client_id, order_id, at, actor, actor_kind, event, from_status, to_status, detail) SELECT ?, ?, ?, ?, 'staff', 'SETTLED_AT_TILL', NULL, 'PAID', ? WHERE changes() = 1`).bind(clientId, id, now, actor, JSON.stringify({ saleId })));
    }
    await db.batch(st);
    poke(context, clientId, 'payment');
    return reply({ ok: true, settled: ids.length });
  }

  // RELEASE a table / room when its service is complete: back to AVAILABLE, and a NEW session id so an old QR session, cart or order
  // cannot follow the previous guest into the next one. Refused while an order there is still being served or is unpaid.
  if (body.action === 'release') {
    const loc = await findLoc();
    if (!loc) return reply({ error: 'No such place.' }, 404);
    const open = await all(db, `SELECT order_id, status, total FROM qr_orders WHERE client_id = ? AND loc_id = ? AND session_id = ? AND status IN ('CLAIMED', 'PREPARING', 'READY', 'SERVED', 'BILLED')`, clientId, loc.loc_id, loc.session_id);
    if (open.length && !(body.force && isManager)) return reply({ ok: false, code: 'open_orders', error: `${open.length} order${open.length > 1 ? 's are' : ' is'} still open at ${loc.label} — finish or cancel ${open.length > 1 ? 'them' : 'it'} first.`, open }, 409);
    const st = [
      db.prepare(`UPDATE qr_orders SET status = 'CANCELLED', updated_at = ? WHERE client_id = ? AND loc_id = ? AND session_id = ? AND status = 'SUBMITTED'`).bind(now, clientId, loc.loc_id, loc.session_id),
      db.prepare(`UPDATE qr_locations SET state = 'AVAILABLE', session_id = ?, released_at = ? WHERE client_id = ? AND loc_id = ?`).bind(newId('ses_'), now, clientId, loc.loc_id),
    ];
    await db.batch(st);
    return reply({ ok: true, code: locOut(await first(db, `SELECT * FROM qr_locations WHERE client_id = ? AND loc_id = ?`, clientId, loc.loc_id)) });
  }

  return reply({ error: 'Unknown action.' }, 400);
}
