import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, until } from './helpers.mjs';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

// Zip 159 - Hotel POS: dynamic inventory categories (per existing inventory type), category chips + images on the Sales Counter and the
// Orders tab, category management, and per-type / "All" Excel-CSV import. The inventory types are never listed by the code under test:
// they come from HOSP_INV_CATS / hospInvKindOf / the records themselves.
const INV = () => [
  { code: 'A1', type: 'item', name: 'Soda', category: 'Drinks', price: 100, wholesalePrice: 60, qty: 10, unit: 'pcs', vatCategory: 'A' },
  { code: 'A2', type: 'item', name: 'Water', category: 'drinks', price: 50, wholesalePrice: 30, qty: 10, unit: 'pcs', image: 'https://x.test/water.jpg' },
  { code: 'A3', type: 'item', name: 'Empty Bottle', category: 'Drinks', price: 20, qty: 0, unit: 'pcs' },
  { code: 'D1', type: 'service', name: 'Burger', category: 'Drinks', price: 500, unit: 'pcs' },
  { code: 'D2', type: 'service', name: 'Pizza', category: 'Mains', price: 800, unit: 'pcs' },
  { code: 'I1', type: 'ingredient', name: 'Flour', category: 'Mains', qty: 5, wholesalePrice: 10, unit: 'kg' },
  { code: 'N1', type: 'item', name: 'Plain Item', price: 10, qty: 3, unit: 'pcs' },
  { code: 'SVC-1', type: 'service', name: 'Room Cleaning', category: 'Extras', price: 300, unit: 'use' },
];
const UT = () => [{ id: 'u1', name: 'Plates', qty: 10, category: 'Crockery' }, { id: 'u2', name: 'Forks', qty: 30 }];
const J = (w, js) => { const r = w.eval(`JSON.stringify(${js})`); return r === undefined ? undefined : JSON.parse(r); };
async function app(inv = INV(), extra = {}) {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(inv), pos_utensils: JSON.stringify(UT()), ...(extra.storage || {}) }, wait: 1200, ...(extra.opts || {}) });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = () => null");
  return b;
}
const chipLabels = (d, id) => [...d.querySelectorAll(`#${id} .hcat-chip`)].map((b) => b.textContent.replace(/\d+$/, '').trim());
const cellNames = (d) => [...d.querySelectorAll('#item-image-grid .igc-name')].map((e) => e.textContent);
const svcNames = (d) => [...d.querySelectorAll('#svc-menu .svc-menu-btn strong')].map((e) => e.textContent);
const kindId = (w, k) => J(w, `hospCatKinds().some(x => x.id === '${k}')`);
const asStaff = (w, roles, extra = {}) => w.eval(`staff.push({ id: 'st1', name: 'Sam', roles: ${JSON.stringify(roles)}, ...${JSON.stringify(extra)} }); currentServer = { id: 'st1', name: 'Sam' };`);
const CSV = (rows) => rows.map((r) => r.map((c) => /[",\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',')).join('\n');
async function importText(w, ctx, text, name = 'f.csv') {
  w.eval(`hospImportOpen('${ctx}')`);
  await w.eval(`hospImpLoadRows(hospImpParseText(${JSON.stringify(text)}), '${name}')`);
}

test('types are discovered, never listed: they follow HOSP_INV_CATS and any type found on a record', async () => {
  const b = await app(); const { w } = b;
  assert.deepEqual(J(w, "hospCatKinds().map(k => k.id)"), J(w, "HOSP_INV_CATS.filter(x => x[0] !== 'all').map(x => x[0])"), 'exactly the types the inventory screen already has');
  for (const k of ['item', 'ingredient', 'dish', 'service', 'utensil', 'bar']) assert.ok(kindId(w, k), k);
  // a type the prompt never mentions: added to the app's own list -> categories, chips, import all follow
  w.eval("HOSP_INV_CATS.push(['spa', '💆 Spa treatments']); inventory.push({ code: 'SPA1', type: 'item', hospKind: 'spa', name: 'Massage', category: 'Body', price: 3000, qty: 1, unit: 'pcs' }); hospCatTouch()");
  assert.ok(kindId(w, 'spa'), 'the new type is a type');
  assert.equal(J(w, "hospCatFind('cat-spa-body').name"), 'Body');
  assert.equal(J(w, "hospCatCreate('spa', 'Facials').ok"), true, 'categories can be created under it');
  // a type found ONLY on a record (nobody listed it anywhere)
  w.eval("inventory.push({ code: 'GX1', type: 'gadget', name: 'Gizmo', category: 'Tech', price: 5, qty: 1, unit: 'pcs' }); hospCatTouch()");
  assert.ok(kindId(w, 'gadget'), 'an unknown type on a record shows up as a type');
  assert.equal(J(w, "hospCatKindText('gadget')"), 'Gadget');
  assert.equal(J(w, "hospCatCreate('gadget', 'Toys').ok"), true);
  w.eval("hospImportOpen('gadget')");
  assert.equal(J(w, "hospImp.ctx"), 'gadget', 'import is available for it');
  const r = await (async () => { await w.eval("hospImpLoadRows(hospImpParseText('Name,Price,Qty\\nWidget,10,4'), 'g.csv')"); return w.eval('hospImpCommit()'); })();
  assert.equal(r.created, 1);
  assert.equal(J(w, "inventory.find(p => p.name === 'Widget').type"), 'gadget', 'created under that very type');
  b.close();
});

test('legacy category names become categories per type without touching a single record', async () => {
  const before = INV();
  const b = await app(before); const { w } = b;
  const cats = J(w, "[...hospCatIndex().cats.values()].map(c => c.id + '|' + c.kind + '|' + c.name).sort()");
  assert.deepEqual(cats, ['cat-dish-drinks|dish|Drinks', 'cat-dish-mains|dish|Mains', 'cat-ingredient-mains|ingredient|Mains', 'cat-item-drinks|item|Drinks', 'cat-service-extras|service|Extras', 'cat-utensil-crockery|utensil|Crockery']);
  assert.deepEqual(J(w, 'hospCategories'), [], 'nothing was written: the categories are derived, not saved');
  assert.deepEqual(J(w, 'inventory'), before, 'records are untouched');
  assert.equal(J(w, "hospCatIndex().counts.get('cat-item-drinks')"), 3, 'Drinks / drinks / Drinks are one category (case ignored)');
  assert.equal(J(w, "hospCatIndex().uncat.get('item')"), 1, 'the record with no category is Uncategorized');
  assert.equal(J(w, "hospCatIndex().uncat.get('utensil')"), 1);
  // two tills converge on the same ids
  const b2 = await app(before); assert.deepEqual(J(b2.w, "[...hospCatIndex().cats.keys()].sort()"), J(w, "[...hospCatIndex().cats.keys()].sort()"));
  b.close(); b2.close();
});

test('same category name under two types stays two categories; the same name twice under ONE type is refused', async () => {
  const b = await app(); const { w } = b;
  const a = J(w, "hospCatCreate('item', 'Specials')"), c = J(w, "hospCatCreate('dish', 'Specials')");
  assert.ok(a.ok && c.ok && a.cat.id !== c.cat.id, 'two separate categories with two ids');
  assert.equal(J(w, "hospCatCreate('item', ' specials ').ok"), false, 'no duplicate inside a type');
  w.eval(`hospCatAssign(['A1'], '${a.cat.id}', 'item'); hospCatAssign(['D2'], '${c.cat.id}', 'dish')`);
  assert.equal(J(w, "hospCatIndex().counts.get('" + a.cat.id + "')"), 1);
  assert.equal(J(w, "hospCatIndex().counts.get('" + c.cat.id + "')"), 1);
  assert.equal(J(w, "inventory.find(p => p.code === 'A1').categoryId"), a.cat.id);
  b.close();
});

test('create, rename (mirror name follows), deactivate, reorder, delete-with-move; records are never deleted', async () => {
  const b = await app(); const { w } = b;
  w.eval("hospConfig.categoryStations = { Mains: 'kitchen' }; offers.push({ id: 'o1', scope: 'category', targets: [{ kind: 'category', category: 'Mains' }] })");
  const n0 = J(w, 'inventory.length');
  // rename a legacy (virtual) category: it is adopted, every record of it follows, the station setting moves with the name
  const rn = J(w, "hospCatRename('cat-dish-mains', 'Main Course')");
  assert.ok(rn.ok);
  assert.equal(J(w, "inventory.find(p => p.code === 'D2').category"), 'Main Course', 'compatibility mirror updated');
  assert.equal(J(w, "inventory.find(p => p.code === 'D2').categoryId"), 'cat-dish-mains');
  assert.equal(J(w, "inventory.find(p => p.code === 'I1').category"), 'Mains', 'the Ingredient "Mains" is another category and is untouched');
  assert.equal(J(w, "hospConfig.categoryStations['Main Course']"), undefined, 'Mains is still used by the ingredient, so the station keeps its name');
  assert.equal(J(w, "hospCatRename('cat-dish-mains', 'DRINKS').ok"), false, 'a name already used in this type is refused');
  assert.equal(J(w, "hospCatIndex().cats.get('cat-dish-mains').name"), 'Main Course');
  // deactivate: hidden from the chips, the records are still in "All"
  w.eval("hospCatSetActive('cat-item-drinks', false)");
  w.eval("renderItemImageGrid('')");
  assert.ok(!chipLabels(b.d, 'sc-cat-bar').some((l) => /Drinks · Items/.test(l)), 'inactive category is not offered');
  assert.equal(cellNames(b.d).includes('Soda'), true, 'but its records are still sold under All');
  w.eval("hospCatSetActive('cat-item-drinks', true)");
  // reorder
  const ord0 = J(w, "hospCatsOf('dish').map(c => c.name)");
  w.eval("hospCatMove('cat-dish-mains', 1)");
  const ord1 = J(w, "hospCatsOf('dish').map(c => c.name)");
  assert.notDeepEqual(ord1, ord0, 'the order changed');
  assert.ok(J(w, "hospCategories.every(c => typeof c.order === 'number')"), 'the order is stored on real records');
  // delete with a move to another category
  const mk = J(w, "hospCatCreate('item', 'Soft drinks')");
  const del = J(w, `hospCatDelete('cat-item-drinks', '${mk.cat.id}')`);
  assert.ok(del.ok); assert.equal(del.moved, 3);
  assert.equal(J(w, "inventory.find(p => p.code === 'A1').category"), 'Soft drinks');
  assert.equal(J(w, "inventory.find(p => p.code === 'A1').categoryId"), mk.cat.id);
  assert.equal(J(w, "hospCategories.find(c => c.id === 'cat-item-drinks')._deleted"), true, 'a tombstone stays, so it cannot come back');
  assert.equal(J(w, "hospCatFind('cat-item-drinks')"), null);
  // delete with a move to Uncategorized
  const del2 = J(w, "hospCatDelete('cat-dish-drinks', null)");
  assert.ok(del2.ok);
  assert.equal(J(w, "inventory.find(p => p.code === 'D1').categoryId"), undefined);
  assert.equal(J(w, "inventory.find(p => p.code === 'D1').category"), undefined);
  assert.equal(J(w, "hospCatIndex().entries.get('D1').catId"), null, 'Uncategorized, still a record');
  // a move into another TYPE's category is refused, and nothing was lost
  assert.equal(J(w, "hospCatDelete('cat-dish-mains', 'cat-ingredient-mains').ok"), false);
  assert.equal(J(w, 'inventory.length'), n0, 'no record was ever deleted');
  assert.ok(J(w, "adminActivityLog.some(a => a.sectionId === 'inventory-categories' && /deleted/.test(a.sectionLabel))"), 'audited');
  b.close();
});

test('bulk assign: only a category of the records\' own type; a cross-type assignment is refused whole-record by whole-record', async () => {
  const b = await app(); const { w } = b;
  const r = J(w, "hospCatAssign(['A1', 'D2', 'ut:u1'], 'cat-item-drinks', 'item')");
  assert.equal(r.ok, false);
  assert.equal(r.changed, 1, 'A1 (legacy name) is adopted into the real category; the two bad records change nothing');
  assert.deepEqual(r.rejected.map((x) => x.key).sort(), ['D2', 'ut:u1'], 'the dish and the utensil are refused');
  const mk = J(w, "hospCatCreate('item', 'Snacks')");
  const r2 = J(w, `hospCatAssign(['N1', 'A1'], '${mk.cat.id}', 'item')`);
  assert.ok(r2.ok); assert.equal(r2.changed, 2);
  assert.equal(J(w, "hospCatAssign(['D2'], '" + mk.cat.id + "', 'dish').ok"), false, 'the caller\'s own type must match the category');
  assert.equal(J(w, "inventory.find(p => p.code === 'D2').category"), 'Mains', 'the dish kept its category');
  // utensils live in their own list and get the same feature
  const uc = J(w, "hospCatCreate('utensil', 'Cutlery')");
  assert.ok(J(w, `hospCatAssign(['ut:u2'], '${uc.cat.id}', 'utensil').ok`));
  assert.equal(J(w, "utensils.find(u => u.id === 'u2').category"), 'Cutlery');
  // Uncategorized
  assert.ok(J(w, "hospCatAssign(['N1'], null, 'item').ok"));
  assert.equal(J(w, "hospCatIndex().entries.get('N1').catId"), null);
  b.close();
});

test('Sales Counter: chips come from the data, the filter is real (search, All, Uncategorized, stock, Show more), images lazy with a placeholder', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("renderItemImageGrid('')");
  assert.deepEqual(chipLabels(d, 'sc-cat-bar'), ['All', 'Drinks · Items', 'Drinks · Dishes', 'Mains', 'Extras', 'Uncategorized'], 'chips: the categories of what the counter sells (no ingredient "Mains", no utensils); same name in two types is told apart');
  assert.equal(d.querySelector('#sc-cat-bar .hcat-chip').style.minHeight || 'css', 'css');
  const click = (label) => { [...d.querySelectorAll('#sc-cat-bar .hcat-chip')].find((x) => x.textContent.replace(/\d+$/, '').trim() === label).click(); };
  assert.equal(cellNames(d).length, 7, 'All: every sellable record (ingredient excluded)');
  click('Drinks · Items');
  assert.deepEqual(cellNames(d).sort(), ['Empty Bottle', 'Soda', 'Water']);
  assert.ok(d.querySelector('#item-image-grid .item-grid-cell.out-of-stock .igc-name'), 'stock rule kept: 0 in stock is greyed');
  w.eval("liveSearch('wat')");
  assert.deepEqual(cellNames(d), ['Water'], 'search works inside the category');
  w.eval("liveSearch('burger')");
  assert.deepEqual(cellNames(d), [], 'a dish is not in the item category');
  assert.match(d.getElementById('item-image-grid').textContent, /Nothing in this category/);
  w.eval("liveSearch('')");
  click('Mains'); assert.deepEqual(cellNames(d), ['Pizza']);
  click('Uncategorized'); assert.deepEqual(cellNames(d), ['Plain Item']);
  click('All'); assert.equal(cellNames(d).length, 7);
  // images: lazy + async, a placeholder (with the type's own icon) when there is none
  click('Drinks · Items');
  const img = d.querySelector('#item-image-grid img');
  assert.equal(img.getAttribute('loading'), 'lazy'); assert.equal(img.getAttribute('decoding'), 'async');
  assert.match(img.getAttribute('src'), /water\.jpg/);
  assert.ok([...d.querySelectorAll('#item-image-grid .igc-noimg')].length >= 1, 'no image -> placeholder, never a broken <img>');
  w.eval("hospImgFail(document.querySelector('#item-image-grid img'))");
  assert.equal(d.querySelectorAll('#item-image-grid img').length, 0, 'a picture that fails to load becomes the placeholder');
  // the choice is remembered on this device
  assert.equal(w.localStorage.getItem('pos_hosp_catsel_sales'), 'cat-item-drinks');
  // tapping a cell still sells it
  click('All'); w.eval("document.querySelector('.item-grid-cell[data-code=\"A1\"]').click()");
  assert.equal(J(w, "Object.keys(currentCart).length"), 1);
  b.close();
  // remembered across a reload; a remembered category that no longer exists falls back to All
  const b2 = await app(INV(), { storage: { }, opts: { beforeParse: (win) => win.localStorage.setItem('pos_hosp_catsel_sales', 'cat-dish-mains') } });
  b2.w.eval("renderItemImageGrid('')");
  assert.deepEqual(cellNames(b2.d), ['Pizza']);
  b2.w.localStorage.setItem('pos_hosp_catsel_sales', 'cat-gone'); b2.w.eval("renderItemImageGrid('')");
  assert.equal(cellNames(b2.d).length, 7);
  b2.close();
});

test('Sales Counter paging: "Show more" pages a big category (60 at a time) and a new filter starts again at 60', async () => {
  const inv = []; for (let i = 0; i < 150; i++) inv.push({ code: 'B' + String(i).padStart(3, '0'), type: 'item', name: 'Beer ' + String(i).padStart(3, '0'), category: 'Beers', price: 100 + i, qty: 5, unit: 'pcs' });
  inv.push({ code: 'W1', type: 'item', name: 'Wine', category: 'Wines', price: 900, qty: 5, unit: 'pcs' });
  const b = await app(inv); const { w, d } = b;
  w.eval("renderItemImageGrid('')");
  assert.equal(cellNames(d).length, 60, 'no more than a page');
  assert.match(d.querySelector('#item-image-grid .hcat-more').textContent, /Show 60 more \(91 left\)/);
  d.querySelector('#item-image-grid .hcat-more').click();
  assert.equal(cellNames(d).length, 120);
  d.querySelector('#item-image-grid .hcat-more').click();
  assert.equal(cellNames(d).length, 151, 'everything is reachable, nothing is capped any more');
  assert.equal(d.querySelector('#item-image-grid .hcat-more'), null);
  w.eval("hospCatPick('sales', 'cat-item-beers')"); assert.equal(cellNames(d).length, 60, 'a new filter starts at one page again');
  w.eval("liveSearch('Beer 14')"); assert.equal(cellNames(d).length, 10, 'Beer 140..149 + Beer 14 itself? (name contains) -> 11 without the .. check');
  b.close();
});

test('Orders tab: same chips, same filter, images, paging', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("renderSvcMenu()");
  assert.deepEqual(chipLabels(d, 'svc-cat-bar'), ['All', 'Drinks · Items', 'Drinks · Dishes', 'Mains', 'Extras', 'Uncategorized']);
  assert.equal(svcNames(d).length, 7);
  w.eval("hospCatPick('orders', 'cat-dish-mains')"); assert.deepEqual(svcNames(d), ['Pizza']);
  w.eval("document.getElementById('svc-item-search').value = 'piz'; renderSvcMenu()"); assert.deepEqual(svcNames(d), ['Pizza']);
  w.eval("document.getElementById('svc-item-search').value = 'soda'; renderSvcMenu()"); assert.deepEqual(svcNames(d), [], 'search + category together');
  w.eval("document.getElementById('svc-item-search').value = ''; hospCatPick('orders', 'cat-item-drinks')");
  assert.deepEqual(svcNames(d).sort(), ['Empty Bottle', 'Soda', 'Water']);
  assert.equal(d.querySelectorAll('#svc-menu .svc-menu-btn[disabled]').length, 1, 'existing out-of-stock rule kept');
  assert.equal(d.querySelector('#svc-menu img').getAttribute('loading'), 'lazy');
  assert.ok(d.querySelector('#svc-menu .svc-noimg'), 'placeholder');
  assert.deepEqual(J(w, "svcMenuItems('soda').map(p => p.code)"), ['A1'], 'svcMenuItems still answers for its callers');
  // the Sales Counter and the Orders tab keep separate memories but share the one category data
  assert.equal(w.localStorage.getItem('pos_hosp_catsel_orders'), 'cat-item-drinks');
  assert.equal(w.localStorage.getItem('pos_hosp_catsel_sales'), null);
  w.eval("svcAdd('A1')"); assert.equal(J(w, 'svcDraft.lines.length'), 1, 'adding to the order still works');
  b.close();
});

test('Orders paging over a big menu keeps every record reachable', async () => {
  const inv = []; for (let i = 0; i < 130; i++) inv.push({ code: 'S' + i, type: 'service', name: 'Dish ' + String(i).padStart(3, '0'), category: 'Mains', price: 100, unit: 'pcs' });
  const b = await app(inv); const { w, d } = b;
  w.eval("renderSvcMenu()"); assert.equal(svcNames(d).length, 60);
  d.querySelector('#svc-menu .hcat-more').click(); d.querySelector('#svc-menu .hcat-more').click();
  assert.equal(svcNames(d).length, 130);
  b.close();
});

test('the category manager: create / rename / active / reorder / delete-with-move / bulk assign, all from its screen', async () => {
  const b = await app(); const { w, d } = b;
  assert.ok(w.eval("hospCatOpenManager('item')"));
  assert.match(d.getElementById('hcat-list').textContent, /Drinks/);
  d.getElementById('hcat-new').value = 'Snacks'; w.eval('hospCatUiCreate()');
  assert.ok(J(w, "hospCatsOf('item').some(c => c.name === 'Snacks')"));
  assert.match(d.getElementById('hcat-list').textContent, /Snacks/);
  d.getElementById('hcat-q').value = 'snack'; w.eval("hospCatUi.q = 'snack'; hospCatUiRenderList()");
  assert.equal(d.querySelectorAll('#hcat-list .hcat-row').length, 2, 'category search: the match + the built-in Uncategorized row');
  w.eval("hospCatUi.q = ''; hospCatUiRenderList()");
  // records list filtered by category, bulk assign
  w.eval("hospCatUi.filter = '__uncat'; hospCatUiRenderRecs()");
  assert.equal(d.querySelectorAll('#hcat-recs tbody tr').length, 1);
  const snacks = J(w, "hospCatsOf('item').find(c => c.name === 'Snacks').id");
  w.eval(`hospCatUiToggle('N1', true); document.getElementById('hcat-bulk-to').value = '${snacks}'; hospCatUiBulk()`);
  assert.equal(J(w, "inventory.find(p => p.code === 'N1').category"), 'Snacks');
  // per-row move
  w.eval("hospCatUi.filter = '__all'; hospCatUiRenderRecs(); hospCatUiAssignOne('A2', '')");
  assert.equal(J(w, "hospCatIndex().entries.get('A2').catId"), null);
  // delete panel: cancel keeps everything, confirm moves the records
  w.eval(`hospCatUiAskDelete('${snacks}')`); assert.match(d.getElementById('hcat-list').textContent, /will NOT be deleted/);
  w.eval("hospCatUi.del = null; hospCatUiRenderList()"); assert.ok(J(w, `!!hospCatFind('${snacks}')`), 'cancel');
  w.eval(`hospCatUiAskDelete('${snacks}'); document.getElementById('hcat-del-to').value = ''; hospCatUiDoDelete('${snacks}')`);
  assert.equal(J(w, "inventory.find(p => p.code === 'N1').category"), undefined);
  assert.ok(J(w, "inventory.some(p => p.code === 'N1')"), 'the record is still there');
  // switching type shows that type's categories only
  w.eval("hospCatUiKind('dish')"); assert.doesNotMatch(d.getElementById('hcat-list').textContent, /Extras/);
  // rename via the screen
  w.eval("hospCatUi.edit = 'cat-dish-mains'; hospCatUiRenderList(); document.getElementById('hcat-edit-inp').value = 'Big plates'; hospCatUiRenameSave()");
  assert.equal(J(w, "hospCatFind('cat-dish-mains').name"), 'Big plates');
  b.close();
});

test('category field in the forms: only the record\'s own type, dish re-save keeps its category, utensils too', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("setAddItemType('item')");
  const opts = [...d.querySelectorAll('#inv-add-cat option')].map((o) => o.textContent);
  assert.deepEqual(opts, ['— Uncategorized —', 'Drinks', 'Extras'.length ? opts[2] : ''].slice(0, 2).concat(opts.slice(2)), 'first is Uncategorized');
  assert.ok(!opts.includes('Mains'), 'no dish / ingredient categories on an Item form');
  w.eval("setAddItemType('service')");
  const dopts = [...d.querySelectorAll('#inv-add-cat option')].map((o) => o.textContent);
  assert.ok(dopts.includes('Mains') && dopts.includes('Drinks'), 'dish categories');
  assert.ok(!dopts.includes('Extras'), 'a Service category is not a Dish category');
  // saving a dish from the form with a category
  w.eval("document.getElementById('inv-name').value = 'Soup'; document.getElementById('inv-price').value = '250'; document.getElementById('inv-add-cat').value = 'cat-dish-mains'; saveInventoryItem()");
  assert.equal(J(w, "inventory.find(p => p.name === 'Soup').categoryId"), 'cat-dish-mains');
  assert.equal(J(w, "inventory.find(p => p.name === 'Soup').category"), 'Mains');
  // re-saving the same dish with the category field left blank keeps the category
  w.eval("document.getElementById('inv-name').value = 'Soup'; document.getElementById('inv-price').value = '260'; document.getElementById('inv-add-cat').value = ''; saveInventoryItem()");
  assert.equal(J(w, "inventory.find(p => p.name === 'Soup').price"), 260);
  assert.equal(J(w, "inventory.find(p => p.name === 'Soup').category"), 'Mains', 'not lost by re-saving');
  // the edit modal
  w.eval("openInventoryEditModal('A1')");
  assert.equal(d.getElementById('inv-edit-category-select').value, 'cat-item-drinks');
  w.eval("document.getElementById('inv-edit-category-select').value = ''; hospCatEditModalChange('')");
  assert.equal(J(w, "hospCatIndex().entries.get('A1').catId"), null);
  // utensil form
  const cutlery = J(w, "hospCatCreate('utensil', 'Cutlery').cat.id");
  w.eval(`document.getElementById('new-utensil-name-input').value = 'Spoons'; document.getElementById('new-utensil-qty-input').value = '12'; document.getElementById('new-utensil-cat-input').value = '${cutlery}'; saveUtensil()`);
  assert.equal(J(w, "utensils.find(u => u.name === 'Spoons').category"), 'Cutlery');
  assert.match(d.querySelector('#utensils-table').textContent, /Cutlery/);
  b.close();
});

test('permissions: only people who may change inventory can manage categories, assign, or import', async () => {
  const b = await app(); const { w } = b;
  asStaff(w, ['service-tab']);                     // a waiter
  assert.equal(J(w, 'hospCatCanManage()'), false);
  assert.equal(J(w, "hospCatCreate('item', 'Nope').ok"), false);
  assert.equal(J(w, "hospCatRename('cat-item-drinks', 'X').ok"), false);
  assert.equal(J(w, "hospCatDelete('cat-item-drinks', null).ok"), false);
  assert.equal(J(w, "hospCatAssign(['N1'], 'cat-item-drinks', 'item').ok"), false);
  assert.equal(J(w, "hospCatOpenManager('item')"), false);
  assert.equal(J(w, "hospImportOpen('item')"), false);
  assert.equal(J(w, "hospCategories.length"), 0, 'nothing changed');
  assert.equal(J(w, "inventory.find(p => p.code === 'A1').category"), 'Drinks');
  assert.match(J(w, '__toasts.join("|")'), /needs Inventory access/);
  // a bartender who was given Bar & Kegs only (no Inventory) cannot either
  w.eval("staff.find(s => s.id === 'st1').roles = ['bar-tab']");
  assert.equal(J(w, 'hospCatCanManage()'), false);
  // the Sales Counter still SHOWS categories to everyone (viewing is not managing)
  w.eval("renderItemImageGrid('')"); assert.ok(chipLabels(b.d, 'sc-cat-bar').length > 2);
  // a storekeeper (Inventory) may
  w.eval("staff.find(s => s.id === 'st1').roles = ['inventory-list-tab']");
  assert.equal(J(w, "hospCatCreate('item', 'Allowed').ok"), true);
  assert.equal(J(w, "hospImportOpen('item')"), true);
  w.eval("hospImpClose()");
  // Add New Items access is enough to categorise what you add
  w.eval("staff.find(s => s.id === 'st1').roles = ['add-item-tab']"); assert.equal(J(w, 'hospCatCanManage()'), true);
  // a manager and the admin
  w.eval("staff.find(s => s.id === 'st1').roles = []; staff.find(s => s.id === 'st1').isManager = true"); assert.equal(J(w, 'hospCatCanManage()'), true);
  w.eval("currentServer = null"); assert.equal(J(w, 'hospCatCanManage()'), true);
  // another branch's inventory is read-only
  w.eval("viewedBranchId = 'br2'"); assert.equal(J(w, 'hospCatCanManage()'), false); w.eval("viewedBranchId = 'self'");
  b.close();
});

test('import into ONE type: the type is fixed; columns, categories and the preview come first; nothing is written until confirmed', async () => {
  const b = await app(); const { w, d } = b;
  const before = J(w, 'inventory.length');
  await importText(w, 'dish', CSV([['Dish name', 'Category', 'Price (KES)', 'Photo'], ['Chicken', 'Mains', '700', 'https://img.test/c.jpg'], ['Tea', 'Beverages', '100', ''], ['Coffee', 'Beverages', '150', ''], ['Salad', '', '300', '']]));
  assert.equal(J(w, 'hospImp.mapSource'), 'headers', 'known headers: matched by the built-in rules, offline');
  assert.match(d.getElementById('hosp-imp-modal').textContent, /built in — works offline/, 'the screen says which method was used');
  assert.deepEqual(J(w, 'hospImp.map'), { category: 1, price: 2, image: 3, name: 0 });
  const sum = J(w, 'hospImpSummary()');
  assert.deepEqual([sum.records, sum.categories, sum.newCats, sum.dups, sum.attention, sum.will], [4, 2, 1, 0, 0, 4], '4 records, 2 categories (Mains exists, Beverages is new)');
  assert.match(d.getElementById('hosp-imp-modal').textContent, /Importing into:\s*Dishes/);
  assert.equal(J(w, 'inventory.length'), before, 'the preview wrote nothing');
  assert.equal(J(w, 'hospCategories.length'), 0);
  assert.deepEqual(J(w, "hospImp.groups.map(g => g.name + ':' + g.status)").sort(), ['Beverages:new', 'Mains:existing']);
  const r = await w.eval('hospImpCommit()');
  assert.deepEqual([r.created, r.updated, r.skipped, r.attention, r.catsCreated], [4, 0, 0, 0, 1]);
  assert.ok(J(w, "inventory.filter(p => ['Chicken','Tea','Coffee','Salad'].includes(p.name)).every(p => p.type === 'service' && !p.hospService)"), 'every row became a dish: the type never changed');
  assert.equal(J(w, "inventory.find(p => p.name === 'Tea').category"), 'Beverages');
  assert.match(J(w, "inventory.find(p => p.name === 'Tea').categoryId"), /^cat-dish-/);
  assert.equal(J(w, "inventory.find(p => p.name === 'Chicken').categoryId"), 'cat-dish-mains', 'the existing category was used, not duplicated');
  assert.equal(J(w, "hospCatsOf('dish').filter(c => c.name === 'Mains').length"), 1);
  assert.equal(J(w, "inventory.find(p => p.name === 'Chicken').image"), 'https://img.test/c.jpg');
  assert.equal(J(w, "inventory.find(p => p.name === 'Salad').categoryId"), undefined, 'no category in the file: Uncategorized');
  assert.match(d.getElementById('hosp-imp-modal').textContent, /4\s*imported/);
  // they show at once on the Sales Counter and the Orders tab
  w.eval("renderItemImageGrid(''); renderSvcMenu()");
  assert.ok(chipLabels(d, 'sc-cat-bar').includes('Beverages')); assert.ok(chipLabels(d, 'svc-cat-bar').includes('Beverages'));
  b.close();
});

test('import into one type never retypes: a type column that disagrees is held for review, and per-type schemas differ', async () => {
  const b = await app(); const { w } = b;
  await importText(w, 'dish', CSV([['Name', 'Inventory Type', 'Price'], ['Steak', 'Dish', '900'], ['Fork set', 'Utensils', '50'], ['Cake', '', '400']]));
  const rows = J(w, 'hospImp.rowsE.map(r => [r.name, r.kind, r.status, r.action])');
  assert.deepEqual(rows, [['Steak', 'dish', 'new', 'import'], ['Fork set', 'dish', 'attention', 'skip'], ['Cake', 'dish', 'new', 'import']]);
  assert.match(J(w, "hospImp.rowsE[1].issues[0].msg"), /File says this is Utensils, but you are importing into Dishes/);
  let r = await w.eval('hospImpCommit()');
  assert.deepEqual([r.created, r.attention], [2, 1]);
  assert.equal(J(w, "utensils.some(u => u.name === 'Fork set') || inventory.some(p => p.name === 'Fork set')"), false, 'not silently made anything');
  // the user may explicitly import it as the chosen type
  await importText(w, 'dish', CSV([['Name', 'Inventory Type', 'Price'], ['Fork set', 'Utensils', '50']]));
  w.eval('hospImpForce(1, true)');
  r = await w.eval('hospImpCommit()'); assert.equal(r.created, 1);
  assert.equal(J(w, "inventory.find(p => p.name === 'Fork set').type"), 'service');
  // utensil import: name / category / quantity only (a price column is not a utensil field)
  await importText(w, 'utensil', CSV([['Name', 'Category', 'Quantity', 'Price'], ['Knives', 'Cutlery', '24', '99'], ['Plates', 'Crockery', '5', '1']]));
  assert.deepEqual(J(w, 'Object.keys(hospImp.map).sort()'), ['category', 'name', 'qty']);
  w.eval("hospImp.dupPolicy = 'skip'; hospImpEval()");
  r = await w.eval('hospImpCommit()');
  assert.deepEqual([r.created, r.skipped], [1, 1], 'Plates already exists (by name)');
  const k = J(w, "utensils.find(u => u.name === 'Knives')");
  assert.equal(k.qty, 24); assert.equal(k.category, 'Cutlery'); assert.equal(k.price, undefined);
  b.close();
});

test('import from ALL: types per row, one type for all, bulk assign, suggestions; a row without a type is never imported', async () => {
  const b = await app(); const { w } = b;
  const text = CSV([['Name', 'Type', 'Category', 'Price', 'Qty'], ['Latte', 'Dish', 'Coffee', '200', ''], ['Mug', 'Utensils', 'Crockery', '', '20'], ['Sugar', 'Ingredient', 'Pantry', '', '50'], ['Mystery', '', 'Coffee', '99', '4'], ['Odd', 'Weird', '', '10', '']]);
  await importText(w, 'all', text);
  assert.equal(J(w, 'hospImp.map.type'), 1, 'the Type column is found');
  assert.deepEqual(J(w, 'hospImp.rowsE.map(r => [r.name, r.kind, r.kindSrc])'), [['Latte', 'dish', 'column'], ['Mug', 'utensil', 'column'], ['Sugar', 'ingredient', 'column'], ['Mystery', '', ''], ['Odd', '', '']]);
  assert.deepEqual(J(w, 'hospImp.rowsE.map(r => r.status)'), ['new', 'new', 'new', 'attention', 'attention']);
  assert.equal(J(w, 'hospImpSummary().attention'), 2);
  // categories belong to the row's type: "Coffee" is under Dishes here, "Crockery" already exists under Utensils
  assert.deepEqual(J(w, "hospImp.groups.map(g => g.kind + '/' + g.name + ':' + g.status).sort()"), ['dish/Coffee:new', 'ingredient/Pantry:new', 'utensil/Crockery:existing']);
  // per-row
  w.eval("hospImpSetKind(4, 'item')");
  assert.equal(J(w, 'hospImp.rowsE[3].kind'), 'item'); assert.equal(J(w, "hospImp.rowsE[3].kindSrc"), 'user');
  assert.ok(J(w, "hospImp.groups.some(g => g.kind === 'item' && g.name === 'Coffee')"), 'the same name under another type is another category');
  // bulk: select rows, assign a type
  w.eval("hospImpToggleRow(5, true); hospImpSelKind('service')"); assert.equal(J(w, 'hospImp.rowsE[4].kind'), 'service');
  // the AI-style suggestion only fills what is still empty and says how
  await importText(w, 'all', CSV([['Name', 'Price', 'Qty', 'Cost'], ['Pie', '300', '', ''], ['Cola', '80', '12', '50'], ['Oil', '', '5', '110'], ['Tray', '', '8', '']]));
  assert.equal(J(w, 'hospImp.rowsE.filter(r => r.kind).length'), 0, 'nothing is assumed silently');
  w.eval('hospImpSuggest()');
  assert.deepEqual(J(w, 'hospImp.rowsE.map(r => r.kind)'), ['dish', 'item', 'ingredient', 'utensil']);
  assert.ok(J(w, "hospImp.rowsE.every(r => r.kindSrc === 'guess')")); assert.match(J(w, 'hospImp.mapNote'), /built-in rules/);
  // apply one type to all
  w.eval("hospImpAllKind('item')"); assert.ok(J(w, "hospImp.rowsE.every(r => r.kind === 'item' && r.kindSrc === 'user')"));
  const r = await w.eval('hospImpCommit()');
  assert.equal(r.created, 4);
  assert.ok(J(w, "['Pie', 'Cola', 'Oil', 'Tray'].every(n => inventory.find(p => p.name === n).type === 'item')"));
  // the first import: only the typed rows went in
  await importText(w, 'all', text); w.eval("hospImpSetKind(4, 'item'); hospImpSetKind(5, 'dish')");
  const r2 = await w.eval('hospImpCommit()');
  assert.equal(r2.created, 5); assert.equal(r2.attention, 0);
  assert.equal(J(w, "inventory.find(p => p.name === 'Latte').type"), 'service');
  assert.equal(J(w, "utensils.find(u => u.name === 'Mug').qty"), 20);
  assert.equal(J(w, "inventory.find(p => p.name === 'Sugar').type"), 'ingredient');
  assert.equal(J(w, "inventory.find(p => p.name === 'Sugar').price"), 0, 'an ingredient has no selling price');
  assert.equal(J(w, "inventory.find(p => p.name === 'Odd').type"), 'service');
  assert.equal(J(w, "hospCatFind(inventory.find(p => p.name === 'Latte').categoryId).kind"), 'dish');
  assert.equal(J(w, "hospCatFind(inventory.find(p => p.name === 'Mystery').categoryId).kind"), 'item', 'Mystery went to Items, so its "Coffee" is the Items category');
  assert.equal(J(w, "hospCatsOf('dish').filter(c => c.name === 'Coffee').length"), 1);
  assert.equal(J(w, "hospCatsOf('item').filter(c => c.name === 'Coffee').length"), 1);
  b.close();
});

test('categories in a file: existing reused (case / spacing ignored), new ones need the user\'s go-ahead, legacy names count as existing', async () => {
  const b = await app(); const { w } = b;
  w.eval("hospCatCreate('item', 'Beverages')");
  await importText(w, 'item', CSV([['Name', 'Category'], ['Juice', 'beverages'], ['Crisps', 'Snacks'], ['Biscuit', ' snacks '], ['Lemon', 'Drinks']]));
  assert.deepEqual(J(w, "hospImp.groups.map(g => g.name + ':' + g.status + ':' + g.n).sort()"), ['Drinks:existing:1', 'Snacks:new:2', 'beverages:existing:1'], 'Drinks exists only as a legacy name and still counts as existing');
  // decline the new category: those rows are imported Uncategorized
  w.eval("hospImpCatDecision(hospImp.groups.find(g => g.name === 'Snacks').key, 'skip')");
  assert.equal(J(w, "hospImp.groups.find(g => g.name === 'Snacks').decision"), 'skip');
  const r = await w.eval('hospImpCommit()');
  assert.equal(r.catsCreated, 0);
  assert.equal(J(w, "inventory.find(p => p.name === 'Crisps').categoryId"), undefined);
  assert.equal(J(w, "hospCatsOf('item').filter(c => hospCatNorm(c.name) === 'beverages').length"), 1, 'no duplicate Beverages');
  assert.equal(J(w, "inventory.find(p => p.name === 'Lemon').categoryId"), 'cat-item-drinks', 'the legacy category was adopted');
  assert.ok(J(w, "hospCategories.some(c => c.id === 'cat-item-drinks')"), 'and became a real record');
  // now with the go-ahead
  await importText(w, 'item', CSV([['Name', 'Category'], ['Nuts', 'Snacks']]));
  const r2 = await w.eval('hospImpCommit()'); assert.equal(r2.catsCreated, 1);
  assert.equal(J(w, "hospCatFind(inventory.find(p => p.name === 'Nuts').categoryId).name"), 'Snacks');
  b.close();
});

test('similar (not identical) category names are never merged on their own: the user decides, both ways work', async () => {
  const b = await app(); const { w } = b;
  w.eval("hospCatCreate('item', 'Beverages')");
  const text = CSV([['Name', 'Category'], ['Juice', 'Beverage'], ['Milk', 'Beverage'], ['Bread', 'Bakery']]);
  await importText(w, 'item', text);
  const g = J(w, "hospImp.groups.find(x => x.name === 'Beverage')");
  assert.equal(g.status, 'similar'); assert.equal(g.decision, null, 'undecided: not assumed'); assert.equal(g.similar.name, 'Beverages');
  assert.equal(J(w, 'hospImpSummary().blocked'), 1);
  assert.equal(await w.eval('hospImpCommit()'), null, 'the import will not go ahead until it is decided');
  assert.equal(J(w, "inventory.some(p => p.name === 'Juice')"), false);
  assert.equal(J(w, "hospCategories.length"), 1, 'nothing was created');
  // "different": a separate category is created next to the existing one
  w.eval("hospImpCatDecision(hospImp.groups.find(x => x.name === 'Beverage').key, 'new')");
  let r = await w.eval('hospImpCommit()'); assert.equal(r.catsCreated, 2);
  assert.deepEqual(J(w, "hospCatsOf('item').map(c => c.name).filter(n => /Bever/.test(n)).sort()"), ['Beverage', 'Beverages']);
  assert.notEqual(J(w, "inventory.find(p => p.name === 'Juice').categoryId"), J(w, "hospCatsOf('item').find(c => c.name === 'Beverages').id"));
  // "same thing": the existing category is used, no new one
  await importText(w, 'item', CSV([['Name', 'Category'], ['Tea', 'Beverage'], ['Coffee', 'Drink']]));
  const groups = J(w, "hospImp.groups.map(x => x.name + ':' + x.status)");
  assert.ok(groups.includes('Beverage:existing'), 'the exact name now exists (created above): plain match');
  assert.ok(groups.includes('Drink:similar'), '"Drink" is similar to "Drinks" (legacy)');
  w.eval("hospImpCatDecision(hospImp.groups.find(x => x.name === 'Drink').key, 'existing')");
  r = await w.eval('hospImpCommit()'); assert.equal(r.catsCreated, 0);
  assert.equal(J(w, "inventory.find(p => p.name === 'Coffee').categoryId"), 'cat-item-drinks');
  assert.equal(J(w, "hospCatsOf('item').some(c => c.name === 'Drink')"), false);
  // the similarity rule itself
  assert.equal(J(w, "hospCatSimilar('Main Course', 'Main Courses')"), true);
  assert.equal(J(w, "hospCatSimilar('Desserts', 'Dessert')"), true);
  assert.equal(J(w, "hospCatSimilar('Hair', 'Nails')"), false);
  assert.equal(J(w, "hospCatSimilar('Soft Drinks', 'soft-drinks')"), false, 'identical after normalising = the same category, not "similar"');
  b.close();
});

test('duplicates: skip / update existing / create new, decided per import or per row; stock and photos are never silently overwritten', async () => {
  const mk = () => INV().map((p) => (p.code === 'A1' ? { ...p, image: 'https://old.test/soda.jpg' } : p));
  const text = CSV([['Code', 'Name', 'Price', 'Qty', 'Category', 'Image'], ['A1', 'Soda', '120', '99', 'Fizzy', 'https://new.test/soda.jpg'], ['', 'Water', '55', '5', '', ''], ['Z9', 'Brand New', '10', '2', '', 'javascript:alert(1)']]);
  // SKIP (the default)
  let b = await app(mk()); let w = b.w;
  await importText(w, 'item', text);
  assert.deepEqual(J(w, 'hospImp.rowsE.map(r => [r.status, r.action, r.dup && r.dup.by])'), [['dup', 'skip', 'code'], ['dup', 'skip', 'name'], ['new', 'import', null]]);
  let r = await w.eval('hospImpCommit()');
  assert.deepEqual([r.created, r.updated, r.skipped], [1, 0, 2]);
  assert.equal(J(w, "inventory.find(p => p.code === 'A1').price"), 100, 'skipped = untouched');
  assert.equal(J(w, "inventory.find(p => p.code === 'Z9').image"), null, 'a javascript: link is not an image');
  b.close();
  // UPDATE: price yes; stock only when ticked; photo kept unless asked; type never changes
  b = await app(mk()); w = b.w;
  await importText(w, 'item', text); w.eval("hospImpSetDup('update')");
  r = await w.eval('hospImpCommit()');
  assert.deepEqual([r.created, r.updated], [1, 2]);
  assert.equal(J(w, "inventory.find(p => p.code === 'A1').price"), 120);
  assert.equal(J(w, "inventory.find(p => p.code === 'A1').qty"), 10, 'stock is not touched unless "also set stock quantities" is ticked');
  assert.equal(J(w, "inventory.find(p => p.code === 'A1').image"), 'https://old.test/soda.jpg', 'the existing photo is kept');
  assert.equal(r.imagesKept, 1); assert.match(b.d.getElementById('hosp-imp-modal').textContent, /1 existing image\(s\) kept/);
  assert.equal(J(w, "inventory.find(p => p.code === 'A1').category"), 'Fizzy'); assert.equal(J(w, "inventory.find(p => p.code === 'A2').price"), 55, 'matched by name');
  assert.equal(J(w, "inventory.find(p => p.code === 'A1').type"), 'item');
  b.close();
  // UPDATE + qty + replace image
  b = await app(mk()); w = b.w;
  await importText(w, 'item', text); w.eval("hospImpSetDup('update'); hospImp.updateQty = true; hospImp.replaceImg = true");
  await w.eval('hospImpCommit()');
  assert.equal(J(w, "inventory.find(p => p.code === 'A1').qty"), 99);
  assert.equal(J(w, "inventory.find(p => p.code === 'A1').image"), 'https://new.test/soda.jpg', 'replaced only because it was asked for');
  assert.equal(J(w, "inventory.find(p => p.code === 'A2').image"), 'https://x.test/water.jpg', 'no image in the file for Water: untouched');
  b.close();
  // CREATE: a new record beside the old one, with its own code and a name that does not collide
  b = await app(mk()); w = b.w;
  await importText(w, 'item', text); w.eval("hospImpSetDup('create')");
  r = await w.eval('hospImpCommit()');
  assert.equal(r.created, 3);
  assert.equal(J(w, "inventory.filter(p => p.name.startsWith('Soda')).length"), 2);
  assert.equal(J(w, "new Set(inventory.map(p => p.code)).size"), J(w, 'inventory.length'), 'all codes unique');
  assert.equal(J(w, "inventory.find(p => p.code === 'A1').price"), 100);
  b.close();
  // per-row choice overrides the policy; the same code in a different type is never touched
  b = await app(mk()); w = b.w;
  await importText(w, 'dish', CSV([['Code', 'Name', 'Price'], ['A1', 'Soda', '1'], ['D1', 'Burger', '650']]));
  assert.equal(J(w, "hospImp.rowsE[0].status"), 'attention', 'A1 is an Item: an import into Dishes will not retype it');
  assert.match(J(w, "hospImp.rowsE[0].issues[0].msg"), /Already exists as Items/);
  w.eval("hospImpSetAction(2, 'update')");
  r = await w.eval('hospImpCommit()'); assert.deepEqual([r.updated, r.attention], [1, 1]);
  assert.equal(J(w, "inventory.find(p => p.code === 'D1').price"), 650);
  assert.equal(J(w, "inventory.find(p => p.code === 'A1').price"), 100);
  b.close();
});

test('bad rows never abort the import: they are reported, the rest goes in', async () => {
  const b = await app(); const { w, d } = b;
  const rows = [['Name', 'Price', 'Qty', 'Category']];
  for (let i = 0; i < 450; i++) rows.push(['Bulk ' + i, String(10 + i), '5', i % 2 ? 'Odd' : 'Even']);
  rows.push(['', '10', '1', '']);                    // no name
  rows.push(['Bad price', 'abc', '1', '']);
  rows.push(['Negative', '-5', '1', '']);
  rows.push(['Bad qty', '10', 'many', '']);
  await importText(w, 'item', CSV(rows));
  const sum = J(w, 'hospImpSummary()');
  assert.equal(sum.attention, 4); assert.equal(sum.will, 450);
  const errs = J(w, "hospImp.rowsE.filter(r => r.status === 'error').map(r => r.issues.map(i => i.msg).join())");
  assert.match(errs.join('|'), /No name.*Price "abc" is not a number.*Negative number.*Quantity "many"/s);
  const r = await w.eval('hospImpCommit()');
  assert.deepEqual([r.created, r.attention], [450, 4]);
  assert.equal(r.problems.length, 4);
  assert.equal(J(w, "inventory.filter(p => /^Bulk /.test(p.name)).length"), 450, 'chunked commit finished every row');
  assert.match(d.getElementById('hosp-imp-modal').textContent, /Rows that need attention/);
  assert.equal(J(w, "hospCatsOf('item').filter(c => ['Odd', 'Even'].includes(c.name)).length"), 2);
  // one bad throwing row does not stop the others either
  const b2 = await app(); const w2 = b2.w;
  await importText(w2, 'item', CSV([['Name', 'Price'], ['Ok 1', '5'], ['Boom', '6'], ['Ok 2', '7']]));
  w2.eval("const orig = hospImpCreate; hospImpCreate = function (r, c, h) { if (r.name === 'Boom') throw new Error('kaboom'); return orig(r, c, h); }");
  const r2 = await w2.eval('hospImpCommit()');
  assert.deepEqual([r2.created, r2.attention], [2, 1]); assert.match(r2.problems[0].msg, /kaboom/);
  b.close(); b2.close();
});

test('columns: header synonyms, headerless files (value shapes), manual mapping, AI reader used when there, offline rules when not, paste, semicolon / tab', async () => {
  const b = await app(); const { w } = b;
  await importText(w, 'item', CSV([['Product', 'Group', 'Selling Price', 'Buying price', 'Stock', 'UoM', 'SKU', 'Image URL', 'Notes'], ['Cup', 'Kitchen', '10', '6', '50', 'pcs', 'C1', 'https://i.test/c.png', 'nice']]));
  assert.deepEqual(J(w, 'hospImp.map'), { category: 1, code: 6, cost: 3, price: 2, qty: 4, unit: 5, image: 7, desc: 8, name: 0 });
  // a headerless file: read from the shape of the values, and it says so
  await importText(w, 'item', 'Tea,100,20\nCoffee,150,30\nMilk,60,10');
  assert.equal(J(w, 'hospImp.header'), false); assert.equal(J(w, 'hospImp.mapSource'), 'shape');
  assert.equal(J(w, 'hospImp.map.name'), 0); assert.equal(J(w, 'hospImp.rowsE.length'), 3);
  // manual mapping always wins
  w.eval("hospImpSetCol('price', 2); hospImpSetCol('qty', 1)");
  assert.equal(J(w, 'hospImp.mapSource'), 'manual'); assert.equal(J(w, 'hospImp.rowsE[0].price'), 20); assert.equal(J(w, 'hospImp.rowsE[0].qty'), 100);
  // semicolon and tab (Excel "paste")
  await importText(w, 'item', 'Name;Price\nAle;300\nStout;350'); assert.equal(J(w, 'hospImp.rowsE.length'), 2);
  await importText(w, 'item', 'Name\tPrice\nAle\t300'); assert.equal(J(w, 'hospImp.rowsE[0].price'), 300);
  // the AI reader (server): used when it answers, honestly labelled; the offline rules when it does not
  await importText(w, 'item', 'Alpha,Beta\nTea,100');
  const ai = { mapping: { name: 0, price: 1 }, headerIsData: false };
  w.eval(`detectCsvColumnsAI = async () => (${JSON.stringify(ai)})`); w.eval("hospImp.mapSource = 'x'");
  assert.equal(await w.eval('hospImpAI()'), true);
  assert.equal(J(w, 'hospImp.mapSource'), 'ai'); assert.match(J(w, 'hospImp.mapNote'), /AI reader/);
  w.eval("detectCsvColumnsAI = async () => null"); w.eval("hospImp.mapSource = 'x'");
  assert.equal(await w.eval('hospImpAI()'), false); assert.equal(J(w, 'hospImp.mapSource'), 'x', 'unchanged'); assert.match(J(w, 'hospImp.mapNote'), /not available.*built-in matching/);
  // limits
  const many = ['Name,Price']; for (let i = 0; i < 5100; i++) many.push('N' + i + ',1');
  await importText(w, 'item', many.join('\n'));
  assert.equal(J(w, 'hospImp.rowsE.length'), 5000); assert.equal(J(w, 'hospImp.truncated'), 100);
  b.close();
});

test('an Excel (.xlsx) file goes through the existing SheetJS reader; a sheet can be chosen', async () => {
  const b = await app(); const { w } = b;
  const sheets = { Menu: [['Name', 'Category', 'Price'], ['Wrap', 'Lunch', '350']], Other: [['Name', 'Price'], ['X', '1']] };
  w.XLSX = { read: () => ({ SheetNames: ['Menu', 'Other'], Sheets: { Menu: 'Menu', Other: 'Other' } }), utils: { sheet_to_json: (ws) => sheets[ws] } };
  w.eval("hospImportOpen('dish')");
  const file = new w.File([new Uint8Array([0x50, 0x4b, 3, 4])], 'menu.xlsx');
  w.eval('window.__f = null'); w.__f = file;
  w.eval('hospImpFile(window.__f)');
  await until(() => w.eval('hospImp.step') === 'map', 3000);
  assert.equal(J(w, 'hospImp.rowsE[0].name'), 'Wrap'); assert.equal(J(w, 'hospImp.rowsE[0].catRaw'), 'Lunch');
  w.eval('hospImpSheet(1)'); await until(() => w.eval("hospImp.rowsE[0] && hospImp.rowsE[0].name") === 'X', 3000);
  // over the size limit: refused before reading
  w.eval("hospImp.step = 'pick'"); w.eval('hospImpRender()');
  w.eval("hospImpFile({ name: 'big.csv', size: 9 * 1024 * 1024 })");
  assert.match(w.document.getElementById('himp-err').textContent, /limit is 8 MB/);
  b.close();
});

test('image links in a file: https or existing photo links only; a stored photo is never overwritten by default', async () => {
  const b = await app(); const { w } = b;
  assert.equal(J(w, "hospImpImage('https://a.test/x.jpg').url"), 'https://a.test/x.jpg');
  assert.equal(J(w, "hospImpImage('/api/media?k=p&id=p-abc').url"), '/api/media?k=p&id=p-abc');
  for (const bad of ['http://a.test/x.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'ftp://x', '//x.test/a.jpg', 'https://a.test/x y.jpg']) assert.equal(J(w, `hospImpImage(${JSON.stringify(bad)}).bad`), true, bad);
  b.close();
});

test('perf: 5,000 items - the index is built once, a chip switch and a search stay fast, and switching does not rebuild anything', async () => {
  const inv = []; for (let i = 0; i < 5000; i++) inv.push({ code: 'P' + i, type: i % 3 ? 'item' : 'service', name: 'Product ' + i + (i % 7 === 0 ? ' special' : ''), category: 'Cat ' + (i % 40), price: 10 + (i % 90), qty: 5, unit: 'pcs', ...(i % 10 === 0 ? { image: 'https://i.test/' + i + '.jpg' } : {}) });
  const b = await app(inv, { opts: { wait: 800 } }); const { w, d } = b;
  const t0 = Date.now(); w.eval("renderItemImageGrid('')"); const first = Date.now() - t0;
  const builds = w.eval('window.__hospCatBuilds');
  const t1 = Date.now();
  for (let i = 0; i < 20; i++) w.eval(`hospCatPick('sales', 'cat-item-cat-${(i % 39) + 1}'.replace('cat-item-cat-', ${i % 2 ? "'cat-service-cat-'" : "'cat-item-cat-'"}))`);
  const perSwitch = (Date.now() - t1) / 20;
  const t2 = Date.now();
  for (const q of ['p', 'pr', 'prod', 'special', 'product 4', '4999']) w.eval(`hospCatPick('sales', '__all'); liveSearch('${q}')`);
  const perSearch = (Date.now() - t2) / 6;
  assert.equal(w.eval('window.__hospCatBuilds'), builds, 'chip switches and searches never rebuilt the index');
  assert.ok(first < 4000, 'first paint of 5,000 items: ' + first + ' ms');
  assert.ok(perSwitch < 400, 'a chip switch: ' + perSwitch + ' ms');
  assert.ok(perSearch < 600, 'a search over 5,000: ' + perSearch + ' ms');
  assert.ok(cellNamesLen(d) <= 61, 'the DOM holds one page, not 5,000 cells');
  // a change to the inventory rebuilds it once
  w.eval("inventory[0].name = 'Changed'; safeSetItem('pos_inventory', JSON.stringify(inventory)); queuePush(); renderItemImageGrid('')");
  assert.equal(w.eval('window.__hospCatBuilds'), builds + 1);
  b.close();
});
const cellNamesLen = (d) => d.querySelectorAll('#item-image-grid .item-grid-cell, #item-image-grid .hcat-more').length;

test('sync: categories travel between tills (real client + real server): create, rename, reorder, and a delete tombstone that a stale till cannot undo', async () => {
  const s = makeServer();
  const a = await openDevice('hotel/index.html', s, { pos_inventory: JSON.stringify(INV()) });
  a.w.eval("showToast = function () {}; window.confirm = () => true");
  const idle = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0));
  const mk = a.w.eval("hospCatCreate('dish', 'Chef specials').cat.id");
  a.w.eval("hospCatRename('cat-dish-mains', 'Big plates')");
  await idle(a); await a.w.eval('pushNow()');
  const onServer = () => (s.serverState().inventoryCategories || []);
  assert.deepEqual(onServer().map((c) => c.name).sort(), ['Big plates', 'Chef specials'], 'the server holds the categories');
  assert.equal((s.serverState().inventory || []).find((p) => p.code === 'D2').category, 'Big plates', 'and the records carry the new name');
  // a second till starts from what the first one has
  await a.w.eval('pullState()'); await sleep(300);
  const b = await openDevice('hotel/index.html', s, deviceStorage(a.w), 1500);
  b.w.eval("showToast = function () {}; window.confirm = () => true");
  await b.w.eval('pullState()');
  assert.deepEqual(J(b.w, "hospCatsOf('dish').map(c => c.name).sort()"), ['Big plates', 'Chef specials', 'Drinks']);
  assert.equal(J(b.w, "hospCatIndex().entries.get('D2').catId"), 'cat-dish-mains');
  // a fresh third till with nothing local pulls them
  const c = await openDevice('hotel/index.html', s, {}, 1500);
  await c.w.eval('pullState()'); await sleep(300);
  assert.deepEqual(J(c.w, "hospCatsOf('dish').map(c => c.name).sort()"), ['Big plates', 'Chef specials', 'Drinks']);
  // both tills edit different categories while apart: both survive
  b.w.eval(`hospCatSetActive('${mk}', false)`); a.w.eval("hospCatRename('cat-dish-mains', 'Mains again')");
  await idle(b); await b.w.eval('pushNow()'); await idle(a); await a.w.eval('pushNow()');
  await a.w.eval('pullState()'); await b.w.eval('pullState()');
  for (const dev of [a, b]) {
    assert.equal(J(dev.w, "hospCatFind('cat-dish-mains').name"), 'Mains again'); assert.equal(J(dev.w, `hospCatFind('${mk}').active`), false);
  }
  // a delete on one till is a tombstone; a stale till (it still has the category, with an older time) cannot bring it back
  const stale = deviceStorage(b.w);
  a.w.eval(`hospCatDelete('${mk}', null)`); await idle(a); await a.w.eval('pushNow()');
  assert.ok(onServer().find((x) => x.id === mk)._deleted, 'a tombstone on the server');
  s.state.down = true;   // the stale till starts offline (a phone that was in a drawer), so it cannot push before it has pulled
  const d2 = await openDevice('hotel/index.html', s, stale, 1500); d2.w.eval(`hospCategories.forEach((c) => { c.updatedAt = ${JSON.parse(stale.pos_inventory_categories).find((c) => c.id === mk).updatedAt}; }); snapshotExtraSyncedFields()`); s.state.down = false;   // (as a till that was syncing until it went to sleep: its records are unchanged since its last sync)
  assert.equal(J(d2.w, `!!hospCatFind('${mk}')`), true, 'the stale till still holds it');
  await d2.w.eval('pullState()'); await idle(d2); await d2.w.eval('pushNow()'); await d2.w.eval('pullState()');   // a till that comes back online pulls first, as every till does
  assert.ok(onServer().find((x) => x.id === mk)._deleted, 'the server keeps it deleted');
  assert.equal(J(d2.w, `hospCatFind('${mk}')`), null, 'and the stale till drops it once it syncs');
  await b.w.eval('pullState()'); assert.equal(J(b.w, `hospCatFind('${mk}')`), null, 'the other till too');
  for (const dev of [a, b, c, d2]) dev.close();
});

test('sync rules on the server: newest per category wins, a newer tombstone beats an older edit, an older tombstone loses to a newer edit', async () => {
  const { mergeRecordsById, MERGE_BY_ID_FIELDS } = await import('../functions/api/_merge.js');
  assert.ok(MERGE_BY_ID_FIELDS.includes('inventoryCategories'), 'registered like the other synced lists');
  const A = { id: 'c1', kind: 'item', name: 'A', updatedAt: 100 }, B = { id: 'c1', kind: 'item', name: 'B', updatedAt: 200 };
  assert.equal(mergeRecordsById([A], [B], false, 'inventoryCategories').find((x) => x.id === 'c1').name, 'B');
  assert.equal(mergeRecordsById([B], [A], false, 'inventoryCategories').find((x) => x.id === 'c1').name, 'B');
  const T = { id: 'c1', kind: 'item', name: 'B', _deleted: true, updatedAt: 300 };
  assert.equal(mergeRecordsById([B], [T], false, 'inventoryCategories')[0]._deleted, true);
  assert.equal(mergeRecordsById([T], [B], false, 'inventoryCategories')[0]._deleted, true, 'an older copy cannot resurrect it');
  assert.notEqual(mergeRecordsById([T], [{ ...B, updatedAt: 400 }], false, 'inventoryCategories')[0]._deleted, true, 'only a genuinely newer edit does');
  // both categories created on two tills are both kept
  assert.equal(mergeRecordsById([{ id: 'x', kind: 'item', name: 'X', updatedAt: 1 }], [{ id: 'y', kind: 'item', name: 'Y', updatedAt: 1 }], false, 'inventoryCategories').length, 2);
  // the client's own merge (kept unsent edits + what the server sent)
  const b = await app(); const { w } = b;
  assert.deepEqual(J(w, "hospMergeCategoryLists([{ id: 'c1', updatedAt: 5, name: 'mine' }, { id: 'c2', updatedAt: 1 }], [{ id: 'c1', updatedAt: 9, name: 'theirs' }]).map(c => c.name || c.id)"), ['theirs', 'c2']);
  b.close();
});

test('the compatibility mirror keeps every existing reader of p.category working (stations, reports, offers)', async () => {
  const b = await app(); const { w } = b;
  w.eval("hospConfig.categoryStations = { Mains: 'bar' }");
  assert.equal(J(w, "hospStationFor('D2', 'Pizza')"), 'bar', 'the station rule that reads p.category still works');
  w.eval("hospCatRename('cat-item-drinks', 'Refreshments')");
  assert.equal(J(w, "inventory.filter(p => p.category === 'Refreshments').length"), 3);
  w.eval("hospCatAssign(['N1'], 'cat-item-drinks', 'item')");
  assert.equal(J(w, "inventory.find(p => p.code === 'N1').category"), 'Refreshments');
  // reports / other code that groups by p.category see plain names
  assert.deepEqual(J(w, "[...new Set(inventory.filter(p => p.type === 'item').map(p => p.category))].sort()"), ['Refreshments']);
  b.close();
});
