import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Stock Take tab: count the shelf, type the counts, update the system's quantities in one go (only counted items change; recorded as "Stock take").
const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html'];
const INV = JSON.stringify([
  { code: 'A1', type: 'item', name: 'Alpha Tin', price: 100, wholesalePrice: 20, qty: 10, unit: 'pcs', vatCategory: 'A' },
  { code: 'B2', type: 'item', name: 'Beta Pack', price: 50, wholesalePrice: 10, qty: 5, unit: 'pcs', vatCategory: 'A' },
  { code: 'C3', type: 'item', name: 'Gamma Bag', price: 80, wholesalePrice: 40, qty: 50, unit: 'pcs', vatCategory: 'A' },
  { code: 'D4', type: 'item', name: 'Delta Box', price: 300, wholesalePrice: 200, qty: 4, pieceQty: 3, dualUnit: true, unitsPerBox: 10, pieceWholesalePrice: 20, unit: 'box', vatCategory: 'A' },
  { code: 'S1', type: 'service', name: 'Fitting', price: 500, unit: 'use', vatCategory: 'A' },
]);
const type = (d, w, code, field, value) => { w.eval(`stockTakeSet('${code}', '${field}', ${JSON.stringify(value)})`); };
const cell = (d, code) => (d.querySelector(`#stock-take-table tr[data-code="${code}"] .st-diff`) || {}).textContent || '';

for (const app of APPS) {
  test(`${app}: Stock Take tab — counts show differences valued at cost, and applying updates only the counted items and logs them`, async () => {
    const { w, d, errors, close } = await boot(app, { storage: { pos_inventory: INV }, wait: 1500 });
    w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }; window.confirm = () => true");
    assert.ok(d.getElementById('stock-take-tab-btn'), 'the tab button is there');
    d.getElementById('stock-take-tab-btn').click();
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(d.getElementById('stock-take-tab').classList.contains('active'), 'the tab opens');
    const codes = [...d.querySelectorAll('#stock-take-table tbody tr[data-code]')].map((tr) => tr.dataset.code);
    assert.deepEqual(codes, ['A1', 'B2', 'D4', 'C3'].sort((a, b) => ({ A1: 'Alpha', B2: 'Beta', D4: 'Delta', C3: 'Gamma' }[a]).localeCompare({ A1: 'Alpha', B2: 'Beta', D4: 'Delta', C3: 'Gamma' }[b])), 'stock items only (no service), by name');
    assert.equal(d.getElementById('stock-take-apply-btn').disabled, true, 'nothing counted yet');
    type(d, w, 'A1', 'qty', '8');                        // 2 short (20 each at cost = 40)
    type(d, w, 'B2', 'qty', '5');                        // matches
    type(d, w, 'D4', 'qty', '4'); type(d, w, 'D4', 'pieceQty', '5');   // boxes match, +2 loose (20 each = 40)
    assert.match(cell(d, 'A1'), /-2/); assert.match(cell(d, 'B2'), /matches/); assert.match(cell(d, 'D4'), /matches[\s\S]*\+2 loose/);
    const sum = d.getElementById('stock-take-summary').textContent;
    assert.match(sum, /3 counted/); assert.match(sum, /2 differ/); assert.match(sum, /missing stock worth KES 40/); assert.match(sum, /extra stock worth KES 40/);
    assert.equal(d.getElementById('stock-take-apply-btn').disabled, false);
    // a typo blocks the update
    type(d, w, 'C3', 'qty', 'abc');
    assert.match(cell(d, 'C3'), /Not a number/); assert.equal(d.getElementById('stock-take-apply-btn').disabled, true);
    type(d, w, 'C3', 'qty', '');
    assert.equal(d.getElementById('stock-take-apply-btn').disabled, false);
    // cancelling the confirmation changes nothing
    w.eval('window.confirm = () => false');
    assert.equal(w.eval('stockTakeApply()'), false);
    assert.equal(w.eval('inventory.find(p => p.code === "A1").qty'), 10);
    w.eval('window.confirm = () => true');
    assert.equal(w.eval('stockTakeApply()'), true);
    assert.equal(w.eval('inventory.find(p => p.code === "A1").qty'), 8, 'counted item updated');
    assert.equal(w.eval('inventory.find(p => p.code === "B2").qty'), 5);
    assert.equal(w.eval('inventory.find(p => p.code === "C3").qty'), 50, 'an item that was not counted is never touched');
    assert.equal(w.eval('inventory.find(p => p.code === "D4").pieceQty'), 5, 'loose pieces updated');
    assert.equal(w.eval('inventory.find(p => p.code === "D4").qty'), 4);
    const log = JSON.parse(w.eval('JSON.stringify(stockMovementLog.filter(m => m.reason === "Stock take"))'));
    assert.deepEqual(log.map((m) => [m.code, m.delta, m.unit]).sort(), [['A1', -2, 'qty'], ['D4', 2, 'pieceQty']].sort(), 'each change is a Stock take adjustment');
    assert.equal(JSON.parse(w.localStorage.getItem('pos_inventory')).find((p) => p.code === 'A1').qty, 8, 'saved on the device');
    assert.match((w.__toasts || []).join(' '), /Stock take applied: 2 items updated/);
    assert.equal(d.getElementById('stock-take-apply-btn').disabled, true, 'counts are cleared after applying');
    assert.match(d.getElementById('stock-take-history').textContent, /2 updated of 3 counted/);
    assert.match(d.getElementById('stock-take-history').textContent, /missing KES 40/);
    assert.deepEqual(errors, []);
    close();
  });
}

test('search and "only differences" narrow the list; "same" fills in the system figure; all-match applies nothing', async () => {
  const { w, d, close } = await boot('index.html', { storage: { pos_inventory: INV }, wait: 1500 });
  w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }; window.confirm = () => true");
  w.eval('renderStockTake()');
  d.getElementById('stock-take-search').value = 'gamma'; d.getElementById('stock-take-search').dispatchEvent(new w.Event('input'));
  assert.deepEqual([...d.querySelectorAll('#stock-take-table tbody tr[data-code]')].map((t) => t.dataset.code), ['C3']);
  d.getElementById('stock-take-search').value = ''; d.getElementById('stock-take-search').dispatchEvent(new w.Event('input'));
  w.eval("stockTakeMatches('C3'); stockTakeMatches('A1')");
  assert.match(cell(d, 'C3'), /matches/);
  d.getElementById('stock-take-diff-only').checked = true; d.getElementById('stock-take-diff-only').dispatchEvent(new w.Event('change'));
  assert.match(d.querySelector('#stock-take-table tbody').textContent, /No differences to show/);
  assert.equal(w.eval('stockTakeApply()'), true);
  assert.match((w.__toasts || []).join(' '), /All 2 counts match the system/);
  assert.equal(w.eval('stockMovementLog.filter(m => m.reason === "Stock take").length'), 0);
  close();
});

test('the per-row "💾 Update" button applies just that one item immediately, with no bulk confirm dialog', async () => {
  const { w, d, close } = await boot('index.html', { storage: { pos_inventory: INV }, wait: 1500 });
  // If stockTakeApplyOne ever needed a confirm() the way the bulk apply
  // does, this would throw — proving the per-row path genuinely skips it.
  w.eval("showToast = function (m) { window.__toasts = (window.__toasts || []).concat(m); }; window.confirm = () => { throw new Error('should not be asked to confirm a single-row update'); }");
  w.eval('renderStockTake()');
  type(d, w, 'A1', 'qty', '8');   // 2 short
  type(d, w, 'C3', 'qty', '55');  // +5, but deliberately left untouched below
  assert.equal(w.eval("stockTakeApplyOne('A1')"), true);
  assert.equal(w.eval("inventory.find(p => p.code === 'A1').qty"), 8, 'the counted item is updated to exactly the typed count');
  assert.equal(w.eval("inventory.find(p => p.code === 'B2').qty"), 5, 'an untouched item is unaffected');
  assert.equal(w.eval("inventory.find(p => p.code === 'C3').qty"), 50, "a DIFFERENT counted-but-not-yet-applied item is untouched by A1's update");
  assert.equal(w.eval("stockTakeState().counts['A1']"), undefined, "A1's own input is cleared once applied — obviously done");
  assert.ok(w.eval("stockTakeState().counts['C3']"), "C3's still-pending count is untouched, not swept up by A1's update");
  assert.equal(w.eval('stockMovementLog.filter(m => m.code === "A1" && m.reason === "Stock take").length'), 1, 'logged the same way the bulk apply logs each item');
  assert.match((w.__toasts || []).join(' '), /Alpha Tin.*updated/);
  // Applying an item whose count already matches the system just clears
  // the row instead of logging a no-op "Stock take" movement.
  type(d, w, 'B2', 'qty', '5');
  assert.equal(w.eval("stockTakeApplyOne('B2')"), true);
  assert.equal(w.eval('stockMovementLog.filter(m => m.code === "B2" && m.reason === "Stock take").length'), 0, 'a matching count applies as a no-op, not a movement');
  close();
});

test('Aqua POS now has its own per-site Stock Take tab (zip 118b; see tests/water-stock-ledger.test.mjs for the sync side)', async () => {
  const { d, errors, close } = await boot('water/index.html', { wait: 1200 });
  assert.ok(d.getElementById('stock-take-tab-btn'));
  assert.ok(d.getElementById('aqua-st-table'));
  assert.deepEqual(errors, []);
  close();
});

test('#9: a stock take writing off more than the limit needs the management password; below it, it does not; below-zero items are flagged', async () => {
  const { w, d, close } = await boot('index.html', { storage: { pos_inventory: INV, pos_admin_pw_hash: 'x'.repeat(64) }, wait: 1500 });
  w.eval("showToast = function () {}; window.confirm = () => true");
  w.eval("localStorage.setItem('pos_st_approval_kes', '100')");
  w.eval('renderStockTake()');
  type(d, w, 'C3', 'qty', '40');                                                    // 10 missing x 40 = KES 400 > 100
  assert.equal(w.eval('stockTakeApply()'), false);
  assert.equal(d.getElementById('admin-pw-modal').style.display, 'flex', 'asks for the password');
  assert.equal(w.eval("inventory.find(p => p.code === 'C3').qty"), 50, 'nothing changed yet');
  await w.eval('dispatchAdminPwPurpose()');                                         // the password was accepted
  assert.equal(w.eval("inventory.find(p => p.code === 'C3').qty"), 40, 'applied once approved');
  type(d, w, 'A1', 'qty', '9');                                                     // KES 20: under the limit
  assert.equal(w.eval("stockTakeApplyOne('A1')"), true);
  w.eval("inventory.find(p => p.code === 'B2').qty = -2; renderStockTake()");
  assert.match(d.getElementById('stock-take-summary').textContent, /1 item is below zero/);
  close();
});
