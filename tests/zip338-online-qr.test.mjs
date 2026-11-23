import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';
import { recordPush } from '../functions/api/_ledger.js';

// Zip 338: the public order-from-home code (kind 'online') on real SQL. (reuses the zip 153 harness)
// Zip 153 — the QR ordering state machine on REAL SQL (node:sqlite behind a D1-shaped fake): atomic claim, cancel, exchange, guest payments,
// cashier confirmation against a real sale, settle, release / session rotation. (Master prompt §QR tests, §payments tests.)
const mod = await import(pathToFileURL(path.join(ROOT, 'functions/api/qr-order.js')).href);
const call = async (env, body, by) => { const r = await mod.onRequestPost({ request: new Request('https://x.pages.dev/api/qr-order?c=C1', { method: 'POST', body: JSON.stringify({ by, ...body }) }), env }); return { status: r.status, d: await r.json() }; };
const get = async (env, q) => { const r = await mod.onRequestGet({ request: new Request(`https://x.pages.dev/api/qr-order?c=C1&${q}`), env }); return { status: r.status, d: await r.json() }; };
const MENU = { business: 'Lake View', payment: { mpesa: true, cash: true }, items: [{ code: 'BRG', name: 'Beef Burger', price: 650, station: 'kitchen' }] };
async function shop() {
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv, LEDGER_DB: makeD1() };
  await call(env, { action: 'publishMenu', menu: MENU });
  const code = (await call(env, { action: 'ensure', kind: 'online', labels: ['Order from home'] })).d.codes[0];
  return { env, code };
}
const q = (env, sql, ...a) => env.LEDGER_DB.query(sql, ...a);
let n = 0;
const order = async (env, token, extra, ip = '1.1.1.1') => {
  const r = await mod.onRequestPost({ request: new Request('https://x.pages.dev/api/qr-order?c=C1', { method: 'POST', headers: { 'CF-Connecting-IP': ip }, body: JSON.stringify({ action: 'order', t: token, key: 'key-' + (++n) + '-abcdefgh', items: [{ code: 'BRG', qty: 1 }], ...extra }) }), env });
  return { status: r.status, d: await r.json() };
};

test('online code: kind is accepted and the guest page is told it is the public code', async () => {
  const { env, code } = await shop();
  assert.equal(code.kind, 'online');
  assert.equal((await get(env, `t=${code.token}`)).d.location.kind, 'online');
});

test('online code: name, a real phone and (for delivery) an address are REQUIRED; pickup needs no address', async () => {
  const { env, code } = await shop();
  assert.equal((await order(env, code.token, {})).status, 400, 'nothing typed');
  const noName = await order(env, code.token, { name: '', phone: '0712345678', address: 'Kilimani' }); assert.equal(noName.status, 400); assert.equal(noName.d.field, 'name');
  const badPhone = await order(env, code.token, { name: 'Mary', phone: '12', address: 'Kilimani' }); assert.equal(badPhone.status, 400); assert.equal(badPhone.d.field, 'phone');
  const noAddr = await order(env, code.token, { name: 'Mary', phone: '0712345678', mode: 'delivery', address: '' }); assert.equal(noAddr.status, 400); assert.equal(noAddr.d.field, 'address');
  assert.equal(q(env, 'select count(*) n from qr_orders')[0].n, 0, 'nothing was saved for the refused ones');
  const ok = await order(env, code.token, { name: 'Mary', phone: '0712 345 678', mode: 'delivery', address: 'Kilimani, Argwings Kodhek Rd', note: 'no onions' });
  assert.equal(ok.status, 200);
  const pick = await order(env, code.token, { name: 'Joe', phone: '0722000111', mode: 'pickup' });
  assert.equal(pick.status, 200);
  const pend = (await call(env, { action: 'pending' }, 'Alice')).d.orders;
  assert.equal(pend.length, 2);
  const m = pend.find((o) => o.name === 'Mary'), j = pend.find((o) => o.name === 'Joe');
  assert.equal(m.phone, '0712 345 678'); assert.match(m.note, /^DELIVERY to: Kilimani, Argwings Kodhek Rd \| no onions$/); assert.equal(m.kind, 'online');
  assert.match(j.note, /^PICKUP/);
  assert.notEqual(m.id, j.id, 'each customer has their own order');
});

test('online code: the per-code hourly brake is per caller, so one busy customer cannot lock out everyone else', async () => {
  const { env, code } = await shop();
  let blocked = 0;
  for (let i = 0; i < 20; i++) { const r = await order(env, code.token, { name: 'Spam', phone: '0700000000', mode: 'pickup' }, '9.9.9.9'); if (r.status === 429) blocked++; }
  assert.ok(blocked > 0, 'the noisy caller is slowed down');
  const other = await order(env, code.token, { name: 'Neighbour', phone: '0711111111', mode: 'pickup' }, '2.2.2.2');
  assert.equal(other.status, 200, 'a different customer still gets through');
});

test('table codes still work exactly as before (name optional, no phone needed)', async () => {
  const { env } = await shop();
  const t = (await call(env, { action: 'create', kind: 'table', label: 'Table 7' })).d.code;
  const r = await order(env, t.token, { name: '' });
  assert.equal(r.status, 200);
});
