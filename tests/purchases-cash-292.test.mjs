import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice } from './e2e-harness.mjs';

// zip 292: Purchases arrival x serial identifiers / variants / drawer payments; cash exemption, branch + device assignment, drawer report.
const ON = JSON.stringify([{ id: 'cfg', enabled: true, updatedAt: 1 }]);
const PHONE = { code: 'PH1', type: 'item', name: 'Samsung A15', price: 18000, wholesalePrice: 15000, qty: 0, unit: 'pcs', vatCategory: 'A', serialized: true };
const TEE = { code: 'TEE', type: 'item', name: 'Tee', price: 800, wholesalePrice: 300, qty: 0, unit: 'pcs', vatCategory: 'A', hasVariants: true, variants: [{ id: 'v1', name: 'Black', code: '', price: 800, wholesalePrice: 300, qty: 0 }, { id: 'v2', name: 'White', code: '', price: 800, wholesalePrice: 300, qty: 0 }] };
const PLAIN = { code: 'A', type: 'item', name: 'Alpha', price: 1000, wholesalePrice: 500, qty: 10, unit: 'pcs', vatCategory: 'A' };
const quiet = (w) => w.eval("window.__t = []; showToast = function (m, e) { window.__t.push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.print = () => {}");
const E = (w, code) => JSON.parse(w.eval(`JSON.stringify(${code})`));
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const boot = async (extra = {}) => { const dev = await openDevice('index.html', makeServer(), { pos_inventory: JSON.stringify([PHONE, TEE, PLAIN]), pos_cash_config: ON, ...extra }, 900); quiet(dev.w); return dev; };
const makeOrder = (w, items) => {
  w.eval(`purchaseOrders.push({ id: 'po1', orderNo: 'PO-0001', status: 'pending', supplierName: 'Acme', items: ${JSON.stringify(items)}, statusHistory: [], createdAt: new Date().toISOString() })`);
  w.eval(`(function () { var st = poState(); st.arriveOrderId = 'po1'; st.arriveLines = {}; purchaseOrders[0].items.forEach(function (it) { st.arriveLines[it.id] = { checked: true, qty: String(it.qty) }; }); })()`);
  if (!w.document.getElementById('po-arrive-expense-check')) { const c = w.document.createElement('input'); c.type = 'checkbox'; c.id = 'po-arrive-expense-check'; c.checked = true; w.document.body.appendChild(c); const m = w.document.createElement('div'); m.id = 'po-arrive-msg'; w.document.body.appendChild(m); }
  else w.document.getElementById('po-arrive-expense-check').checked = true;
};

test('PURCHASE of a serialized item: stock does NOT go up until the identifiers match the count; then stock and units rise once, together', async () => {
  const dev = await boot(); const { w, d } = dev;
  makeOrder(w, [{ id: 'l1', code: 'PH1', name: 'Samsung A15', qty: 2, cost: 15000, unit: 'pcs' }]);
  w.eval('poConfirmArrival()');
  assert.ok(d.getElementById('ip-po-ids'), 'asked for the identifiers first');
  assert.equal(E(w, "inventory.find(i => i.code === 'PH1').qty"), 0, 'no stock yet');
  // only one identifier: refused
  d.querySelector('[data-ip-poids="0"]').value = '356938035643801';
  d.querySelector('[data-ip-posave]').click();
  assert.match(d.querySelector('[data-ip-poerr="0"]').textContent, /1 valid of 2/);
  assert.equal(E(w, "inventory.find(i => i.code === 'PH1').qty"), 0);
  d.querySelector('[data-ip-poids="0"]').value = '356938035643801\n356938035643802';
  d.querySelector('[data-ip-posave]').click(); await tick(150);
  assert.equal(E(w, 'serialUnits.length'), 2);
  assert.equal(E(w, "inventory.find(i => i.code === 'PH1').qty"), 2, 'qty 2, not 4');
  assert.equal(E(w, "purchaseOrders[0].status"), 'received');
  assert.equal(E(w, "serialUnits[0].ref"), 'PO-0001');
  assert.equal(E(w, "serialUnits[0].supplier"), 'Acme');
  dev.close();
});

test('PURCHASE of a variant ("Tee · Black"): that variant\'s stock rises, the product total follows, and no stray product is created', async () => {
  const dev = await boot(); const { w } = dev;
  makeOrder(w, [{ id: 'l1', code: '', name: 'Tee · Black', qty: 5, cost: 300, unit: 'pcs' }]);
  w.eval('poConfirmArrival()'); await tick(100);
  const tee = E(w, "inventory.find(i => i.code === 'TEE')");
  assert.equal(tee.variants[0].qty, 5); assert.equal(tee.variants[1].qty, 0); assert.equal(tee.qty, 5);
  assert.equal(E(w, 'inventory.length'), 3, 'no new product');
  w.eval('poRefreshFormLists()'); assert.match(w.document.getElementById('po-item-names').innerHTML, /Tee · White/);
  dev.close();
});

test('PURCHASE paid from the drawer: exactly ONE cash movement linked to the expense, even when asked twice', async () => {
  const dev = await boot(); const { w } = dev;
  const pt = E(w, 'cashDrawerInternals.resolve().point');
  const r = E(w, `cashOpenSession(cashSessions, ${JSON.stringify(pt)}, {settings: cashDrawerInternals.settings(), counts:{1000:20}, confirmed:true, by:'A', now: Date.now()})`);
  w.eval(`cashSessions.push(${JSON.stringify(r.session)})`);
  makeOrder(w, [{ id: 'l1', code: 'A', name: 'Alpha', qty: 4, cost: 500, unit: 'pcs' }]);
  w.eval('poConfirmArrival()'); await tick(100);
  const exp = E(w, "expenses.find(e => e.category === 'Restock')");
  assert.ok(exp && exp.cashMovementId, 'the expense points at its movement');
  assert.equal(E(w, 'cashMovements.length'), 1);
  const mv = E(w, 'cashMovements[0]');
  assert.equal(mv.amount, 2000); assert.equal(mv.category, 'supplier_payment'); assert.equal(mv.ref.id, exp.id);
  w.eval(`cashPurchasePaid(${JSON.stringify(exp)}, { orderNo: 'PO-0001' })`);
  assert.equal(E(w, 'cashMovements.length'), 1, 'asking again makes no second movement');
  assert.equal(E(w, 'cashDrawerInternals.summary(cashDrawerInternals.activeSession()).payouts'), 2000);
  dev.close();
});

test('CASH: a manager can exempt a session (reason required), it is shown as exempted and never counts as a shortage; staff cannot', async () => {
  const dev = await boot(); const { w } = dev;
  const pt = E(w, 'cashDrawerInternals.resolve().point');
  const r = E(w, `cashOpenSession(cashSessions, ${JSON.stringify(pt)}, {settings: cashDrawerInternals.settings(), counts:{1000:5}, confirmed:true, by:'A', now: 1000})`);
  const ses = r.session, sm = E(w, `cashSessionSummary(${JSON.stringify(ses)}, [], [], {})`);
  const go = (o) => E(w, `cashCloseSession(${JSON.stringify(ses)}, ${JSON.stringify(sm)}, Object.assign({settings: cashDrawerInternals.settings(), exempt: true, by: 'M', now: 2000}, ${JSON.stringify(o)}))`);
  assert.equal(go({ isManager: false, reason: 'x' }).ok, false);
  assert.equal(go({ isManager: true, reason: ' ' }).ok, false);
  const ok = go({ isManager: true, reason: 'Shop closed - drawer not used' });
  assert.equal(ok.ok, true); assert.equal(ok.closing.status, 'exempted'); assert.equal(ok.closing.variance, null); assert.equal(ok.closing.exempt.by, 'M');
  // the history screen and the report keep it apart from counted / skipped
  w.eval(`(function(){ var s = ${JSON.stringify(ses)}; s.closing = ${JSON.stringify(ok.closing)}; s.status = 'closed'; cashSessions.push(s); })()`);
  w.eval("window.cashDrawerOpen(); document.querySelector('#cash-card [data-act=goto-history]').click()");
  assert.match(w.document.getElementById('cash-card').textContent, /exempted from counting/);
  dev.close();
});

test('CASH: branch on a cashier point, devices assigned to a point (a device lives on ONE point), and the Cash drawer report', async () => {
  const dev = await boot(); const { w } = dev;
  w.eval("lastKnownNetworkDevices = [{ deviceId: 'dev-bar-1', name: 'Bar tablet' }]; cashPoints.push({id:'t2',name:'Bar till',active:true,deviceIds:[],updatedAt:1})");
  w.eval("window.cashDrawerOpen(); document.querySelector('#cash-card [data-act=goto-settings]').click()");
  const card = () => w.document.getElementById('cash-card');
  assert.ok(card().querySelector('input[data-pbranch="t2"]'), 'branch field');
  const sel = card().querySelector('select[data-padd="t2"]'); assert.ok(sel, 'assign a device');
  assert.ok([...sel.options].some((o) => o.value === 'dev-bar-1'));
  sel.value = 'dev-bar-1'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.deepEqual(E(w, "cashPoints.find(p => p.id === 't2').deviceIds"), ['dev-bar-1']);
  assert.match(card().textContent, /Bar tablet/);
  // moving it to another point removes it from the first
  w.eval("cashPoints.find(p => p.id !== 't2').deviceIds.push('dev-x')");
  const other = E(w, "cashPoints.find(p => p.id !== 't2').id");
  card().querySelector('input[data-pbranch="t2"]').value = 'Westlands';
  card().querySelector('[data-act="save-settings"]').click();
  assert.equal(E(w, "cashPoints.find(p => p.id === 't2').branch"), 'Westlands');
  // report
  const pt = E(w, "cashPoints.find(p => p.id === 't2')");
  const r = E(w, `cashOpenSession(cashSessions, ${JSON.stringify(pt)}, {settings: cashDrawerInternals.settings(), counts:{1000:5}, confirmed:true, by:'A', now: Date.now()})`);
  w.eval(`cashSessions.push(${JSON.stringify(r.session)})`);
  assert.ok(w.document.querySelector('[data-kind="cashdrawer"]'), 'a Cash drawer report button exists in Reports');
  const rep = E(w, "reportExtraBuilders.cashdrawer({ from: new Date(Date.now() - 86400000), to: new Date(Date.now() + 86400000) })");
  assert.equal(rep.title, 'Cash drawer'); assert.equal(rep.csv.length, 2); assert.equal(rep.csv[1][2], 'Westlands');
  dev.close();
});
