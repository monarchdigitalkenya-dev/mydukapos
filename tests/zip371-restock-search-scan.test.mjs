import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 371: restock finds variants by code/name, one tap fills the full name, a scan in Inventory searches Inventory.
const QUIET = "window.__toasts = []; showToast = function (m, e) { window.__toasts.push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = () => ''; window.print = () => {};";
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ITEMS = [
  { code: 'SOCK', type: 'item', name: 'Cotton Socks', price: 200, wholesalePrice: 80, qty: 30, unit: 'pcs', hasVariants: true, vatCategory: 'A',
    variants: [{ id: 'v1', name: 'Large Red', code: 'SOCK-LR', barcode: '6001', price: 220, wholesalePrice: 90, qty: 10 }, { id: 'v2', name: 'Small Blue', code: 'SOCK-SB', barcode: '6002', price: 200, wholesalePrice: 80, qty: 20 }] },
  { code: 'COLA', type: 'item', name: 'Cola 500ml', price: 70, wholesalePrice: 50, qty: 24, unit: 'pcs', vatCategory: 'A', barcode: '5449' },
  { code: 'COLB', type: 'item', name: 'Cola Zero 500ml', price: 70, wholesalePrice: 52, qty: 12, unit: 'pcs', vatCategory: 'A' },
  { code: '', type: 'item', name: 'Loose Sugar', price: 150, wholesalePrice: 120, qty: 5, unit: 'kg', vatCategory: 'A' },
];
const open = () => boot('index.html', { storage: { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' }, wait: 1500 });
const names = (w, q) => J(w, `itemSuggestMatches(${JSON.stringify(q)}, 'restock').map(e => e.name)`);

test('restock search lists variants (name, variant name, code, barcode, words in any order); a parent is never offered', async () => {
  const d = await open();
  try {
    const w = d.w; w.eval(QUIET);
    assert.deepEqual(names(w, 'socks').sort(), ['Cotton Socks (Large Red)', 'Cotton Socks (Small Blue)']);
    assert.deepEqual(names(w, 'large'), ['Cotton Socks (Large Red)'], 'one word of the VARIANT name is enough');
    assert.deepEqual(names(w, 'red large socks'), ['Cotton Socks (Large Red)'], 'words in any order');
    assert.deepEqual(names(w, 'sock-sb'), ['Cotton Socks (Small Blue)'], 'by variant code');
    assert.deepEqual(names(w, '6001'), ['Cotton Socks (Large Red)'], 'by variant barcode');
    assert.deepEqual(names(w, 'socklr'), ['Cotton Socks (Large Red)'], 'with no dash');
    assert.equal(names(w, 'cola').length, 2); assert.deepEqual(names(w, 'zero cola'), ['Cola Zero 500ml']);
    assert.deepEqual(names(w, 'cola 500').sort(), ['Cola 500ml', 'Cola Zero 500ml']);
    assert.ok(!names(w, 'socks').includes('Cotton Socks'), 'the parent cannot be restocked');
    assert.deepEqual(names(w, 'nothing-like-this'), []);
  } finally { d.close(); }
});

test('typing a variant by its code or its full name restocks THAT variant (no new item is created)', async () => {
  const d = await open();
  try {
    const w = d.w; w.eval(QUIET);
    w.eval("restockDraft = [{ rowId: 1, code: '', name: 'sock-lr', unit: 'pcs', qty: '5', cost: '95', wholesaleSell: '', sellPrice: '' }, { rowId: 2, code: '', name: 'cotton socks (small blue)', unit: 'pcs', qty: '4', cost: '85', wholesaleSell: '', sellPrice: '' }]; renderRestockRows();");
    w.eval('completeRestock()'); await sleep(300);
    const p = J(w, "inventory.find(p => p.code === 'SOCK')");
    assert.equal(J(w, 'inventory.length'), 4, 'no new item');
    assert.deepEqual(p.variants.map((v) => v.qty), [15, 24]); assert.equal(p.qty, 39, 'parent total = sum of its variants');
    assert.deepEqual(p.variants.map((v) => v.wholesalePrice), [95, 85]);
    const ex = J(w, "expenses[expenses.length - 1]"); assert.equal(ex.amount, 5 * 95 + 4 * 85, 'the expense is exactly what was bought');
  } finally { d.close(); }
});

test('ONE tap on a drop-down entry fills the code AND the full name, and the next box is ready (mouse, and phone tap)', async () => {
  const d = await open();
  try {
    const w = d.w; w.eval(QUIET);
    w.eval("restockDraft = []; addRestockRow(); renderRestockRows();");
    const input = () => w.document.querySelector('#restock-rows-tbody input[data-suggest="restock"]');
    input().focus(); input().value = 'larg'; input().dispatchEvent(new w.Event('input', { bubbles: true })); await sleep(50);
    const box = w.document.getElementById('item-suggest-box'); assert.equal(box.style.display, 'block');
    const opt = box.querySelector('.is-opt'); assert.match(opt.textContent, /Cotton Socks \(Large Red\)/); assert.match(opt.textContent, /SOCK-LR/);
    // a phone: touchstart + touchend (no movement) = ONE pick
    const touch = (type, x, y) => { const ev = new w.Event(type, { bubbles: true, cancelable: true }); const t = { clientX: x, clientY: y }; ev.touches = [t]; ev.changedTouches = [t]; opt.dispatchEvent(ev); };
    touch('touchstart', 10, 10); touch('touchend', 11, 10);
    assert.deepEqual(J(w, 'restockDraft.map(r => [r.code, r.name])'), [['SOCK-LR', 'Cotton Socks (Large Red)']]);
    assert.equal(input().value, 'Cotton Socks (Large Red)', 'the full name, not the few letters typed');
    assert.equal(J(w, 'restockDraft[0].cost'), '90', 'the variant\'s own last cost');
    assert.equal(box.style.display, 'none');
    // the phone also sends a copy of the tap as a mouse event: it must not pick a second time or break anything
    w.document.body.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    assert.equal(J(w, 'restockDraft.length'), 1);
    // a DRAG on the list (finger moves) only scrolls: nothing is picked
    w.eval("restockDraft[0].name = ''; restockDraft[0].code = ''; renderRestockRows();");
    input().focus(); input().value = 'cola'; input().dispatchEvent(new w.Event('input', { bubbles: true })); await sleep(30);
    const o2 = w.document.getElementById('item-suggest-box').querySelector('.is-opt');
    const t2 = (type, x, y) => { const ev = new w.Event(type, { bubbles: true, cancelable: true }); const t = { clientX: x, clientY: y }; ev.touches = [t]; ev.changedTouches = [t]; o2.dispatchEvent(ev); };
    t2('touchstart', 10, 10); t2('touchend', 10, 80);
    assert.equal(J(w, 'restockDraft[0].code'), '', 'a drag did not pick');
    // the page scrolling (phone keyboard opening) does NOT hide the list while its box is focused
    input().focus(); w.document.getElementById('item-suggest-box').style.display = 'block';
    w.dispatchEvent(new w.Event('scroll')); w.document.dispatchEvent(new w.Event('scroll', { bubbles: true }));
    assert.equal(w.document.getElementById('item-suggest-box').style.display, 'block');
  } finally { d.close(); }
});

test('an item with NO code can still be picked (it used to pick nothing or the wrong item)', async () => {
  const d = await open();
  try {
    const w = d.w; w.eval(QUIET);
    w.eval("restockDraft = []; addRestockRow(); renderRestockRows();");
    const input = w.document.querySelector('#restock-rows-tbody input[data-suggest="restock"]');
    input.focus(); input.value = 'sugar'; input.dispatchEvent(new w.Event('input', { bubbles: true })); await sleep(30);
    w.document.querySelector('#item-suggest-box .is-opt').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    assert.equal(J(w, 'restockDraft[0].name'), 'Loose Sugar'); assert.equal(J(w, 'restockDraft[0].unit'), 'kg');
  } finally { d.close(); }
});

test('Purchases tab: the same drop-down (variants too); picking fills the exact variant and saving restocks it', async () => {
  const d = await open();
  try {
    const w = d.w; w.eval(QUIET);
    w.document.getElementById('purchases-tab-btn').click(); await sleep(200);
    const n0 = () => w.document.getElementById('mt-p-n0');
    assert.equal(n0().getAttribute('data-suggest'), 'mtp'); assert.equal(n0().getAttribute('list'), null, 'no second (native) drop-down');
    n0().focus(); n0().value = 'small'; n0().dispatchEvent(new w.Event('input', { bubbles: true })); await sleep(30);
    const opt = w.document.querySelector('#item-suggest-box .is-opt'); assert.match(opt.textContent, /Small Blue/);
    opt.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true })); await sleep(60);
    assert.equal(n0().value, 'Cotton Socks (Small Blue)'); assert.equal(w.document.getElementById('mt-p-c0').value, '80', 'its last cost is filled');
    w.document.getElementById('mt-p-q0').value = '6'; w.document.getElementById('mt-p-q0').dispatchEvent(new w.Event('input', { bubbles: true }));
    w.document.querySelector('[data-mt="save-pur"]').click(); await sleep(600);
    const p = J(w, "inventory.find(p => p.code === 'SOCK')");
    assert.equal(J(w, 'inventory.length'), 4); assert.deepEqual(p.variants.map((v) => v.qty), [10, 26]); assert.equal(p.qty, 36);
  } finally { d.close(); }
});

test('a scan on the Inventory list searches the inventory (item code, barcode, variant barcode); not found says so; Sales still adds to cart', async () => {
  const d = await open();
  try {
    const w = d.w; w.eval(QUIET);
    w.document.querySelector('.tab-link[data-tab="inventory-list-tab"]').click(); await sleep(200);
    assert.ok(w.document.getElementById('inventory-list-tab').classList.contains('active'));
    w.eval("handleBarcodeScan('5449')"); await sleep(100);
    assert.ok(w.document.getElementById('inventory-list-tab').classList.contains('active'), 'stays on Inventory');
    assert.equal(w.document.getElementById('inventory-search-input').value, '5449');
    assert.ok(w.__toasts.some((m) => /Found: Cola 500ml/.test(m)));
    assert.match(w.document.getElementById('inventory-list-tab').textContent, /Cola 500ml/); assert.doesNotMatch(w.document.getElementById('inventory-table-body') ? w.document.getElementById('inventory-table-body').textContent : '', /Cotton Socks/);
    assert.equal(J(w, 'Object.keys(currentCart).length'), 0, 'nothing was added to the cart');
    w.eval("handleBarcodeScan('6002')"); await sleep(100);
    assert.ok(w.__toasts.some((m) => /Found: Cotton Socks/.test(m)), 'a variant barcode finds its parent');
    w.eval("handleBarcodeScan('999999')"); await sleep(100);
    assert.ok(w.__toasts.some((m) => /ERR No item with code "999999"/.test(m)));
    // the Sales Counter still adds to the cart
    w.document.querySelector('.tab-link[data-tab="sales-tab"]').click(); await sleep(100);
    w.eval("handleBarcodeScan('5449')"); await sleep(100);
    assert.equal(J(w, 'Object.keys(currentCart).length'), 1);
  } finally { d.close(); }
});
