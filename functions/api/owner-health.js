// functions/api/owner-health.js — Cloudflare Pages Function (Owner Console). #10/#11/#12 (zip 120): one health check for every shop.
//
//   GET  ?offset=0&limit=25          (owner signed in)  -> { shops: [...], next, total, release }
//   GET  ?cron=1                     (the router's daily trigger: X-Router-Secret = ROUTER_SHARED_SECRET) — checks every shop and
//                                     emails the owner ONLY when something needs attention (and stores the result either way)
//   POST { action: 'mode', clientId, mode: 'open'|'paired' }  (owner signed in) — e.g. to let a shop that locked itself out sync again
//
// Per shop: stock integrity (ledgerIntegrity: history chains, figures match, nothing applied twice), items below zero, the device
// pairing mode, the devices that sync it (how many, which run an older app release, which have not synced for 3+ days), and the
// data size with a "move to its own database" suggestion for big single-record shops.

import { requireOwnerAuth, getOwnerAccount } from './_owner-auth.js';
import { listClientSummaries } from './_license.js';
import { readStateRaw, shopMode, shopCall } from './_state-store.js';
import { ledgerIntegrity } from './_merge.js';
import { readDeviceAuth, writeDeviceAuth } from './_device-auth.js';
import { sendEmail } from './_email.js';

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const LAST_KEY = 'owner-health:last';
const MOVE_AT = 4 * 1048576;                                   // single-record shops above ~4 MB: suggest their own database

export async function shopHealth(env, shop) {
  const out = { id: shop.id, label: shop.businessName || shop.label || shop.slug || shop.id, problems: [] };
  try {
    const mode = await shopMode(env, shop.id);
    out.storage = mode === 'do' ? 'database' : 'single record';
    let state = {};
    if (mode === 'do') {
      const res = await shopCall(env, shop.id, 'export', {});
      const text = res.ok ? await res.text() : '{}';
      out.bytes = text.length; state = JSON.parse(text);
    } else {
      const raw = await readStateRaw(env, 'pos-data:state:' + shop.id);
      out.bytes = raw ? raw.text.length : 0; state = raw ? JSON.parse(raw.text) : {};
    }
    const integ = ledgerIntegrity(state);
    out.integrity = { ok: integ.ok, checked: integ.checked, problems: integ.problems.slice(0, 5) };
    if (!integ.ok) out.problems.push(`stock history: ${integ.problems.length} problem(s)`);
    out.belowZero = (Array.isArray(state.inventory) ? state.inventory : []).filter((r) => r && !r._deleted && (Number(r.qty) < 0 || Number(r.pieceQty) < 0)).length;
    if (out.belowZero) out.problems.push(`${out.belowZero} item(s) below zero — a stock take is due`);
    const reg = state.deviceRegistry || {};
    const devices = Object.entries(reg).map(([id, d]) => ({ id, till: d.till || null, v: d.v || '', lastSeen: d.lastSeen || 0 }));
    const newest = devices.map((d) => d.v).filter(Boolean).sort().pop() || '';
    out.devices = { n: devices.length, olderRelease: devices.filter((d) => d.v && d.v !== newest).length, silent: devices.filter((d) => d.lastSeen && Date.now() - d.lastSeen > 3 * 86400000).length, newest };
    if (out.devices.olderRelease) out.problems.push(`${out.devices.olderRelease} device(s) on an older app release`);
    out.pairing = (await readDeviceAuth(env, shop.id, { fresh: true })).mode;
    out.suggestDatabase = mode !== 'do' && out.bytes > MOVE_AT;
    if (out.suggestDatabase) out.problems.push('large shop — move it to its own database (💾 Storage)');
  } catch (e) {
    out.error = String(e && e.message || e);
    out.problems.push('could not be checked: ' + out.error);
  }
  return out;
}

async function paidShops(env) {
  const [summaries, owner] = await Promise.all([listClientSummaries(env, {}), getOwnerAccount(env).catch(() => null)]);
  const ownId = owner && owner.ownerClientId;
  return summaries.filter((s) => s && s.type === 'permanent' && s.id !== ownId);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const u = new URL(request.url);
  const cron = u.searchParams.get('cron') === '1' && env.ROUTER_SHARED_SECRET && request.headers.get('X-Router-Secret') === env.ROUTER_SHARED_SECRET;
  if (!cron && !(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  const shops = await paidShops(env);
  if (cron) {
    const results = [];
    for (const s of shops) results.push(await shopHealth(env, s));
    const bad = results.filter((r) => r.problems.length);
    await env.mydukapos_kv.put(LAST_KEY, JSON.stringify({ at: Date.now(), total: results.length, bad: bad.length, shops: bad.slice(0, 100) }));
    let emailed = false;
    const owner = await getOwnerAccount(env).catch(() => null);
    const to = owner && /@/.test(String(owner.identifier || '')) ? owner.identifier : '';
    if (bad.length && to) {
      const rows = bad.map((r) => `<li><strong>${String(r.label).replace(/[<>&]/g, '')}</strong>: ${r.problems.map((p) => String(p).replace(/[<>&]/g, '')).join('; ')}</li>`).join('');
      const sent = await sendEmail(env, { to, subject: `mydukapos: ${bad.length} shop(s) need attention`, html: `<p>Daily health check of ${results.length} shops:</p><ul>${rows}</ul><p>Details: Owner Console ▸ 🩺 Health.</p>` });
      emailed = !!(sent && sent.ok);
    }
    return json({ ok: true, total: results.length, bad: bad.length, emailed });
  }
  const offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
  const limit = Math.min(50, Math.max(1, Number(u.searchParams.get('limit')) || 25));
  const page = shops.slice(offset, offset + limit);
  const results = [];
  for (const s of page) results.push(await shopHealth(env, s));
  let last = null;
  try { last = JSON.parse((await env.mydukapos_kv.get(LAST_KEY)) || 'null'); } catch (e) { /* none */ }
  return json({ shops: results, total: shops.length, next: offset + limit < shops.length ? offset + limit : null, lastDaily: last ? { at: last.at, total: last.total, bad: last.bad } : null });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  let body; try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400); }
  if (body.action === 'mode' && body.clientId) {
    const rec = await readDeviceAuth(env, String(body.clientId), { fresh: true });
    rec.mode = body.mode === 'paired' ? 'paired' : 'open';
    await writeDeviceAuth(env, String(body.clientId), rec);
    return json({ ok: true, mode: rec.mode });
  }
  return json({ error: 'Unknown action.' }, 400);
}
