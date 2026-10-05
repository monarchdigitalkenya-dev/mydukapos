import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, boot } from './helpers.mjs';
import { makeD1 } from './d1-fake.mjs';
import { makeKV } from './kv-fake.mjs';
import { recordPush } from '../functions/api/_ledger.js';
import { lpgMigrationText } from '../tools/gen-migration.mjs';
import { LPG_SCHEMA } from '../functions/api/_lpg-schema.js';

// zip 216 — LPG / gas retail. The browser half runs the REAL till (jsdom): the chooser's cart function, the sale, the stock, the void, the stock take.
// The server half takes what that till really recorded (the sale and its stock movements) and pushes it through the REAL ledger SQL (node:sqlite behind the D1 fake).
const APPS = ['index.html', 'production/index.html', 'services/index.html'];
const EXTRA = JSON.stringify([
  { code: 'REG', type: 'item', name: 'Regulator', price: 600, wholesalePrice: 400, qty: 10, unit: 'pcs', vatCategory: 'A' },
  { code: 'HOS', type: 'item', name: 'Gas Hose', price: 200, wholesalePrice: 100, qty: 10, unit: 'pcs', vatCategory: 'A' },
]);
const val = (d, id, v) => { d.getElementById(id).value = String(v); };
const j = (w, expr) => JSON.parse(w.eval(`JSON.stringify(${expr})`));
const find = (w, name) => j(w, `inventory.find(p => p.name === ${JSON.stringify(name)}) || null`);
const qty = (w, name) => (find(w, name) || {}).qty;
async function shop(app = 'index.html', opt = {}) {
  const b = await boot(app, { storage: { pos_inventory: EXTRA, pos_do_gas_refills: 'true' }, wait: 2000 });
  const { w, d } = b;
  w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }; window.confirm = () => true");
  const size = (sz, full, empty, brand = '') => { val(d, 'gas-new-size', sz); val(d, 'gas-new-full-stock', full); val(d, 'gas-new-empty-stock', empty); val(d, 'gas-new-brand', brand); w.eval('addGasSize()'); };
  size('13kg', opt.full ?? 10, opt.empty ?? 3);
  const f13 = find(w, '13kg (Full)').code;
  // price 4500 / refill 1500 / empty 2500, cost 3600 / refill cost 900 / empty cost 1800
  w.eval(`gasBoardPrice('${f13}', 'outright', 4500); gasBoardPrice('${f13}', 'refill', 1500); gasBoardPrice('${f13}', 'empty', 2500); gasBoardPrice('${f13}', 'cost', 3600); gasBoardPrice('${f13}', 'refillcost', 900); gasBoardPrice('${f13}', 'emptycost', 1800)`);
  return { b, w, d, f13, size };
}
const cartAdd = (w, o) => j(w, `Lpg.cartAdd(${JSON.stringify(o)})`);
async function pay(b) {
  b.w.eval("currentPaymentMethod = 'cash'");
  b.d.getElementById('cash-tendered-input').value = '1000000';
  await b.w.eval('checkoutCart()');
  return j(b.w, 'salesLog[salesLog.length - 1]');
}
const body = (w) => ({ salesLog: j(w, 'salesLog'), stockMovementLog: j(w, 'stockMovementLog') });
const env = () => ({ LEDGER_DB: makeD1(), mydukapos_kv: makeKV(), RETRY_BASE_MS: 0, LEDGER_SEEN_MS: '0' });
const q = (e, sql, ...a) => JSON.parse(JSON.stringify(e.LEDGER_DB.query(sql, ...a)));
const push = (e, clientId, b) => recordPush(e, clientId, b, { source: 'pos-sync' });

for (const app of APPS) {
  test(`LPG 1 (${app}): a normal sale — Full 10 → 9, one gas line with price / cost / margin, a movement with before / change / after`, async () => {
    const { b, w, f13 } = await shop(app);
    const r = cartAdd(w, { fullCode: f13, mode: 'full', qty: 1 });
    assert.equal(r.ok, true, r.msg);
    const sale = await pay(b);
    assert.equal(qty(w, '13kg (Full)'), 9); assert.equal(qty(w, '13kg (Empty)'), 3);
    assert.equal(sale.items[0].lpg.mode, 'full'); assert.equal(sale.items[0].wholesalePrice, 3600, 'the line cost is the cylinder cost, not a price tier');
    const e = env();
    assert.equal((await push(e, 'shopA', body(w))).ok, true);
    const lines = q(e, 'select * from lpg_sale_lines where client_id = ?', 'shopA');
    assert.equal(lines.length, 1); assert.equal(lines[0].mode, 'full'); assert.equal(lines[0].price, 4500); assert.equal(lines[0].cost, 3600); assert.equal(lines[0].margin, 900);
    const mv = q(e, `select * from lpg_movements where client_id = 'shopA' and kind = 'full'`);
    assert.equal(mv.length, 1); assert.deepEqual([mv[0].state, mv[0].before_qty, mv[0].qty, mv[0].after_qty], ['full', 10, -1, 9]); assert.equal(mv[0].line_ref, lines[0].line_ref);
    b.close();
  });
}

test('LPG 2: an exchange — Full 10 → 9, Empty 3 → 4, the exchange is recorded on both sides under one reference; a resend adds nothing', async () => {
  const { b, w, f13 } = await shop();
  assert.equal(cartAdd(w, { fullCode: f13, mode: 'exchange', qty: 1 }).ok, true);
  const sale = await pay(b);
  assert.deepEqual([qty(w, '13kg (Full)'), qty(w, '13kg (Empty)')], [9, 4]);
  assert.equal(sale.items[0].lpg.mode, 'exchange'); assert.equal(sale.items[0].wholesalePrice, 900);
  const e = env(), bd = body(w);
  await push(e, 'shopA', bd);
  const lines = q(e, `select * from lpg_sale_lines where client_id = 'shopA'`);
  assert.equal(lines.length, 1); assert.equal(lines[0].mode, 'exchange'); assert.equal(lines[0].margin, 600); assert.equal(lines[0].empty_state, 'empty');
  const mv = q(e, `select state, kind, before_qty, qty, after_qty, line_ref from lpg_movements where client_id = 'shopA' and line_ref = ? order by state`, lines[0].line_ref);
  assert.deepEqual(mv.map((x) => [x.state, x.kind, x.before_qty, x.qty, x.after_qty]), [['empty', 'exchange_in', 3, 1, 4], ['full', 'exchange', 10, -1, 9]]);
  const n1 = q(e, 'select count(*) n from lpg_movements')[0].n;
  await push(e, 'shopA', bd); await push(e, 'shopA', bd);
  assert.equal(q(e, 'select count(*) n from lpg_movements')[0].n, n1, 'a resend of the same records adds no movement');
  assert.equal(q(e, 'select count(*) n from lpg_sale_lines')[0].n, 1);
  // the till's stock ledger also has the empty's +1 now (it used to be changed without a movement)
  assert.equal(j(w, "stockMovementLog.filter(m => m.code === inventory.find(p => p.name === '13kg (Empty)').code && m.delta === 1).length"), 1);
  b.close();
});

test('LPG 3: a set (bundle) — the cylinder and every part come off the stock, cost / margin / promo price are right, a void puts every part back', async () => {
  const { b, w, f13 } = await shop();
  w.eval(`(() => { const c = Lpg.cfg(); c.bundles.push({ id: 'B1', name: 'Starter set', size: '${f13}', comps: [{ code: 'REG', qty: 1 }, { code: 'HOS', qty: 2 }], price: 5200, active: true }); safeSetItem('pos_lpg_config', JSON.stringify(c)); })()`);
  assert.equal(w.eval("Lpg.bundleCost(Lpg.cfg().bundles[0])"), 3600 + 400 + 200, 'cost = full + regulator + 2 hoses');
  const r = cartAdd(w, { fullCode: f13, mode: 'set', qty: 2, bundleId: 'B1' });
  assert.equal(r.ok, true, r.msg);
  const sale = await pay(b);
  assert.equal(qty(w, '13kg (Full)'), 8); assert.equal(qty(w, 'Regulator'), 8); assert.equal(qty(w, 'Gas Hose'), 6, 'all components deducted');
  assert.equal(sale.items[0].price, 5200); assert.equal(sale.items[0].qty, 2); assert.equal(sale.items[0].lpg.components.length, 2);
  const e = env(); await push(e, 'shopA', body(w));
  const line = q(e, `select * from lpg_sale_lines where client_id = 'shopA'`)[0];
  assert.equal(line.mode, 'set'); assert.equal(line.bundle_id, 'B1'); assert.equal(line.cost, 4200); assert.equal(line.margin, (5200 - 4200) * 2);
  // not enough of a part: refused, and nothing is added
  const bad = cartAdd(w, { fullCode: f13, mode: 'set', qty: 7, bundleId: 'B1' });
  assert.equal(bad.ok, false); assert.match(bad.msg, /Not enough|Only/);
  w.eval(`pendingVoidSaleSource = 'sales'; pendingVoidReason = 'test'; performVoidSale('${sale.id}')`);
  assert.deepEqual([qty(w, '13kg (Full)'), qty(w, 'Regulator'), qty(w, 'Gas Hose')], [10, 10, 10], 'void: every part back');
  b.close();
});

test('LPG 4: a mixed cart — an exchange, a full cylinder, an accessory and an ordinary item are ONE sale with ONE payment', async () => {
  const { b, w, f13, size } = await shop();
  size('6kg', 12, 4); const f6 = find(w, '6kg (Full)').code;
  w.eval(`gasBoardPrice('${f6}', 'outright', 2200)`);
  assert.equal(cartAdd(w, { fullCode: f13, mode: 'exchange', qty: 2 }).ok, true);
  assert.equal(cartAdd(w, { fullCode: f6, mode: 'full', qty: 1 }).ok, true);
  w.eval("addToCart('REG')");
  assert.equal(j(w, 'Object.keys(currentCart).length'), 3);
  const sale = await pay(b);
  assert.equal(j(w, 'salesLog.length'), 1, 'one sale'); assert.equal(sale.items.length, 3);
  assert.equal(sale.items.reduce((n, i) => n + i.price * i.qty, 0), 2 * 1500 + 2200 + 600);
  assert.deepEqual([qty(w, '13kg (Full)'), qty(w, '13kg (Empty)'), qty(w, '6kg (Full)'), qty(w, 'Regulator')], [8, 5, 11, 9]);
  const e = env(); await push(e, 'shopA', body(w));
  assert.equal(q(e, `select count(*) n from ledger_sales where client_id = 'shopA'`)[0].n, 1);
  assert.equal(q(e, `select count(*) n from ledger_payments where client_id = 'shopA'`)[0].n, 1, 'one payment');
  assert.equal(q(e, `select count(*) n from lpg_sale_lines where client_id = 'shopA'`)[0].n, 2, 'two gas lines (the accessory is an ordinary line)');
  b.close();
});

test('LPG 5: branch isolation — each branch (its own client id) has its own cylinders, movements and stock takes', async () => {
  const A = await shop(), B = await shop('index.html', { full: 50, empty: 20 });
  cartAdd(A.w, { fullCode: A.f13, mode: 'exchange', qty: 1 }); await pay(A.b);
  cartAdd(B.w, { fullCode: B.f13, mode: 'full', qty: 3 }); await pay(B.b);
  assert.equal(qty(A.w, '13kg (Full)'), 9); assert.equal(qty(B.w, '13kg (Full)'), 47, 'one branch\'s sale never touches the other\'s stock');
  const e = env();
  await push(e, 'branchA', body(A.w)); await push(e, 'branchB', body(B.w));
  const rows = (c) => q(e, 'select state, qty, before_qty, after_qty from lpg_movements where client_id = ? and kind in (\'exchange\', \'full\') order by state', c);
  assert.deepEqual(rows('branchA'), [{ state: 'full', qty: -1, before_qty: 10, after_qty: 9 }]);
  assert.deepEqual(rows('branchB'), [{ state: 'full', qty: -3, before_qty: 50, after_qty: 47 }]);
  assert.equal(q(e, `select count(*) n from lpg_sale_lines where client_id = 'branchA'`)[0].n, 1);
  assert.equal(q(e, `select count(*) n from lpg_sale_lines where client_id = 'branchB'`)[0].n, 1);
  assert.equal(q(e, `select count(*) n from lpg_sale_lines where client_id not in ('branchA', 'branchB')`)[0].n, 0);
  // the SAME records sent for another branch land under that branch only (a client id is part of every key)
  await push(e, 'branchC', body(A.w));
  assert.equal(q(e, `select count(*) n from lpg_movements where client_id = 'branchA'`)[0].n, q(e, `select count(*) n from lpg_movements where client_id = 'branchC'`)[0].n);
  assert.equal(q(e, `select count(*) n from lpg_movements where client_id = 'branchB'`)[0].n > 0, true);
  A.b.close(); B.b.close();
});

test('LPG 6: a damaged empty handed in with an exchange goes to Damaged, a void takes it back out; damaged / repair / write-off keep a history', async () => {
  const { b, w, d, f13 } = await shop();
  assert.equal(cartAdd(w, { fullCode: f13, mode: 'exchange', qty: 1, damaged: true }).ok, true);
  const sale = await pay(b);
  assert.deepEqual([qty(w, '13kg (Full)'), qty(w, '13kg (Empty)'), find(w, '13kg (Full)').gasDamaged], [9, 3, 1], 'the empty count does not rise, Damaged does');
  w.eval(`pendingVoidSaleSource = 'sales'; pendingVoidReason = 'test'; performVoidSale('${sale.id}')`);
  assert.deepEqual([qty(w, '13kg (Full)'), qty(w, '13kg (Empty)'), find(w, '13kg (Full)').gasDamaged], [10, 3, 0]);
  assert.equal(j(w, `Lpg.damage('${f13}', 'empty_to_damaged', 2, '')`).ok, false, 'a reason is required');
  assert.equal(j(w, `Lpg.damage('${f13}', 'empty_to_damaged', 2, 'leaking valve')`).ok, true);
  assert.deepEqual([qty(w, '13kg (Empty)'), find(w, '13kg (Full)').gasDamaged], [1, 2]);
  assert.equal(j(w, `Lpg.damage('${f13}', 'damaged_to_empty', 1, 'retested')`).ok, true);
  assert.equal(j(w, `Lpg.damage('${f13}', 'damaged_writeoff', 1, 'scrapped')`).ok, true);
  assert.equal(j(w, `Lpg.damage('${f13}', 'damaged_writeoff', 1, 'scrapped')`).ok, false, 'cannot write off what is not there');
  assert.deepEqual([qty(w, '13kg (Empty)'), find(w, '13kg (Full)').gasDamaged], [2, 0]);
  const hist = j(w, "stockMovementLog.filter(m => m.lpg && ['damage','repair','writeoff'].includes(m.lpg.k)).map(m => [m.lpg.k, m.lpg.state, m.lpg.d, m.lpg.before, m.lpg.after])");
  assert.deepEqual(hist, [['damage', 'empty', -2, 3, 1], ['damage', 'damaged', 2, 0, 2], ['repair', 'damaged', -1, 2, 1], ['repair', 'empty', 1, 1, 2], ['writeoff', 'damaged', -1, 1, 0]]);
  const e = env(); assert.equal((await push(e, 'shopA', body(w))).ok, true);
  assert.equal(q(e, `select count(*) n from lpg_movements where client_id = 'shopA' and state = 'damaged'`)[0].n > 0, true);
  void d; b.close();
});

test('LPG 7: the brand rule — an exchange takes only an accepted brand; a partner brand needs an agreement; the empty is credited to the brand handed in', async () => {
  const { b, w, f13, size } = await shop();
  size('13kg', 5, 6, 'Shell');
  const shellEmpty = find(w, 'Shell 13kg (Empty)').code;
  const ownEmpty = find(w, '13kg (Empty)').code;
  const r1 = cartAdd(w, { fullCode: f13, mode: 'exchange', qty: 1, emptyCode: shellEmpty });
  assert.equal(r1.ok, false); assert.match(r1.msg, /accepted brand/);
  w.eval(`(() => { const c = Lpg.cfg(); c.partners[''] = ['Shell']; safeSetItem('pos_lpg_config', JSON.stringify(c)); })()`);
  assert.equal(j(w, `Lpg.acceptedEmpties(inventory.find(p => p.code === '${f13}')).map(p => p.code)`).includes(shellEmpty), true);
  assert.equal(cartAdd(w, { fullCode: f13, mode: 'exchange', qty: 1, emptyCode: shellEmpty }).ok, true);
  await pay(b);
  assert.deepEqual([qty(w, '13kg (Full)'), qty(w, 'Shell 13kg (Empty)'), qty(w, '13kg (Empty)')], [9, 7, 3], 'their Shell empty is credited to Shell empties, not to our own');
  void ownEmpty; b.close();
});

test('LPG 8: cart limits — the same full cylinders cannot be sold twice over in one cart (exchange + full), and a held-back count is respected', async () => {
  const { b, w, f13 } = await shop('index.html', { full: 3 });
  assert.equal(cartAdd(w, { fullCode: f13, mode: 'exchange', qty: 2 }).ok, true);
  const r = cartAdd(w, { fullCode: f13, mode: 'full', qty: 2 });
  assert.equal(r.ok, false); assert.match(r.msg, /Only 1 more/);
  assert.equal(cartAdd(w, { fullCode: f13, mode: 'full', qty: 1 }).ok, true);
  assert.equal(cartAdd(w, { fullCode: f13, mode: 'exchange', qty: 1 }).ok, false, 'all 3 are in the cart now');
  b.close();
});

test('LPG 9: a cylinder stock take — counted by anyone, nothing changes until an admin approves, then each count moves by the variance found; decided once', async () => {
  const { b, w, f13 } = await shop();
  const sub = j(w, `Lpg.takeSubmit([{ size: '${f13}', state: 'full', counted: 8 }, { size: '${f13}', state: 'empty', counted: 3 }, { size: '${f13}', state: 'damaged', counted: 1 }], 'month-end')`);
  assert.equal(sub.ok, true, sub.msg);
  assert.deepEqual([qty(w, '13kg (Full)'), qty(w, '13kg (Empty)')], [10, 3], 'counting changes nothing');
  assert.equal(j(w, 'Lpg.stockTakes()')[0].status, 'pending');
  // a sale happens between the count and the approval: it must not be overwritten
  cartAdd(w, { fullCode: f13, mode: 'full', qty: 1 }); await pay(b);
  assert.equal(qty(w, '13kg (Full)'), 9);
  w.eval("currentServer = { id: 'st1', name: 'Jane' }");
  const no = j(w, `Lpg.takeDecide('${sub.id}', true)`);
  assert.equal(no.ok, false); assert.match(no.msg, /Only an admin/);
  w.eval('currentServer = null');
  const ok = j(w, `Lpg.takeDecide('${sub.id}', true)`);
  assert.equal(ok.ok, true, ok.msg);
  assert.equal(qty(w, '13kg (Full)'), 7, '9 now, and the count found 2 fewer than expected (8 vs 10) = 7'); assert.equal(qty(w, '13kg (Empty)'), 3); assert.equal(find(w, '13kg (Full)').gasDamaged, 1);
  assert.equal(j(w, 'Lpg.stockTakes()')[0].status, 'approved');
  assert.equal(j(w, `Lpg.takeDecide('${sub.id}', true)`).ok, false, 'a decided count cannot be decided again');
  assert.equal(qty(w, '13kg (Full)'), 7, 'and nothing moved the second time');
  // server: the count, its decision and the adjustment
  const e = env(); await push(e, 'shopA', body(w));
  const st = q(e, `select state, expected, counted, variance, status, decided_by from lpg_stocktakes where client_id = 'shopA' order by state`);
  assert.deepEqual(st.map((x) => [x.state, x.expected, x.counted, x.variance, x.status]), [['damaged', 0, 1, 1, 'approved'], ['empty', 3, 3, 0, 'approved'], ['full', 10, 8, -2, 'approved']]);
  assert.throws(() => e.LEDGER_DB._db.exec(`update lpg_stocktakes set counted = 99 where client_id = 'shopA'`), /cannot be changed/);
  assert.throws(() => e.LEDGER_DB._db.exec(`update lpg_stocktakes set status = 'rejected' where client_id = 'shopA'`), /cannot be changed/);
  assert.throws(() => e.LEDGER_DB._db.exec(`delete from lpg_stocktakes`), /cannot be deleted/);
  // a rejected count changes nothing
  const sub2 = j(w, `Lpg.takeSubmit([{ size: '${f13}', state: 'empty', counted: 0 }])`);
  assert.equal(j(w, `Lpg.takeDecide('${sub2.id}', false)`).ok, true);
  assert.equal(qty(w, '13kg (Empty)'), 3);
  b.close();
});

test('LPG 10: the movement history can never be edited or deleted in the database, and the database refuses a state it does not know', async () => {
  const { b, w, f13 } = await shop();
  cartAdd(w, { fullCode: f13, mode: 'full', qty: 1 }); await pay(b);
  const e = env(); await push(e, 'shopA', body(w));
  assert.throws(() => e.LEDGER_DB._db.exec(`update lpg_movements set qty = 99`), /append-only/);
  assert.throws(() => e.LEDGER_DB._db.exec(`delete from lpg_movements`), /append-only/);
  assert.throws(() => e.LEDGER_DB._db.exec(`insert into lpg_movements (client_id, mv_id, ts, size_code, state, kind, qty) values ('x','y',1,'z','lost','sale',1)`), /CHECK/);
  b.close();
});

test('LPG 11: the history screen shows before / change / after / why / sale, the reports add up, the dashboard cards are drawn, and the counter has its 🔥 Gas button', async () => {
  const { b, w, d, f13 } = await shop();
  cartAdd(w, { fullCode: f13, mode: 'exchange', qty: 2 }); cartAdd(w, { fullCode: f13, mode: 'full', qty: 1 }); await pay(b);
  w.eval('renderGasTab()');
  const html = d.getElementById('lpg-panels').textContent;
  assert.match(html, /Movement history/); assert.match(html, /Exchange — empty received/); assert.match(html, /Exchange — full given/);
  const s = j(w, 'Lpg.summary(0, Date.now() + 1000)');
  assert.equal(s.tot.qty, 3); assert.equal(s.tot.rev, 2 * 1500 + 4500); assert.equal(s.tot.cost, 2 * 900 + 3600); assert.equal(s.tot.margin, 7500 - 5400);
  assert.equal(s.by.exchange[0], 2); assert.equal(s.by.full[0], 1);
  assert.match(d.querySelector('#lpg-panels .lpg-cards').textContent, /Exchanges today/);
  const btn = d.getElementById('lpg-counter-btn');
  assert.ok(btn, 'the Sales Counter has a Gas button'); assert.notEqual(btn.style.display, 'none');
  w.eval('Lpg.open()'); assert.equal(d.getElementById('lpg-modal').classList.contains('on'), true);
  assert.equal(d.querySelectorAll('#lpg-modal .lpg-tile').length, 4, 'Buy Full / Exchange Empty / Buy Cylinder / Buy Set');
  w.eval("Lpg.pick('mode', 'exchange')"); assert.match(d.getElementById('lpg-modal').textContent, /Exchange Empty/);
  w.eval('Lpg.submit(false)'); assert.equal(d.getElementById('lpg-modal').classList.contains('on'), false); assert.equal(j(w, 'Object.keys(currentCart).length'), 1);
  // no history drift after normal trading
  assert.match(d.getElementById('lpg-panels').textContent + '', /Gas reports/);
  b.close();
});

test('LPG 12: opening balance — the first time the gas tab opens, every size gets one opening line per state, once (deterministic ids)', async () => {
  const { w, b } = await shop();
  w.eval('renderGasTab(); renderGasTab()');
  const open = j(w, "stockMovementLog.filter(m => m.lpg && m.lpg.k === 'opening').map(m => m.id)");
  assert.equal(open.length, 4); assert.equal(new Set(open).size, 4);
  b.close();
});

test('LPG 13: migration 0011 is the generated schema and creates the tables by itself', () => {
  const file = fs.readFileSync(path.join(ROOT, 'migrations/0011_lpg.sql'), 'utf8');
  assert.equal(file, lpgMigrationText());
  const db = makeD1();
  db._db.exec(file);
  for (const t of ['lpg_movements', 'lpg_sale_lines', 'lpg_stocktakes']) assert.equal(db.query(`select count(*) n from sqlite_master where name = ?`, t)[0].n, 1, t);
  db._db.exec(file);                                                                                      // safe to run twice
  assert.ok(LPG_SCHEMA.length >= 8);
});

test('LPG 14: a checkout that fails half-way puts EVERYTHING back — full, empty, the Damaged counter and a set\'s parts — and counters the gas movements', async () => {
  const { b, w, f13 } = await shop();
  w.eval(`(() => { const c = Lpg.cfg(); c.bundles.push({ id: 'B1', name: 'Starter set', size: '${f13}', comps: [{ code: 'REG', qty: 1 }], price: 5000, active: true }); safeSetItem('pos_lpg_config', JSON.stringify(c)); })()`);
  assert.equal(cartAdd(w, { fullCode: f13, mode: 'exchange', qty: 1, damaged: true }).ok, true);
  assert.equal(cartAdd(w, { fullCode: f13, mode: 'set', qty: 2, bundleId: 'B1' }).ok, true);
  w.eval("window.__g = checkoutGuardStart(); deductEntriesForBillRoot(Object.values(currentCart))");
  assert.deepEqual([qty(w, '13kg (Full)'), find(w, '13kg (Full)').gasDamaged, qty(w, 'Regulator')], [7, 1, 8], 'taken');
  w.eval("checkoutGuardFailed(window.__g, new Error('boom'))");
  assert.deepEqual([qty(w, '13kg (Full)'), qty(w, '13kg (Empty)'), find(w, '13kg (Full)').gasDamaged, qty(w, 'Regulator')], [10, 3, 0, 10], 'all back');
  const back = j(w, "stockMovementLog.filter(m => m.reverses && m.lpg).map(m => [m.lpg.state, m.lpg.k, m.lpg.d])");
  assert.ok(back.some((x) => x[0] === 'damaged' && x[2] === -1), 'the Damaged +1 is countered by a -1 with its gas note');
  assert.equal(back.filter((x) => x[0] === 'full').reduce((n, x) => n + x[2], 0), 3, 'the full cylinders taken (1 + 2) are countered');
  b.close();
});

test('LPG 15: at payment the cart is checked ONCE MORE as a whole (an exchange and a full cylinder of the same size draw on the same count)', async () => {
  const { b, w, f13 } = await shop('index.html', { full: 3 });
  cartAdd(w, { fullCode: f13, mode: 'exchange', qty: 2 }); cartAdd(w, { fullCode: f13, mode: 'full', qty: 1 });
  w.eval(`currentCart['${f13}::gas-full--'].qty = 2`);                                        // the stepper looks at one line only
  assert.match(w.eval('Lpg.validateCart()'), /Not enough "13kg \(Full\)" in stock .*3 in stock, the cart needs 4/);
  w.eval("currentPaymentMethod = 'cash'"); b.d.getElementById('cash-tendered-input').value = '1000000';
  await w.eval('checkoutCart()');
  assert.equal(j(w, 'salesLog.length'), 0, 'no sale was made'); assert.equal(qty(w, '13kg (Full)'), 3);
  assert.match(String(w.eval('window.__toasts.slice(-1)[0]')), /Not enough/);
  w.eval(`currentCart['${f13}::gas-full--'].qty = 1`);
  await w.eval('checkoutCart()');
  assert.equal(j(w, 'salesLog.length'), 1); assert.equal(qty(w, '13kg (Full)'), 0);
  b.close();
});

test('LPG 16: a stock take approved after cylinders went out never takes a count below zero; a partner brand\'s damaged empty is counted under that brand', async () => {
  const { b, w, f13, size } = await shop();
  const sub = j(w, `Lpg.takeSubmit([{ size: '${f13}', state: 'full', counted: 0 }])`);       // 10 expected, none found
  cartAdd(w, { fullCode: f13, mode: 'full', qty: 8 }); await pay(b);                         // 2 left
  assert.equal(j(w, `Lpg.takeDecide('${sub.id}', true)`).ok, true);
  assert.equal(qty(w, '13kg (Full)'), 0, '2 left, the variance was -10: clamped at 0, never negative');
  size('13kg', 4, 4, 'Shell'); const shellFull = find(w, 'Shell 13kg (Full)').code, shellEmpty = find(w, 'Shell 13kg (Empty)').code;
  w.eval(`gasBoardPrice('${shellFull}', 'refill', 1400)`);
  w.eval(`(() => { const c = Lpg.cfg(); c.partners['Shell'] = ['']; safeSetItem('pos_lpg_config', JSON.stringify(c)); })()`);
  const ownEmpty = find(w, '13kg (Empty)').code;
  assert.equal(cartAdd(w, { fullCode: shellFull, mode: 'exchange', qty: 1, emptyCode: ownEmpty, damaged: true }).ok, true);
  await pay(b);
  assert.equal(find(w, '13kg (Full)').gasDamaged, 1, 'it is a plain-brand cylinder: counted under the plain brand'); assert.equal(find(w, 'Shell 13kg (Full)').gasDamaged || 0, 0);
  void shellEmpty; b.close();
});
