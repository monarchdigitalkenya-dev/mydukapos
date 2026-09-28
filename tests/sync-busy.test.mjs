import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, until } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';
import { openDevice, closeWhenIdle } from './e2e-harness.mjs';

// Zip 123: "Sync: send failed — the server refused or was busy" with several devices (phone + computer). Real Cloudflare KV accepts
// about ONE write a second to the same record; a second device saving in that second got an error (and the server crashed on it).
const sync = await import(pathToFileURL(path.join(ROOT, 'functions/api/pos-sync.js')).href);

// KV that behaves like the real one: a second write to the same key within 1 s is refused (429).
function strictKV() {
  const kv = makeKV(); const last = new Map(); const put = kv.put.bind(kv);
  kv.refused = 0;
  kv.put = async (k, v, o) => {
    await new Promise((r) => setTimeout(r, 5));
    if (k.startsWith('pos-data:state:') && Date.now() - (last.get(k) || 0) < 1000) { kv.refused++; throw new Error('KV PUT failed: 429 Too Many Requests'); }
    last.set(k, Date.now()); return put(k, v, o);
  };
  return kv;
}
const req = (m, b) => new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: m, body: b ? JSON.stringify(b) : undefined, headers: { 'content-type': 'application/json' } });
const sale = (id, dev) => ({ id, timestamp: new Date().toISOString(), paymentMethod: 'cash', total: 100, items: [{ code: 'A', qty: 1, price: 100 }], _dev: dev });

test('two devices saving in the same second: both succeed and both sales are kept (no "refused or busy")', async () => {
  const kv = strictKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv }; const waits = [];
  const push = (b) => sync.onRequestPost({ request: req('POST', { businessName: 'Biz', updatedAt: Date.now(), ...b }), env, waitUntil: (p) => waits.push(p) });
  await push({ salesLog: [] }); await new Promise((r) => setTimeout(r, 1100));
  const [a, b, c] = await Promise.all([
    push({ _till: 'phone', salesLog: [sale('s-phone', 'phone')] }),
    push({ _till: 'computer', salesLog: [sale('s-computer', 'computer')] }),
    push({ _till: 'tablet', salesLog: [sale('s-tablet', 'tablet')] }),
  ]);
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
  assert.ok(kv.refused >= 1, 'the storage really did refuse a write (the situation users hit)');
  const st = await (await sync.onRequestGet({ request: req('GET'), env })).json();
  assert.deepEqual(st.salesLog.map((s) => s.id).sort(), ['s-computer', 's-phone', 's-tablet'], 'nothing overwritten');
});

test('storage failing outright: a clean "busy, retry in 2 s" (503 + Retry-After), never a crash', async () => {
  const kv = makeKV(); seedShop(kv, 'C1');
  kv.put = async () => { throw new Error('KV PUT failed: 500'); };
  const res = await sync.onRequestPost({ request: req('POST', { salesLog: [sale('x')] }), env: { mydukapos_kv: kv }, waitUntil() {} });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('Retry-After'), '2');
  assert.equal((await res.json()).code, 'busy');
  kv.get = async () => { throw new Error('KV GET failed'); };
  const g = await sync.onRequestGet({ request: req('GET'), env: { mydukapos_kv: kv } });
  assert.equal(g.status, 503);
});

test('a shop with several devices moves to its own database by itself — verified, nothing lost', { skip: !hasSqlite && 'node:sqlite missing' }, async () => {
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv, SHOP_STORE: await makeBinding(), MIGRATE_SETTLE_MS: 10 };
  const waits = [];
  const push = (b) => sync.onRequestPost({ request: req('POST', { businessName: 'Biz', updatedAt: Date.now(), ...b }), env, waitUntil: (p) => waits.push(p) });
  assert.equal((await push({ _till: 'phone', salesLog: [sale('s1')] })).status, 200);
  assert.equal(waits.length, 0, 'one device: stays as it is');
  assert.equal((await push({ _till: 'computer', salesLog: [sale('s2')] })).status, 200);
  await Promise.all(waits);
  assert.equal(await kv.get('pos-data:mode:C1'), 'do', 'moved to its own database');
  const st = await (await sync.onRequestGet({ request: req('GET'), env })).json();
  assert.deepEqual(st.salesLog.map((s) => s.id).sort(), ['s1', 's2']);
  // and from now on saves go straight to it, one after the other, however many arrive at once
  const rs = await Promise.all(['s3', 's4', 's5', 's6'].map((id, i) => push({ _till: 'dev' + i, salesLog: [sale(id)] })));
  assert.ok(rs.every((r) => r.status === 200));
  const st2 = await (await sync.onRequestGet({ request: req('GET'), env })).json();
  assert.equal(st2.salesLog.length, 6);
});

test('the app: a "busy" answer is sent again by itself within seconds, logged once, and nothing is lost', async () => {
  let refuse = 2;
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv };
  const f = async (url, opts = {}) => {
    const u = new URL(String(url), 'https://shop.mydukapos.store');
    if (!u.pathname.endsWith('/api/pos-sync')) return new Response('{}', { status: 404 });
    const method = (opts.method || 'GET').toUpperCase();
    if (method === 'POST' && refuse > 0) { refuse--; return new Response('{"code":"busy"}', { status: 503, headers: { 'Retry-After': '1', 'content-type': 'application/json' } }); }
    const r = new Request('https://x.pages.dev/api/pos-sync?c=C1' + (u.search ? '&' + u.search.slice(1) : ''), { method, body: opts.body, headers: { 'content-type': 'application/json' } });
    return (method === 'POST' ? sync.onRequestPost : sync.onRequestGet)({ request: r, env, waitUntil() {} });
  };
  const inv = [{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }];
  const d = await openDevice('index.html', { fetch: f }, { pos_inventory: JSON.stringify(inv), pos_biz_name: 'Biz' });
  d.w.eval("showToast = function () {}; window.__pushBusyRetryMs = 50");
  d.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); d.w.document.getElementById('cash-tendered-input').value = '1000';
  await d.w.eval('checkoutCart()');
  const stored = () => JSON.parse(kv.data.get('pos-data:state:C1')?.value || '{}');
  assert.ok(await until(() => (stored().salesLog || []).length === 1, 15000), 'the sale reached the server without anyone doing anything');
  const journal = d.w.localStorage.getItem('pos_sync_journal_v1') || '[]';
  const failed = JSON.parse(journal).filter((e) => e.kind === 'failed');
  assert.ok(failed.length <= 1, 'at most one "failed" line for the whole episode');
  await closeWhenIdle(d);
});

test('phone + computer selling at the same time on real apps: every sale reaches the server, both end up agreeing', async () => {
  const { makeServer } = await import('./e2e-harness.mjs');
  const s = makeServer();
  const last = new Map(); const put = s.kv.put.bind(s.kv); let refused = 0;
  s.kv.put = async (k, v, o) => {                                      // the real 1-write-a-second limit
    await new Promise((r) => setTimeout(r, 5));
    if (k.startsWith('pos-data:state:') && Date.now() - (last.get(k) || 0) < 1000) { refused++; throw new Error('KV PUT failed: 429 Too Many Requests'); }
    last.set(k, Date.now()); return put(k, v, o);
  };
  const inv = [{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }];
  const phone = await openDevice('index.html', s, { pos_inventory: JSON.stringify(inv), pos_biz_name: 'Biz' });
  await phone.w.eval('pushNow()');
  const computer = await openDevice('index.html', s, { pos_inventory: JSON.stringify(inv), pos_biz_name: 'Biz' });
  await computer.w.eval('pullState()');
  for (const d of [phone, computer]) d.w.eval("showToast = function () {}; window.__pushBusyRetryMs = 100");
  const sell = async (d) => { d.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); d.w.document.getElementById('cash-tendered-input').value = '1000'; await d.w.eval('checkoutCart()'); };
  for (let i = 0; i < 3; i++) await Promise.all([sell(phone), sell(computer)]);            // 6 sales, pairs at the same instant
  const sales = () => (s.serverState().salesLog || []).length;
  assert.ok(await until(() => sales() === 6, 30000), 'all 6 sales on the server (got ' + sales() + ')');
  assert.ok(refused >= 1, 'the storage really refused writes along the way');
  assert.ok(await until(async () => { await phone.w.eval('pullState()'); await computer.w.eval('pullState()'); return phone.w.eval('salesLog.length') === 6 && computer.w.eval('salesLog.length') === 6; }, 20000), 'both devices show all 6');
  assert.equal(s.serverState().inventory.find((i) => i.code === 'A').qty, 44, 'stock 50 - 6, each sale once');
  await closeWhenIdle(phone); await closeWhenIdle(computer);   // not in the middle of their own sync
});
