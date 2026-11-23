import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeKV, seedShop } from './kv-fake.mjs';
import { makeBinding, hasSqlite } from './do-fake.mjs';

// zip 292: server-side permission checks on the cash and serial-unit lists (functions/api/_perm-guard.js), on both storage backends.
const imp = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sealed = (pin, salt = 'saltsalt', iter = 1000) => `p2$${iter}$${salt}$${crypto.pbkdf2Sync(sha(pin), salt, iter, 32, 'sha256').toString('hex')}`;
const STAFF = [
  { id: 'w1', name: 'Wanjiru', pinHash: sealed('1111'), roles: ['service-tab', 'hosp-role:waiter'], updatedAt: 1 },
  { id: 'm1', name: 'Manager Mo', pinHash: sealed('3333'), roles: ['service-tab'], isManager: true, updatedAt: 1 },
];
const guard = await imp('_perm-guard.js');
const ss = await imp('staff-session.js');
const sync = await imp('pos-sync.js');
const U = (extra = {}) => ({ id: 'su-1', code: 'PH1', status: 'in_stock', ids: [{ type: 'imei', value: '111', norm: '111' }], history: [], updatedAt: 10, ...extra });

test('rules: what needs a manager and what does not', () => {
  const n = guard.needsManager;
  assert.ok(n('cashConfig', { id: 'cfg', enabled: false }, { id: 'cfg', enabled: true }));
  assert.equal(n('cashConfig', { id: 'cfg', enabled: true, updatedAt: 99 }, { id: 'cfg', enabled: true, updatedAt: 1 }), '', 'only a timestamp differs');
  assert.ok(n('cashPoints', { id: 'p', name: 'X' }, null), 'a new cashier point');
  assert.ok(n('cashSessions', { id: 's', closing: { status: 'exempted' } }, { id: 's' }));
  assert.ok(n('cashSessions', { id: 's', closing: { approval: { status: 'approved' } } }, { id: 's', closing: { approval: { status: 'pending' } } }));
  assert.ok(n('cashSessions', { id: 's', corrections: [1] }, { id: 's', corrections: [] }));
  assert.equal(n('cashSessions', { id: 's', status: 'closed', closing: { status: 'counted', approval: { status: 'pending' } } }, { id: 's', status: 'open' }), '', 'an ordinary close');
  assert.ok(n('cashMovements', { id: 'm', voided: true }, { id: 'm' }));
  assert.equal(n('cashMovements', { id: 'm', amount: 5 }, null), '', 'a new movement is ordinary cash handling');
  assert.ok(n('serialUnits', U({ status: 'written_off' }), U()));
  assert.ok(n('serialUnits', U({ ids: [{ type: 'imei', value: '999', norm: '999' }] }), U()));
  assert.equal(n('serialUnits', U({ status: 'sold' }), U()), '', 'a sale');
  assert.equal(n('serialUnits', U(), null), '', 'a new unit');
});

test('guardPush: off = untouched; a manager = untouched; staff = the protected record is swapped for the stored one, the rest passes', () => {
  const stored = { cashConfig: [{ id: 'cfg', enabled: true, updatedAt: 1 }] };
  const get = (col, rec) => (stored[col] || []).find((r) => r.id === rec.id) || null;
  const body = { cashConfig: [{ id: 'cfg', enabled: false, updatedAt: 5 }], cashMovements: [{ id: 'm1', amount: 10 }], inventory: [{ code: 'A' }] };
  assert.equal(guard.guardPush(body, get, { enforce: false }).body, body);
  assert.equal(guard.guardPush(body, get, { enforce: true, claims: { mgr: true } }).body, body);
  const g = guard.guardPush(body, get, { enforce: true, claims: { sid: 'w1', mgr: false, perms: [] } });
  assert.equal(g.held.length, 1); assert.equal(g.body.cashConfig[0].enabled, true); assert.equal(g.body.cashMovements.length, 1); assert.equal(g.body.inventory.length, 1);
  assert.equal(guard.guardPush(body, get, { enforce: true, claims: null }).held.length, 1, 'no staff session = not a manager');
  assert.equal(body.cashConfig[0].enabled, false, 'the push itself is not mutated');
});

async function shop(env0) {
  const kv = env0 ? env0.mydukapos_kv : makeKV(); if (!env0) seedShop(kv, 'C1');
  const env = env0 || { mydukapos_kv: kv };
  const push = (body, token) => sync.onRequestPost({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1', { method: 'POST', headers: token ? { 'X-Staff-Token': token } : {}, body: JSON.stringify({ updatedAt: Date.now(), ...body }) }), env, waitUntil() {} });
  const pull = async () => (await sync.onRequestGet({ request: new Request('https://x.pages.dev/api/pos-sync?c=C1&hot=all'), env, waitUntil() {} })).json();
  const login = async (b, h = {}) => { const r = await ss.onRequestPost({ request: new Request('https://x.pages.dev/api/staff-session?c=C1', { method: 'POST', body: JSON.stringify(b), headers: h }), env }); return { status: r.status, d: await r.json() }; };
  await push({ businessName: 'Biz', pwHash: sealed('shoppass'), staff: STAFF, cashPoints: [{ id: 'cp1', name: 'Main till', deviceIds: [], updatedAt: 1 }], serialUnits: [U()], cashMovements: [{ id: 'mv1', amount: 100, direction: 'out', updatedAt: 1 }] });
  return { env, push, pull, login };
}
async function scenario(ctx) {
  const { env, push, pull, login } = ctx;
  const w = (await login({ staffId: 'w1', proof: sha('1111') })).d, m = (await login({ staffId: 'm1', proof: sha('3333') })).d, a = (await login({ admin: true, proof: sha('shoppass') })).d;
  await login({ action: 'mode', mode: 'off' }, { 'X-Staff-Token': a.token });          // (the mode is cached per shop for a few seconds: start from a known state)
  // switch OFF (default): nothing is held
  let r = await (await push({ cashPoints: [{ id: 'cp1', name: 'Renamed', deviceIds: [], updatedAt: 5 }] }, w.token)).json();
  assert.ok(!r.held, 'enforcement off: no change in behaviour');
  assert.equal((await pull()).cashPoints.find((p) => p.id === 'cp1').name, 'Renamed');
  await login({ action: 'mode', mode: 'enforce' }, { 'X-Staff-Token': a.token });
  // a waiter: settings change held, the unit write-off held, the void held; ordinary cash handling passes
  r = await (await push({ cashPoints: [{ id: 'cp1', name: 'Hacked', deviceIds: [], updatedAt: 9 }, { id: 'cp2', name: 'New till', updatedAt: 9 }], serialUnits: [U({ status: 'written_off', updatedAt: 12 })], cashMovements: [{ id: 'mv1', amount: 100, direction: 'out', voided: true, updatedAt: 13 }, { id: 'mv2', amount: 50, direction: 'out', updatedAt: 13 }] }, w.token)).json();
  assert.equal(r.held.length, 4, JSON.stringify(r.held));
  let st = await pull();
  assert.equal(st.cashPoints.find((p) => p.id === 'cp1').name, 'Renamed', 'the stored point stands');
  assert.ok(!st.cashPoints.some((p) => p.id === 'cp2'), 'a waiter cannot add a cashier point');
  assert.equal(st.serialUnits.find((u) => u.id === 'su-1').status, 'in_stock');
  assert.ok(!st.cashMovements.find((x) => x.id === 'mv1').voided);
  assert.ok(st.cashMovements.some((x) => x.id === 'mv2'), 'a new cash movement is ordinary handling');
  // no token at all (enforcement on) = not a manager
  r = await (await push({ cashPoints: [{ id: 'cp1', name: 'Anon', deviceIds: [], updatedAt: 20 }] })).json();
  assert.equal(r.held.length, 1);
  // a manager may do all of it
  r = await (await push({ cashPoints: [{ id: 'cp1', name: 'Main till 2', deviceIds: [], updatedAt: 30 }], serialUnits: [U({ status: 'written_off', updatedAt: 31 })], cashMovements: [{ id: 'mv1', amount: 100, direction: 'out', voided: true, updatedAt: 32 }] }, m.token)).json();
  assert.ok(!r.held);
  st = await pull();
  assert.equal(st.cashPoints.find((p) => p.id === 'cp1').name, 'Main till 2'); assert.equal(st.serialUnits.find((u) => u.id === 'su-1').status, 'written_off'); assert.equal(st.cashMovements.find((x) => x.id === 'mv1').voided, true);
  // and the attempt left a security event
  const ev = [...env.mydukapos_kv.data.keys()].filter((k) => k.startsWith('secevt:') && k.includes('permission_held'));
  assert.ok(ev.length >= 1, 'logged for the owner: ' + [...env.mydukapos_kv.data.keys()].filter((k) => k.startsWith('secevt')).join(','));
}

test('KV shop: enforced by the sync server (waiter / no session held, manager passes), off by default, attempts logged', async () => { await scenario(await shop()); });

test('database (Durable Object) shop: the same rules on the other backend', { skip: !hasSqlite }, async () => {
  const kv = makeKV(); seedShop(kv, 'C1');
  const env = { mydukapos_kv: kv, SHOP_STORE: await makeBinding() };
  const base = await shop(env);
  kv.data.set('owner-session:tok', { value: '1' });
  const os = await imp('owner-storage.js');
  const mig = await os.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-storage', { method: 'POST', body: JSON.stringify({ action: 'migrate', clientId: 'C1' }), headers: { 'content-type': 'application/json', Authorization: 'Bearer tok' } }), env });
  assert.equal(mig.status, 200);
  await scenario(base);
});
