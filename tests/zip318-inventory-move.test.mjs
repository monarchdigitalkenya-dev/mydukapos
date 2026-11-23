import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice } from './e2e-harness.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV } from './kv-fake.mjs';
import { handleStoreD1 } from '../functions/api/_store-d1.js';

// zip 318: Inventory -> "↔ Move" on every item and every variant: move some of it to the Store, or send it to another branch.
// Real Shop app on two branches (C1 Main, C2 Westlands), real store server code on a D1 database.
const lic = { C1: { id: 'C1', branchGroupId: 'G', businessName: 'Main' }, C2: { id: 'C2', branchGroupId: 'G', businessName: 'Westlands' } };
const getLicense = async (_e, id) => lic[id] || null;
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const E = (w, code) => JSON.parse(w.eval(`JSON.stringify(${code})`));
const RICE = { code: 'RICE', type: 'item', name: 'Rice 2kg', price: 300, wholesalePrice: 240, qty: 10, unit: 'pcs', vatCategory: 'A' };
const swt = (ids, qtys) => ({ code: 'SWT', type: 'item', name: 'Sweater', price: 900, wholesalePrice: 600, unit: 'pcs', vatCategory: 'A', hasVariants: true, qty: qtys[0] + qtys[1],
  variants: [{ id: ids[0], name: 'Blue / 28', code: 'SWT-B28', price: 900, wholesalePrice: 600, qty: qtys[0] }, { id: ids[1], name: 'Blue / 30', code: 'SWT-B30', price: 950, wholesalePrice: 630, qty: qtys[1] }] });

async function setup(t) {
  const servers = { C1: makeServer(), C2: makeServer() };                     // each branch is its own shop
  const env = { LEDGER_DB: makeD1(), mydukapos_kv: makeKV() };
  const call = (who, body) => handleStoreD1(env, env.LEDGER_DB, { body, groupId: 'G', record: lic[who], getLicense, json: (b, s = 200) => ({ status: s, body: b }) });
  const fetchFor = (who) => async (url, o = {}) => {
    const u = new URL(String(url), 'https://shop.mydukapos.store');
    if (u.pathname.endsWith('/api/store')) { const r = await call(who, JSON.parse(o.body)); return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } }); }
    return servers[who].fetch(url, o);
  };
  const open = async (who, inv) => {
    const dev = await openDevice('index.html', { ...servers[who], fetch: fetchFor(who) }, { pos_inventory: JSON.stringify(inv) });
    dev.w.eval(`window.__t = []; showToast = function (m) { window.__t.push(m); }; window.confirm = () => true;
      myBranchGroupId = 'G'; branchesSummaryCache = { isBranchGroup: true, branches: [{ id: 'C1', label: 'Main', isSelf: ${who === 'C1'} }, { id: 'C2', label: 'Westlands', isSelf: ${who === 'C2'} }] };`);
    t.after(() => { try { dev.close(); } catch (e) { /* closed */ } });
    return dev;
  };
  return { call, open };
}
const move = async (w, d, code, vid, to, qty) => {
  await w.eval(`openMoveStock('${code}'${vid ? `, '${vid}'` : ''})`); await tick(250);
  const r = d.querySelector(`[name="spx-mv-to"][value="${to}"]`); r.checked = true; r.dispatchEvent(new w.Event('change', { bubbles: true }));
  if (to === 'branch') { const sel = d.getElementById('spx-mv-branch'); if (![...sel.options].some((o) => o.value === 'C2')) sel.innerHTML = '<option value="C2">Westlands</option>'; sel.value = 'C2'; }
  d.getElementById('spx-mv-qty').value = String(qty);
  d.getElementById('spx-mv-go').click(); await tick(300);
};

test('every Inventory item and every variant has a Move button; moving to the Store takes it off this branch and puts it in the Store, once', async (t) => {
  const { call, open } = await setup(t);
  const { w, d } = await open('C1', [RICE, swt(['a', 'b'], [4, 3])]);
  w.eval('renderInventoryTable()');
  const btns = [...d.querySelectorAll('#inventory-table .inv-move-btn')].map((b) => b.getAttribute('onclick'));
  assert.equal(btns.length, 3, 'one per item row and one per variant row: ' + btns.join(' | '));
  assert.ok(btns.some((x) => /openMoveStock\('SWT', 'b'\)/.test(x)), 'the variant row moves that variant');

  // more than this branch has: refused, nothing changes anywhere
  await move(w, d, 'RICE', null, 'store', 11);
  assert.match(d.getElementById('spx-mv-err').textContent, /Only 10/);
  assert.equal((await call('C1', { action: 'get' })).body.items.length, 0, 'nothing went to the Store');

  d.getElementById('spx-mv-qty').value = '4'; d.getElementById('spx-mv-go').click(); await tick(300);
  assert.equal(d.getElementById('spx-ov').classList.contains('on'), false, 'the window closes');
  assert.equal(E(w, "inventory.find(p => p.code === 'RICE').qty"), 6, 'off this branch');
  const store = (await call('C1', { action: 'get' })).body.items;
  assert.deepEqual(store.map((i) => [i.code, i.name, i.qty, i.price]), [['RICE', 'Rice 2kg', 4, 300]], 'into the Store, with its price');
  const mv = E(w, "stockMovementLog.filter(m => m.code === 'RICE')");
  assert.deepEqual(mv.map((m) => [m.delta, m.reason]), [[-4, 'Moved to Store']], 'in the stock ledger');
  const log = (await call('C1', { action: 'getLog' })).body.log;
  assert.ok(log.some((l) => l.action === 'moved_in' && /from Main/.test(l.detail)), 'the Store history says where it came from');

  // a repeated request (lost reply, retry) never adds it twice - on the server or on the till
  const key = 'mv-retry-1';
  for (let i = 0; i < 2; i++) await call('C1', { action: 'depositFromBranch', idemKey: key, items: [{ code: 'RICE', name: 'Rice 2kg', qty: 1 }] });
  assert.equal((await call('C1', { action: 'get' })).body.items[0].qty, 5, 'same key twice = once');

  // a variant to the Store goes as that variant (product::variant), and comes back to exactly that variant when taken
  await move(w, d, 'SWT', 'b', 'store', 2);
  assert.deepEqual(E(w, "inventory.find(p => p.code === 'SWT').variants.map(v => v.qty)"), [4, 1]);
  assert.equal(E(w, "inventory.find(p => p.code === 'SWT').qty"), 5, 'the item total follows its variants');
  assert.deepEqual(E(w, "stockMovementLog.filter(m => /Sweater/.test(m.name)).map(m => [m.code, m.delta])"), [['SWT-B30', -2]], 'logged under the variant code');
  const sItem = (await call('C1', { action: 'get' })).body.items.find((i) => i.code === 'SWT::b');
  assert.ok(sItem && sItem.qty === 2 && sItem.name === 'Sweater (Blue / 30)');
  const back = (await call('C1', { action: 'removeFromStore', items: [{ storeItemId: sItem.id, qty: 1 }] })).body.withdrawn;
  w.eval(`storeApplyWithdrawn(${JSON.stringify(back[0])})`);
  assert.deepEqual(E(w, "inventory.find(p => p.code === 'SWT').variants.map(v => v.qty)"), [4, 2], 'taken back into that variant');
  assert.deepEqual(E(w, "stockMovementLog.filter(m => /Sweater/.test(m.name)).map(m => [m.code, m.delta])").pop(), ['SWT-B30', 1], 'under the variant code (was the parent code: refused by the stock ledger)');
});

test('send to another branch: off this branch now; the other branch gets it once (matched by variant code), without opening its Store tab', async (t) => {
  const { call, open } = await setup(t);
  const A = await open('C1', [RICE, swt(['a', 'b'], [4, 3])]);
  const B = await open('C2', [{ ...RICE, qty: 1 }, swt(['x9', 'y9'], [0, 0])]);   // the same items, other variant ids
  await move(A.w, A.d, 'SWT', 'b', 'branch', 2);
  assert.equal(A.d.getElementById('spx-ov').classList.contains('on'), false, A.d.getElementById('spx-mv-err') && A.d.getElementById('spx-mv-err').textContent);
  assert.deepEqual(E(A.w, "inventory.find(p => p.code === 'SWT').variants.map(v => v.qty)"), [4, 1], 'off the sending branch');
  assert.match(E(A.w, 'window.__t').pop(), /Sent 2 pcs of Sweater \(Blue \/ 30\) to Westlands/);
  await move(A.w, A.d, 'RICE', null, 'branch', 3);
  assert.equal(E(A.w, "inventory.find(p => p.code === 'RICE').qty"), 7);
  assert.equal((await call('C1', { action: 'get' })).body.items.length, 0, 'it did not go through the Store stock');

  // the other branch's till picks it up on its own timer (here: called directly)
  await B.w.eval('storeReconcileAt = 0; storeReconcilePending()'); await tick(80);
  assert.deepEqual(E(B.w, "inventory.find(p => p.code === 'SWT').variants.map(v => v.qty)"), [0, 2], 'into the same variant (by variant code)');
  assert.equal(E(B.w, "inventory.find(p => p.code === 'SWT').qty"), 2);
  assert.equal(E(B.w, "inventory.find(p => p.code === 'RICE').qty"), 4);
  assert.ok(E(B.w, "stockMovementLog.filter(m => m.reason === 'Transfer from Main').length") === 2, 'logged as from the sending branch');
  // once only: confirmed received on the server, and a second check adds nothing
  assert.equal((await call('C2', { action: 'pendingTransfers' })).body.transfers.length, 0, 'confirmed received');
  await B.w.eval('storeReconcileAt = 0; storeReconcilePending()'); await tick(80);
  assert.equal(E(B.w, "inventory.find(p => p.code === 'RICE').qty"), 4, 'not twice');
  const log = (await call('C1', { action: 'getLog' })).body.log.filter((l) => l.action === 'branch_transfer');
  assert.equal(log.length, 2); assert.ok(log.every((l) => / to Westlands /.test(l.detail) && /received/.test(l.detail)), JSON.stringify(log));
  // a branch cannot send to itself
  const self = await call('C1', { action: 'sendToBranch', idemKey: 'k-self', destClientId: 'C1', items: [{ name: 'Rice 2kg', qty: 1 }] });
  assert.equal(self.status, 400);
});
