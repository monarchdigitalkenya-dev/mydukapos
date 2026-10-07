import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 244 - (1) Add Item / Bulk Add: "already exists" window (update / variant / version), (2) Hotel: hide "All items" / "All <category>",
// (3) Hotel: order of categories, sub-categories and items (typed numbers, most popular...), (4) Daily Sales: keep open.
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const click = (d, sel) => { const b = d.querySelector(sel); assert.ok(b, 'missing ' + sel); b.click(); };
const setv = (d, id, v) => { const el = d.getElementById(id); assert.ok(el, 'no #' + id); el.value = v; el.dispatchEvent(new d.defaultView.Event('input', { bubbles: true })); el.dispatchEvent(new d.defaultView.Event('change', { bubbles: true })); };
const quiet = (w) => w.eval("showToast = function (m) { window.__toast = m; }; window.confirm = () => true;");
const MANGO = { code: 'MS1', type: 'item', name: 'Mango Shake', category: 'Drinks', price: 200, wholesalePrice: 100, qty: 12, unit: 'pcs' };
const fillForm = (d, o) => { for (const [k, v] of Object.entries(o)) setv(d, 'inv-' + k, v); };

test('D1: Add Item - the same name (other capitals / spaces) opens the window instead of an error; Update adds the stock and the price', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify([MANGO]) }, wait: 900 }); const { w, d } = b; quiet(w);
  fillForm(d, { name: 'mango  SHAKE', price: '250', qty: '5' });
  w.eval('saveInventoryItem()');
  assert.ok(d.getElementById('dupi-ov'), 'window opened');
  assert.match(d.getElementById('dupi-box').textContent, /already exists/);
  assert.equal(J(w, 'inventory.length'), 1, 'nothing added yet');
  click(d, '[data-act="panel"][data-p="upd"]');
  click(d, '[data-act="do-upd"]');
  assert.equal(J(w, 'inventory.length'), 1);
  const it = J(w, 'inventory[0]');
  assert.equal(it.price, 250); assert.equal(it.qty, 17, '12 + 5');
  assert.equal(it.name, 'Mango Shake', 'the existing name is kept');
  assert.ok(J(w, "(typeof stockMovementLog !== 'undefined' ? stockMovementLog : []).some(m => m.code === 'MS1' && m.delta === 5 || m.qty === 5)"), 'written to the stock history');
  assert.equal(d.getElementById('dupi-ov'), null, 'window closed');
  assert.equal(d.getElementById('inv-name').value, '', 'form cleared');
  b.close();
});

test('D2: Add as a variant turns a plain item into a variants item (the old one becomes the first variant, with its stock)', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify([MANGO]) }, wait: 900 }); const { w, d } = b; quiet(w);
  fillForm(d, { name: 'Mango Shake', price: '350', qty: '4' });
  w.eval('saveInventoryItem()');
  click(d, '[data-act="panel"][data-p="var"]');
  setv(d, 'dupi-vname', '');
  click(d, '[data-act="do-var"]');
  assert.match(d.getElementById('dupi-err').textContent, /variant name/i, 'a name is required');
  setv(d, 'dupi-vname', 'Large');
  click(d, '[data-act="do-var"]');
  const it = J(w, 'inventory[0]');
  assert.equal(J(w, 'inventory.length'), 1);
  assert.equal(it.hasVariants, true); assert.equal(it.variants.length, 2);
  assert.deepEqual(it.variants.map((v) => v.name), ['Original', 'Large']);
  assert.match(it.variants[0].code, /^MS1-ORIGINAL/, 'a code of its own (the server keeps variant stock per variant code)'); assert.notEqual(it.variants[0].code, it.code); assert.equal(it.variants[0].qty, 12); assert.equal(it.variants[0].price, 200);
  assert.equal(it.variants[1].qty, 4); assert.equal(it.variants[1].price, 350); assert.match(it.variants[1].code, /^MS1-LARGE/);
  assert.equal(it.qty, 16, 'parent = sum'); assert.equal(it.price, 200, 'parent price = cheapest');
  b.close();
});

test('D3: an item that already has variants: update picks the variant; a variant name that exists is updated, not duplicated', async () => {
  const V = { ...MANGO, hasVariants: true, qty: 12, variants: [{ id: 'v1', name: 'Small', code: 'MS1-S', price: 150, qty: 5, wholesalePrice: 70 }, { id: 'v2', name: 'Large', code: 'MS1-L', price: 250, qty: 7, wholesalePrice: 120 }] };
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify([V]) }, wait: 900 }); const { w, d } = b; quiet(w);
  fillForm(d, { name: 'Mango Shake', price: '260', qty: '3' });
  w.eval('saveInventoryItem()');
  click(d, '[data-act="panel"][data-p="upd"]');
  setv(d, 'dupi-vsel', 'v2');
  click(d, '[data-act="do-upd"]');
  let it = J(w, 'inventory[0]');
  assert.equal(it.variants[1].qty, 10); assert.equal(it.variants[1].price, 260); assert.equal(it.variants[0].qty, 5, 'the other variant is untouched');
  assert.equal(it.qty, 15);
  fillForm(d, { name: 'Mango Shake', price: '0', qty: '2' });
  w.eval('saveInventoryItem()');
  click(d, '[data-act="panel"][data-p="var"]');
  setv(d, 'dupi-vname', 'small');
  click(d, '[data-act="do-var"]');
  it = J(w, 'inventory[0]');
  assert.equal(it.variants.length, 2, 'no duplicate variant'); assert.equal(it.variants[0].qty, 7);
  b.close();
});

test('D4: a typed name that is NOT already there still saves normally; Cancel changes nothing', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify([MANGO]) }, wait: 900 }); const { w, d } = b; quiet(w);
  fillForm(d, { name: 'Passion Juice', price: '120', qty: '6' });
  w.eval('saveInventoryItem()');
  assert.equal(d.getElementById('dupi-ov'), null);
  assert.equal(J(w, 'inventory.length'), 2);
  fillForm(d, { name: 'MANGO shake!', price: '1', qty: '1' });
  w.eval('saveInventoryItem()');
  assert.ok(d.getElementById('dupi-ov'));
  click(d, '[data-act="close"]');
  assert.equal(d.getElementById('dupi-ov'), null);
  assert.equal(J(w, 'inventory.length'), 2); assert.equal(J(w, "inventory.find(p => p.code==='MS1').qty"), 12);
  assert.equal(d.getElementById('inv-name').value, 'MANGO shake!', 'what was typed is kept');
  b.close();
});

test('D5: Hotel has no variants - the window offers "another version" and saves "Name — Version" as its own item', async () => {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify([MANGO]) }, wait: 1200 }); const { w, d } = b; quiet(w);
  fillForm(d, { name: 'Mango Shake', price: '320', qty: '9' });
  w.eval('saveInventoryItem()');
  assert.ok(d.getElementById('dupi-ov'));
  assert.equal(d.querySelector('[data-act="panel"][data-p="var"]'), null, 'no variant button here');
  click(d, '[data-act="panel"][data-p="ver"]');
  setv(d, 'dupi-vname', 'Large');
  click(d, '[data-act="do-ver"]');
  const inv = J(w, 'inventory');
  assert.equal(inv.length, 2); const n = inv.find((p) => p.code !== 'MS1');
  assert.equal(n.name, 'Mango Shake — Large'); assert.equal(n.price, 320); assert.equal(n.qty, 9);
  assert.equal(inv.find((p) => p.code === 'MS1').qty, 12, 'the old item is untouched');
  b.close();
});

test('D6: Bulk Add - rows that exist ask first (update by default), new rows are added, nothing is duplicated', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify([MANGO]) }, wait: 900 }); const { w, d } = b; quiet(w);
  w.eval(`bulkCategory = ''; bulkAddRows = [
    { id: 'r1', code: '', name: 'mango shake', nameDirty: true, price: '260', wholesaleSellingPrice: '', wholesalePrice: '', unit: 'pcs', qty: '3', location: '' },
    { id: 'r2', code: '', name: 'Brand New Soda', nameDirty: true, price: '90', wholesaleSellingPrice: '', wholesalePrice: '', unit: 'pcs', qty: '8', location: '' },
    { id: 'r3', code: 'MS1', name: 'Something else', nameDirty: true, price: '5', wholesaleSellingPrice: '', wholesalePrice: '', unit: 'pcs', qty: '1', location: '' } ];`);
  w.eval('saveBulkItems()');
  assert.ok(d.getElementById('dupi-ov'), 'window opened');
  assert.equal(d.querySelectorAll('.dupi-bulk tr').length, 2, 'the two rows that match (by name, by code)');
  assert.equal(J(w, 'inventory.length'), 1, 'nothing saved before the answer');
  // row 2 of the window (the code match): skip it
  const sels = [...d.querySelectorAll('select[data-act="bact"]')]; sels[1].value = 'skip'; sels[1].dispatchEvent(new w.Event('change', { bubbles: true }));
  click(d, '[data-act="do-bulk"]');
  const inv = J(w, 'inventory');
  assert.equal(inv.length, 2, 'only Brand New Soda is new');
  assert.equal(inv.find((p) => p.code === 'MS1').qty, 15, '12 + 3'); assert.equal(inv.find((p) => p.code === 'MS1').price, 260);
  assert.ok(inv.some((p) => p.name === 'Brand New Soda' && p.qty === 8));
  assert.match(w.__toast, /1 item\(s\) added/); assert.match(w.__toast, /1 existing updated/); assert.match(w.__toast, /1 skipped/);
  b.close();
});

test('D7: Bulk Add - every row existing + "add as variants"; a missing variant name is asked for', async () => {
  const b = await boot('index.html', { storage: { pos_inventory: JSON.stringify([MANGO]) }, wait: 900 }); const { w, d } = b; quiet(w);
  w.eval(`bulkCategory = ''; bulkAddRows = [ { id: 'r1', code: '', name: 'Mango Shake', nameDirty: true, price: '300', wholesaleSellingPrice: '', wholesalePrice: '', unit: 'pcs', qty: '2', location: '' } ];`);
  w.eval('saveBulkItems()');
  const sel = d.querySelector('select[data-act="bact"]'); sel.value = 'var'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  click(d, '[data-act="do-bulk"]');
  assert.match(d.getElementById('dupi-err').textContent, /variant name/i);
  d.querySelector('input[data-act="bname"]').value = 'Jumbo'; d.querySelector('input[data-act="bname"]').dispatchEvent(new w.Event('input', { bubbles: true }));
  click(d, '[data-act="do-bulk"]');
  const it = J(w, 'inventory');
  assert.equal(it.length, 1); assert.equal(it[0].hasVariants, true); assert.deepEqual(it[0].variants.map((v) => v.name), ['Original', 'Jumbo']);
  assert.match(w.__toast, /Nothing new added/); assert.match(w.__toast, /1 added as variant/);
  b.close();
});

/* ---------------- Hotel: hide, sort ---------------- */
const dish = (code, name, category, price, extra = {}) => ({ code, type: 'service', name, category, price, unit: 'pcs', ...extra });
const HOTEL = [
  dish('M1', 'Choc shake', 'Milkshakes', 200), dish('M2', 'Vanilla shake', 'Milkshakes', 100), dish('M3', 'Mango shake', 'Milkshakes', 200), dish('M4', 'Berry shake', 'Milkshakes', 100),
  dish('P1', 'Pizza', 'Mains', 800), dish('P2', 'Burger', 'Mains', 500), dish('P3', 'Chicken', 'Mains', 650), dish('D1', 'Cola', 'Drinks', 50),
];
const SALES = [{ id: 's1', timestamp: new Date().toISOString(), items: [{ code: 'P3', qty: 30, price: 650 }, { code: 'M2', qty: 9, price: 100 }, { code: 'M4', qty: 6, price: 100 }, { code: 'P1', qty: 2, price: 800 }, { code: 'D1', qty: 1, price: 50 }] }];
async function hotel() {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(HOTEL), pos_sales_log: JSON.stringify(SALES), pos_cat_tiles: 'true' }, wait: 1300 });
  quiet(b.w);
  const w = b.w, d = b.d;
  w.eval(`document.body.insertAdjacentHTML('beforeend','<input id="hosp-sub-new"><div id="hosp-sub-box"></div>')`);
  const catId = J(w, "hospScreenChips('sales').find(c => /milkshakes/i.test(c.label)).id");
  for (const n of ['200', '100']) { d.getElementById('hosp-sub-new').value = n; w.eval(`hospSubAdd('${catId}')`); }
  const subs = J(w, `hospSubList('${catId}')`);
  w.eval(`hospSubAssign('M1','${subs[0].id}'); hospSubAssign('M3','${subs[0].id}'); hospSubAssign('M2','${subs[1].id}'); hospSubAssign('M4','${subs[1].id}')`);
  w.eval('window.__catTiles.back(); window.__catTiles.refresh()');
  return { b, w, d, catId, subs };
}
const tiles = (d) => [...d.querySelectorAll('#ctl-host [data-ctl]')].filter((x) => x.getAttribute('data-ctl') !== 'root' && x.getAttribute('data-ctl') !== 'up').map((x) => x.textContent.replace(/\d+$/, '').trim());
const tileNames = (d) => [...d.querySelectorAll('#ctl-host .ctl-pname, #ctl-host .ctl-name')].map((x) => x.textContent.trim());

test('H1: Hotel - the "All items" and "All Milkshakes" buttons can be hidden (shop-wide setting, saved and sent with the settings)', async () => {
  const { b, w, d } = await hotel();
  assert.ok(tileNames(d).includes('All items'), 'shown by default');
  w.eval('__catTiles.renderPanel()');
  const sw = d.getElementById('ctl-hide-items'); assert.ok(sw); sw.checked = true; sw.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.ok(!tileNames(d).includes('All items'), 'hidden');
  assert.deepEqual(tileNames(d).sort(), ['Drinks', 'Mains', 'Milkshakes']);
  w.eval("__catTiles.open('Milkshakes')");
  assert.ok(tileNames(d).includes('All Milkshakes'), 'still there inside the category');
  const sw2 = d.getElementById('ctl-hide-cat'); assert.ok(sw2); sw2.checked = true; sw2.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.deepEqual(tileNames(d), ['200', '100'], 'only the sub-categories');
  assert.deepEqual(J(w, 'collectSyncPayload().catHideAll'), { items: true, cat: true });
  w.eval("__catTiles.apply({ catHideAll: { items: false, cat: false } })");
  assert.ok(tileNames(d).includes('All Milkshakes'), 'another device turned it off');
  b.close();
});

test('S1: Hotel - sub-categories: most popular / most items / Z-A; categories: most popular uses the Hotel\'s own sales', async () => {
  const { b, w, d, subs } = await hotel();
  w.eval("__catTiles.open('Milkshakes')");
  assert.deepEqual(tileNames(d), ['All Milkshakes', '200', '100'], 'standard');
  w.eval("__ctlSetSubMode('sales')");                     // 100: 15 sold, 200: 0
  assert.deepEqual(tileNames(d), ['All Milkshakes', '100', '200']);
  w.eval("__ctlSetSubMode('name-desc')");
  assert.deepEqual(tileNames(d), ['All Milkshakes', '200', '100'], 'Z to A');
  w.eval("__ctlSetSubMode('name')");
  assert.deepEqual(tileNames(d), ['All Milkshakes', '100', '200']);
  w.eval("__ctlSetSubMode('same'); __ctlSetOrderMode('sales')");   // categories by units sold: Mains 32, Milkshakes 15, Drinks 1
  assert.deepEqual(J(w, '__catTiles.categories().map(c => c.label)'), ['Mains', 'Milkshakes', 'Drinks']);
  w.eval("__ctlSetOrderMode('items')");
  assert.deepEqual(J(w, '__catTiles.categories().map(c => c.label)'), ['Milkshakes', 'Mains', 'Drinks'], '4 / 3 / 1 items');
  assert.ok(subs.length === 2);
  b.close();
});

test('S2: Hotel - items: A-Z, price, most popular, and "my own order" typed as numbers (and ▲ ▼), per category, also in the All view', async () => {
  const { b, w, d, catId } = await hotel();
  const codes = (js) => J(w, js);
  w.eval(`hospCatPick('sales','${catId}')`);
  const order = () => codes("hospScreenItems('sales','').list.map(e => e.rec.code)");
  assert.deepEqual(order().slice(0, 1), ['M2'], 'standard = best sellers first');
  w.eval("__ctlSetItemMode('name')"); assert.deepEqual(order(), ['M4', 'M1', 'M3', 'M2']);
  w.eval("__ctlSetItemMode('price-high')"); assert.deepEqual(order(), ['M1', 'M3', 'M2', 'M4'], 'ties keep the standard order');
  w.eval("__ctlSetItemMode('price-low')"); assert.deepEqual(order().slice(0, 2), ['M2', 'M4']);
  w.eval("__ctlSetItemMode('sales')"); assert.deepEqual(order().slice(0, 2), ['M2', 'M4']);
  // manual: the editor lists this category's items; type 1 into Mango's box
  w.eval("__ctlSetItemMode('manual'); window.__ctlIordCat = '" + catId + "'; __catTiles.renderPanel()");
  const box = (code) => [...d.querySelectorAll('#ctl-panel .ctl-pos[data-ctl-pos="item"]')].find((x) => decodeURIComponent(x.getAttribute('data-k')) === code);
  assert.ok(box('M3'), 'item editor shown');
  box('M3').value = '1'; box('M3').dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(order()[0], 'M3', 'moved to position 1');
  assert.equal(box('M3').value, '1');
  const mv = [...d.querySelectorAll('#ctl-panel [data-ctl-act="mvi"]')].find((x) => decodeURIComponent(x.getAttribute('data-k')) === 'M3' && x.getAttribute('data-d') === '1'); mv.click();
  assert.equal(order()[1], 'M3', 'one down');
  assert.deepEqual(J(w, '__catTiles.order().items["' + catId + '"]').slice(0, 2), [order()[0], 'M3']);
  assert.equal(J(w, 'collectSyncPayload().catOrder.imode'), 'manual', 'travels with the shop settings');
  // another category's list is its own
  w.eval("hospCatPick('sales', hospScreenChips('sales').find(c => /mains/i.test(c.label)).id)");
  assert.deepEqual(order(), ['P2', 'P3', 'P1'], 'Mains has no saved order yet: A-Z (Burger, Chicken, Pizza)');
  b.close();
});

test('S3: Hotel - typing a position for a sub-category and a category (manual), and the order is applied on the counter', async () => {
  const { b, w, d } = await hotel();
  w.eval("__ctlSetOrderMode('manual'); __ctlSetSubMode('manual'); __catTiles.renderPanel()");
  const pos = (kind, key) => [...d.querySelectorAll('#ctl-panel .ctl-pos')].find((x) => x.getAttribute('data-ctl-pos') === kind && decodeURIComponent(x.getAttribute('data-k')) === key);
  const first = J(w, '__catTiles.categories().map(c => c.label)');
  const last = first[first.length - 1];
  pos('cat', last).value = '1'; pos('cat', last).dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(J(w, '__catTiles.categories()[0].label'), last, 'category moved to the top');
  const subKey = 'Milkshakes › 100';
  pos('sub', subKey).value = '1'; pos('sub', subKey).dispatchEvent(new w.Event('change', { bubbles: true }));
  w.eval("__catTiles.open('Milkshakes')");
  assert.deepEqual(tileNames(d), ['All Milkshakes', '100', '200']);
  b.close();
});

/* ---------------- Daily Sales: keep open ---------------- */
test('P1: Hotel - Daily Sales: "Keep open" shows the panel at once, after a reload too; the 💰 button un-pins; default unchanged', async () => {
  const b = await boot('hotel/index.html', { wait: 1000 }); const { w, d } = b; quiet(w);
  const shown = () => d.getElementById('my-sales-panel').style.display !== 'none';
  assert.equal(shown(), false, 'default: hidden');
  w.eval('toggleMySalesPanel()'); assert.equal(shown(), true, 'the button still opens it'); w.eval('toggleMySalesPanel()'); assert.equal(shown(), false);
  d.getElementById('my-sales-toggle-btn').click(); assert.equal(shown(), true);
  const pin = d.getElementById('my-sales-pin'); pin.checked = true; pin.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(w.localStorage.getItem('pos_sales_pinned'), '1');
  assert.equal(shown(), true);
  w.eval('toggleMySalesPanel()');                         // pinned: the button tucks it away and un-pins
  assert.equal(shown(), false); assert.equal(w.localStorage.getItem('pos_sales_pinned'), '0');
  // Settings > View has the same switch
  w.eval("document.getElementById('sales-pin-toggle') && 0");
  b.close();
  const b2 = await boot('hotel/index.html', { storage: { pos_sales_pinned: '1' }, wait: 1500 });
  assert.equal(b2.d.getElementById('my-sales-panel').style.display !== 'none', true, 'shown after a reload');
  assert.match(b2.d.getElementById('my-sales-list').textContent, /Daily Sales/);
  b2.close();
});

test('P2: other apps (shared panel) - the same switch works, and Settings > View carries it', async () => {
  const b = await boot('index.html', { storage: { pos_sales_pinned: '1' }, wait: 1800 }); const { w, d } = b; quiet(w);
  assert.notEqual(d.getElementById('pos-sq-panel').style.display, 'none', 'pinned = showing after a reload');
  const sw = d.getElementById('sales-pin-toggle'); assert.ok(sw, 'switch in Settings > View'); assert.equal(sw.checked, true);
  sw.checked = false; sw.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(w.localStorage.getItem('pos_sales_pinned'), '0');
  assert.equal(d.getElementById('pos-sq-panel').style.display, 'none');
  d.getElementById('my-sales-toggle-btn').click(); assert.notEqual(d.getElementById('pos-sq-panel').style.display, 'none');
  b.close();
});
