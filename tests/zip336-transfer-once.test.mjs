import test from 'node:test';
import assert from 'node:assert/strict';
// zip 336 fix: a Store -> Inventory transfer is applied ONCE (not 2 -> 4 -> 6) even when the "received" reply never reaches the server and the
// till's own claim record is lost on refresh, or a second device offers the same transfer.
import { makeServer, openDevice, closeWhenIdle } from './e2e-harness.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV } from './kv-fake.mjs';
import { handleStoreD1 } from '../functions/api/_store-d1.js';
const lic = { C1: { id: 'C1', branchGroupId: 'G', businessName: 'Main' } };
const getLicense = async (_e, id) => lic[id] || null;
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const INV = [{ code: 'SUG', type: 'item', name: 'Sugar 1kg', price: 150, wholesalePrice: 100, qty: 2, unit: 'pcs', vatCategory: 'A' }];
test('transfer from the Store is added once: confirmation lost + claim record lost + refresh', async () => {
  const server = makeServer();
  const env = { LEDGER_DB: makeD1(), mydukapos_kv: makeKV() };
  const call = (body) => handleStoreD1(env, env.LEDGER_DB, { body, groupId: 'G', record: lic.C1, getLicense, json: (b, s = 200) => ({ status: s, body: b }) });
  const seeded = (await call({ action: 'addManual', item: { code: 'SUG', name: 'Sugar 1kg', qty: 2, unit: 'pcs', price: 150 } })).body.items[0];
  let failConfirm = true;
  const fetchAll = async (url, o = {}) => {
    const u = new URL(String(url), 'https://shop.mydukapos.store');
    if (u.pathname.endsWith('/api/store')) { const b = JSON.parse(o.body); if (failConfirm && b.action === 'receive') return new Response('{"error":"x"}', { status: 500 }); const r = await call(b); return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } }); }
    return server.fetch(url, o);
  };
  const q = (w) => w.eval("(inventory.find(i=>i.code==='SUG')||{}).qty");
  const dev = await openDevice('index.html', { ...server, fetch: fetchAll }, { pos_inventory: JSON.stringify(INV) });
  const { w } = dev; w.eval("showToast=function(){};window.confirm=()=>true");
  await w.eval('loadStoreItems(true)'); await tick(200);
  await w.eval(`(function(){var el=document.createElement('input');el.id='store-take-qty-${seeded.id}';document.body.appendChild(el);el.value='2';return takeFromStore('${seeded.id}');})()`); await tick(400);
  const a1 = q(w);
  await w.eval('pushNow()'); await tick(300);
  // refresh with the claim record LOST (e.g. cleared storage key / other WebView / second device)
  const ls = JSON.parse(w.eval("JSON.stringify(Object.fromEntries(Array.from({length: localStorage.length}, (_, i) => localStorage.key(i)).map(k => [k, localStorage.getItem(k)])))"));
  delete ls.pos_store_applied;
  await closeWhenIdle(dev);
  const d2 = await openDevice('index.html', { ...server, fetch: fetchAll }, ls, 1200); d2.w.eval("showToast=function(){}");
  await d2.w.eval('storeReconcileAt=0; storeReconcilePending()'); await tick(500);
  const a2 = q(d2.w);
  await d2.w.eval('pushNow()'); await tick(400); await d2.w.eval('pullState()'); await tick(400);
  assert.equal(a1, 4, 'inventory 2 + 2 from the Store');
  assert.equal(a2, 4, 'the refresh did not add it again');
  assert.equal(q(d2.w), 4, 'nor after syncing back');
  failConfirm = false; await d2.w.eval('storeReconcileAt=0; storeReconcilePending()'); await tick(500);
  assert.equal((await call({ action: 'pendingTransfers' })).body.transfers.length, 0, 'the retried confirmation cleared it');
  assert.equal(q(d2.w), 4);
  d2.close();
});

test('two tills of one shop both offered the same transfer: stock rises by the transfer once', async () => {
  const server = makeServer();
  const env = { LEDGER_DB: makeD1(), mydukapos_kv: makeKV() };
  const call = (body) => handleStoreD1(env, env.LEDGER_DB, { body, groupId: 'G', record: lic.C1, getLicense, json: (b, s = 200) => ({ status: s, body: b }) });
  const seeded = (await call({ action: 'addManual', item: { code: 'SUG', name: 'Sugar 1kg', qty: 2, unit: 'pcs', price: 150 } })).body.items[0];
  const fetchAll = async (url, o = {}) => {
    const u = new URL(String(url), 'https://shop.mydukapos.store');
    if (u.pathname.endsWith('/api/store')) { const b = JSON.parse(o.body); if (b.action === 'receive') return new Response('{"error":"x"}', { status: 500 }); const r = await call(b); return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } }); }
    return server.fetch(url, o);
  };
  const q = (w) => w.eval("(inventory.find(i=>i.code==='SUG')||{}).qty");
  const A = await openDevice('index.html', { ...server, fetch: fetchAll }, { pos_inventory: JSON.stringify(INV) });
  const B = await openDevice('index.html', { ...server, fetch: fetchAll }, { pos_inventory: JSON.stringify(INV) });
  for (const d of [A, B]) d.w.eval("showToast=function(){};window.confirm=()=>true");
  await A.w.eval('loadStoreItems(true)'); await tick(200);
  await A.w.eval(`(function(){var el=document.createElement('input');el.id='store-take-qty-${seeded.id}';document.body.appendChild(el);el.value='2';return takeFromStore('${seeded.id}');})()`); await tick(400);
  await B.w.eval('storeReconcileAt=0; storeReconcilePending()'); await tick(500);
  await A.w.eval('flushThenPull()'); await B.w.eval('flushThenPull()'); await tick(300); await A.w.eval('flushThenPull()'); await B.w.eval('flushThenPull()'); await tick(400);
  assert.equal(q(A.w), 4); assert.equal(q(B.w), 4, 'the second till was corrected to the server figure, not 6');
  A.close(); B.close();
});
