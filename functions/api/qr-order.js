// functions/api/qr-order.js — Cloudflare Pages Function. zip 136: secure QR / barcode ordering for tables, rooms, poolside
// seats, cabanas and any other location.
//
// SECURITY MODEL
//  * A QR code carries only a random 192-bit token (never "/table/12"): nothing in it can be edited to reach another table,
//    room, branch or business. The token is looked up server-side; the record says which shop and which location it is.
//  * The token must belong to the shop the request is for (the shop's own link / subdomain): a token of business A presented on
//    business B's link is "not found". Revoked, disabled or expired tokens are "not found" too (no hint which).
//  * Customers can only read the menu the shop PUBLISHED (names, prices, photos; no stock, costs or anything internal) and place
//    an order into a waiting list. Prices are the published ones — whatever the phone sends as a price is ignored.
//  * Every order is idempotent (the page sends a key: a double tap or a retry is ONE order) and rate-limited per code and per
//    shop. Nothing is charged and no stock moves until staff accept the order on a till, where it becomes an ordinary order
//    (kitchen / bar tickets, the bill) — a customer can never perform a financial action.
//  * Managing codes (create, revoke, regenerate, publish the menu, see and accept orders) needs the shop's licence and, where the
//    shop requires it, a paired device — the same rule as every other staff action.
//
// PUBLIC (customer phone, no app):
//   GET  /api/qr-order?t=<token>                  -> { business, location: { label, kind }, menu, open }
//   GET  /api/qr-order?t=<token>&o=<orderId>      -> { order: { id, status, items, total, createdAt, updates } }
//   POST /api/qr-order  { action:'order', t, key, items:[{ code, qty, modifiers:[names], note }], name?, phone?, note? }
// STAFF (a till):
//   POST { action:'list' } | { action:'create', kind, label, expiresAt? } | { action:'revoke', token } | { action:'regenerate', token }
//        { action:'publishMenu', menu } | { action:'pending' } | { action:'decide', orderId, accept, reason?, tabLabel? }
//        { action:'status', orderId, status }
import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { staffGuard } from './_staff-auth.js';
import { deviceGuard } from './_device-auth.js';
import { checkRateLimit, rateLimitResponse } from './_ratelimit.js';

export const QR_KINDS = ['table', 'room', 'pool', 'cabana', 'facility', 'location'];
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const MAX_ITEMS = 40, MAX_QTY = 50;
const ORDER_STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED'];

const kv = (env) => env.mydukapos_kv;
const tokKey = (t) => `qr:tok:${t}`;
const listKey = (c) => `qr:list:${c}`;
const menuKey = (c) => `qr:menu:${c}`;
const ordKey = (c, id) => `qr:ord:${c}:${id}`;
const queueKey = (c) => `qr:queue:${c}`;
const idemKey = (c, k) => `qr:idem:${c}:${k}`;

export function newToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
async function getJson(env, key, dflt) { const raw = await kv(env).get(key); if (!raw) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
const putJson = (env, key, v, opts) => kv(env).put(key, JSON.stringify(v), opts);

// A token record, only if it is usable for this shop right now.
async function liveToken(env, token, clientId) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const rec = await getJson(env, tokKey(token), null);
  if (!rec || rec.clientId !== clientId || rec.active !== true) return null;
  if (rec.expiresAt && Date.now() > rec.expiresAt) return null;
  return rec;
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ error: 'This business is not taking orders here right now.' }, 404);
  const u = new URL(request.url);
  const tok = await liveToken(env, u.searchParams.get('t'), license.clientId);
  if (!tok) return reply({ error: 'This code is not valid any more. Please ask a member of staff.' }, 404);
  const o = u.searchParams.get('o');
  if (o) {
    const ord = await getJson(env, ordKey(license.clientId, clean(o, 40)), null);
    if (!ord || ord.token !== tok.token) return reply({ error: 'Order not found.' }, 404);
    return reply({ order: { id: ord.id, status: ord.status, items: ord.items, total: ord.total, createdAt: ord.createdAt, updates: ord.updates || [], location: ord.label } });
  }
  const menu = await getJson(env, menuKey(license.clientId), null);
  return reply({ business: (menu && menu.business) || '', location: { label: tok.label, kind: tok.kind }, open: !!(menu && menu.open !== false && (menu.items || []).length), menu: menu ? { categories: menu.categories || [], items: (menu.items || []).filter((i) => i.available !== false), modifierGroups: menu.modifierGroups || [], note: menu.note || '', currency: 'KES' } : null });
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

  /* ---------- customer: place an order ---------- */
  if (body.action === 'order') {
    const tok = await liveToken(env, body.t, clientId);
    if (!tok) return reply({ error: 'This code is not valid any more. Please ask a member of staff.' }, 404);
    const key = clean(body.key, 64);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) return reply({ error: 'Invalid request.' }, 400);
    const prior = await kv(env).get(idemKey(clientId, key));
    if (prior) { const ord = await getJson(env, ordKey(clientId, prior), null); if (ord && ord.token === tok.token) return reply({ ok: true, orderId: ord.id, status: ord.status, total: ord.total, repeated: true }); }
    const rlTok = await checkRateLimit(env, 'qrtok', tok.token);
    if (!rlTok.ok) return rateLimitResponse('orders from this code', rlTok, cors);
    const rlShop = await checkRateLimit(env, 'qr', clientId);
    if (!rlShop.ok) return rateLimitResponse('QR orders', rlShop, cors);
    const menu = await getJson(env, menuKey(clientId), null);
    if (!menu || menu.open === false) return reply({ error: 'Ordering by phone is closed right now. Please ask a member of staff.' }, 409);
    const byCode = new Map((menu.items || []).map((i) => [String(i.code), i]));
    const groups = new Map((menu.modifierGroups || []).map((g) => [g.id, g]));
    const raw = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
    if (!raw.length) return reply({ error: 'Your order is empty.' }, 400);
    const items = [];
    for (const r of raw) {
      const it = byCode.get(String(r && r.code));
      if (!it || it.available === false) return reply({ error: `"${clean(r && r.name, 60) || 'An item'}" is not available any more.`, code: 'unavailable' }, 409);
      const qty = Math.floor(Number(r.qty));
      if (!(qty >= 1 && qty <= MAX_QTY)) return reply({ error: 'Check the quantities.' }, 400);
      // modifiers: only the published ones of this item's groups, at the published price
      const mods = [];
      const want = new Set((Array.isArray(r.modifiers) ? r.modifiers : []).map((x) => String(x)));
      for (const gid of it.modifierGroupIds || []) {
        const g = groups.get(gid); if (!g) continue;
        const chosen = (g.options || []).filter((o) => want.has(o.name));
        if (g.required && !chosen.length) return reply({ error: `Choose ${g.name} for ${it.name}.` }, 400);
        if (g.max && chosen.length > g.max) return reply({ error: `${g.name}: at most ${g.max}.` }, 400);
        chosen.forEach((o) => mods.push({ group: g.name, name: o.name, price: Math.max(0, Number(o.price) || 0) }));
      }
      const unit = Math.round((Number(it.price) + mods.reduce((s, m) => s + m.price, 0)) * 100) / 100;
      items.push({ code: String(it.code), name: it.name + (mods.length ? ` (${mods.map((m) => m.name).join(', ')})` : ''), baseName: it.name, qty, price: unit, modifiers: mods, note: clean(r.note, 140) });
    }
    const total = Math.round(items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100;
    const id = 'qo-' + newToken().slice(0, 16);
    const ord = { id, token: tok.token, kind: tok.kind, label: tok.label, items, total, name: clean(body.name, 60), phone: clean(body.phone, 20), note: clean(body.note, 200), status: 'PENDING', createdAt: Date.now(), updates: [] };
    await putJson(env, ordKey(clientId, id), ord, { expirationTtl: 3 * 24 * 3600 });
    await kv(env).put(idemKey(clientId, key), id, { expirationTtl: 24 * 3600 });
    const q = await getJson(env, queueKey(clientId), []);
    q.push(id);
    await putJson(env, queueKey(clientId), q.slice(-300));
    return reply({ ok: true, orderId: id, status: ord.status, total });
  }

  /* ---------- staff actions: licence + paired device ---------- */
  const denied = await deviceGuard(request, env, clientId, cors);
  if (denied) return denied;
  // zip 141: when the shop requires staff sessions, a staff action needs a signed-in staff member — and managing codes / the menu
  // needs the "orders.manage" permission (supervisors, managers, the Admin). Otherwise unchanged; `by` comes from the session if any.
  const need = ['create', 'revoke', 'regenerate', 'publishMenu'].includes(body.action) ? 'orders.manage' : null;
  const sg = await staffGuard(request, env, clientId, need, cors);
  if (sg.denied) return sg.denied;
  if (sg.claims) body.by = sg.claims.name;
  const list = await getJson(env, listKey(clientId), []);
  const saveList = (l) => putJson(env, listKey(clientId), l);

  if (body.action === 'list') return reply({ codes: list });

  if (body.action === 'create') {
    const kind = QR_KINDS.includes(body.kind) ? body.kind : 'location';
    const label = clean(body.label, 60);
    if (!label) return reply({ error: 'Name the table / room / location.' }, 400);
    if (list.some((c) => c.active && c.label === label && c.kind === kind)) return reply({ error: 'That location already has an active code — regenerate it instead.' }, 409);
    const token = newToken();
    const rec = { token, clientId, kind, label, active: true, createdAt: Date.now(), createdBy: clean(body.by, 60), expiresAt: Number(body.expiresAt) > Date.now() ? Number(body.expiresAt) : null };
    await putJson(env, tokKey(token), rec);
    list.push({ token, kind, label, active: true, createdAt: rec.createdAt, createdBy: rec.createdBy, expiresAt: rec.expiresAt });
    await saveList(list);
    return reply({ ok: true, code: list[list.length - 1] });
  }

  if (body.action === 'revoke' || body.action === 'regenerate') {
    const entry = list.find((c) => c.token === body.token && c.active);
    if (!entry) return reply({ error: 'No such active code.' }, 404);
    const rec = await getJson(env, tokKey(entry.token), null);
    if (rec) { rec.active = false; rec.revokedAt = Date.now(); rec.revokedBy = clean(body.by, 60); await putJson(env, tokKey(entry.token), rec, { expirationTtl: 30 * 24 * 3600 }); }
    entry.active = false; entry.revokedAt = Date.now(); entry.revokedBy = clean(body.by, 60);
    let created = null;
    if (body.action === 'regenerate') {
      const token = newToken();
      await putJson(env, tokKey(token), { token, clientId, kind: entry.kind, label: entry.label, active: true, createdAt: Date.now(), createdBy: clean(body.by, 60), expiresAt: entry.expiresAt || null });
      created = { token, kind: entry.kind, label: entry.label, active: true, createdAt: Date.now(), createdBy: clean(body.by, 60), expiresAt: entry.expiresAt || null, replaces: entry.token };
      list.push(created);
    }
    await saveList(list.filter((c) => c.active || Date.now() - (c.revokedAt || 0) < 30 * 24 * 3600 * 1000));
    return reply({ ok: true, code: created });
  }

  if (body.action === 'publishMenu') {
    const m = body.menu || {};
    const items = (Array.isArray(m.items) ? m.items : []).slice(0, 2000).map((i) => ({
      code: clean(i.code, 60), name: clean(i.name, 80), price: Math.max(0, Math.round((Number(i.price) || 0) * 100) / 100), category: clean(i.category, 40),
      description: clean(i.description, 200), image: /^\/api\/media\?k=p&id=[A-Za-z0-9_-]{6,80}$/.test(String(i.image || '')) ? String(i.image) : '',
      available: i.available !== false, modifierGroupIds: (Array.isArray(i.modifierGroupIds) ? i.modifierGroupIds : []).map((x) => clean(x, 60)).slice(0, 10),
    })).filter((i) => i.code && i.name);
    const modifierGroups = (Array.isArray(m.modifierGroups) ? m.modifierGroups : []).slice(0, 100).map((g) => ({ id: clean(g.id, 60), name: clean(g.name, 60), required: !!g.required, max: Math.max(0, Number(g.max) || 0), options: (g.options || []).slice(0, 30).map((o) => ({ name: clean(o.name, 60), price: Math.max(0, Number(o.price) || 0) })) }));
    const menu = { business: clean(m.business, 80), open: m.open !== false, note: clean(m.note, 300), categories: Array.from(new Set(items.map((i) => i.category).filter(Boolean))), items, modifierGroups, publishedAt: Date.now() };
    await putJson(env, menuKey(clientId), menu);
    return reply({ ok: true, items: items.length });
  }

  if (body.action === 'pending') {
    // The queue is the fast path; the order records themselves are also listed, so an order whose queue entry was lost to two
    // customers ordering at the same instant (KV has no atomic append) is still found.
    const ids = new Set(await getJson(env, queueKey(clientId), []));
    try {
      let cursor;
      for (let i = 0; i < 10; i++) {
        const page = await kv(env).list({ prefix: `qr:ord:${clientId}:`, cursor });
        (page.keys || []).forEach((k) => ids.add(k.name.slice(`qr:ord:${clientId}:`.length)));
        if (page.list_complete || !page.cursor) break;
        cursor = page.cursor;
      }
    } catch (e) { /* the queue alone */ }
    const out = [];
    for (const id of ids) { const o = await getJson(env, ordKey(clientId, id), null); if (o && o.status === 'PENDING') out.push(o); }
    out.sort((a, b) => a.createdAt - b.createdAt);
    await putJson(env, queueKey(clientId), out.map((o) => o.id));
    return reply({ orders: out });
  }

  if (body.action === 'decide' || body.action === 'status') {
    const id = clean(body.orderId, 40);
    const o = await getJson(env, ordKey(clientId, id), null);
    if (!o) return reply({ error: 'Order not found.' }, 404);
    let status;
    if (body.action === 'decide') {
      if (o.status !== 'PENDING') return reply({ ok: true, order: o, already: true });           // two tills accepting at once: once
      status = body.accept ? 'ACCEPTED' : 'REJECTED';
      if (body.tabLabel) o.tabLabel = clean(body.tabLabel, 80);
    } else {
      status = String(body.status || '');
      if (!ORDER_STATUSES.includes(status) || o.status === 'PENDING' || o.status === 'REJECTED') return reply({ error: 'Invalid status.' }, 400);
    }
    o.status = status;
    o.updates = (o.updates || []).concat([{ status, at: Date.now(), by: clean(body.by, 60), reason: clean(body.reason, 140) }]).slice(-20);
    await putJson(env, ordKey(clientId, id), o, { expirationTtl: 3 * 24 * 3600 });
    return reply({ ok: true, order: o });
  }

  return reply({ error: 'Unknown action.' }, 400);
}
