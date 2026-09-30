import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, ROOT } from './helpers.mjs';

// zip 161 - Hotel POS leftovers: collator sorts, "hide items of switched-off categories", cosmetic fixes, optional AI type suggestions,
// cheap chip switching, and a class-keyed banner fix for old WebViews.
const SRC = fs.readFileSync(path.join(ROOT, 'hotel/index.html'), 'utf8');
const INV = () => [
  { code: 'A1', type: 'item', name: 'Soda', category: 'Drinks', price: 100, wholesalePrice: 60, qty: 10, unit: 'pcs', vatCategory: 'A' },
  { code: 'A2', type: 'item', name: 'Water', category: 'Drinks', price: 50, wholesalePrice: 30, qty: 10, unit: 'pcs' },
  { code: 'A3', type: 'item', name: 'Crisps', category: 'Snacks', price: 60, qty: 10, unit: 'pcs' },
  { code: 'D1', type: 'service', name: 'Burger', category: 'Mains', price: 500, unit: 'pcs' },
  { code: 'D2', type: 'service', name: 'Old Special', category: 'Retired', price: 700, unit: 'pcs' },
  { code: 'N1', type: 'item', name: 'Plain Item', price: 10, qty: 3, unit: 'pcs' },
];
const J = (w, js) => { const r = w.eval(`JSON.stringify(${js})`); return r === undefined ? undefined : JSON.parse(r); };
async function app(inv = INV(), extra = {}) {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(inv), ...(extra.storage || {}) }, wait: 1200, ...(extra.opts || {}) });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.prompt = () => null");
  return b;
}
const cellNames = (d) => [...d.querySelectorAll('#item-image-grid .igc-name')].map((e) => e.textContent);
const svcNames = (d) => [...d.querySelectorAll('#svc-menu .svc-menu-btn strong')].map((e) => e.textContent);
const chipLabels = (d, id) => [...d.querySelectorAll(`#${id} .hcat-chip`)].map((b) => b.textContent.replace(/\d+$/, '').trim());

// ---------------------------------------------------------------- (a) collator sorts
test('(a) the suppliers list and the Bar buttons sort with the cached collator (accents / case ignored, 2 before 10)', async () => {
  assert.ok(!/\[\.\.\.suppliers\]\.sort\(\(a, b\) => a\.name\.localeCompare\(b\.name\)\)\.map\(s => `/.test(SRC), 'the suppliers table no longer uses a plain localeCompare');
  assert.ok(!/srcs\.sort\(\(a, b\) => String\(a\.category \|\| ''\)\.localeCompare/.test(SRC), 'the Bar buttons no longer use a plain localeCompare');
  const b = await app(); const { w, d } = b;
  w.eval("suppliers.length = 0; ['Zed Foods', 'élan Ltd', 'Depot 10', 'depot 2', 'Alpha'].forEach((n, i) => suppliers.push({ id: 's' + i, name: n, phone: '' }))");
  const html = w.eval('supplierOptionsHtml("")');
  const names = [...html.matchAll(/>([^<>]+)<\/option>/g)].map((m) => m[1]).filter((n) => !/No supplier/.test(n));
  assert.deepEqual(names, ['Alpha', 'depot 2', 'Depot 10', 'élan Ltd', 'Zed Foods']);
  w.eval('renderSuppliersTable()');
  const rowNames = [...d.querySelectorAll('#suppliers-table-body tr input[type=text]:first-child, #suppliers-tbody tr input[type=text]:first-child')].map((i) => i.value);
  if (rowNames.length) assert.deepEqual(rowNames.slice(0, 5), ['Alpha', 'depot 2', 'Depot 10', 'élan Ltd', 'Zed Foods']);
  // the Bar buttons: category then name, with numbers by value
  w.eval("inventory.push({ code: 'W2', type: 'item', name: 'Whisky 10', category: 'Spirits', bottleMl: 750, qty: 1, price: 0, unit: 'pcs' }, { code: 'W10', type: 'item', name: 'Whisky 2', category: 'spirits', bottleMl: 750, qty: 1, price: 0, unit: 'pcs' }, { code: 'B1', type: 'item', name: 'Beer', category: 'Beers', bottleMl: 500, qty: 1, price: 0, unit: 'pcs' }, { code: 'S1', type: 'item', name: 'Shot', pourOf: { code: 'W2', ml: 30 }, price: 100, unit: 'pcs' }, { code: 'S2', type: 'item', name: 'Shot', pourOf: { code: 'W10', ml: 30 }, price: 100, unit: 'pcs' }, { code: 'S3', type: 'item', name: 'Shot', pourOf: { code: 'B1', ml: 30 }, price: 100, unit: 'pcs' }); hospCatTouch()");
  assert.deepEqual(J(w, 'hospBarSources().map(p => p.name)'), ['Beer', 'Whisky 2', 'Whisky 10']);
  assert.deepEqual(b.errors, []); b.close();
});

// ---------------------------------------------------------------- (b) hide items of switched-off categories
test('(b) off by default: switching a category off hides its chip only; ON hides its items from both grids but a search still finds them', async () => {
  const b = await app(); const { w, d } = b;
  assert.equal(J(w, 'hospCatHideOff()'), false, 'default OFF');
  w.eval("hospCatSetActive('cat-dish-retired', false); hospCatSetActive('cat-item-drinks', false); renderItemImageGrid(''); renderSvcMenu()");
  assert.ok(cellNames(d).includes('Soda') && cellNames(d).includes('Water'), 'OFF: current behaviour, the records stay under All');
  assert.ok(svcNames(d).includes('Old Special'), 'OFF: also on Orders');
  assert.ok(!chipLabels(d, 'sc-cat-bar').some((l) => /Drinks/.test(l)), 'the chip of an inactive category is not offered (as before)');
  // turn the setting on
  const r = J(w, "hospCatSetHideOff(true)");
  assert.equal(r.ok, true);
  assert.equal(J(w, 'hospConfig.hideInactiveCatItems'), true);
  assert.equal(JSON.parse(w.localStorage.getItem('pos_hosp_config')).hideInactiveCatItems, true, 'saved');
  assert.deepEqual(cellNames(d).sort(), ['Burger', 'Crisps', 'Plain Item'].sort(), 'Sales Counter: only records of active categories (and uncategorized)');
  assert.ok(svcNames(d).includes("Burger") && svcNames(d).includes("Plain Item") && svcNames(d).includes("Crisps"), "Orders is filtered too");
  assert.ok(!svcNames(d).includes('Old Special'), 'Orders: the dish of a switched-off category is hidden');
  // search still finds them
  w.eval("renderItemImageGrid('soda')");
  assert.deepEqual(cellNames(d), ['Soda'], 'findable by search');
  w.eval("renderItemImageGrid('A2')");
  assert.deepEqual(cellNames(d), ['Water'], 'findable by code');
  w.document.getElementById('svc-item-search').value = 'old spec'; w.eval('renderSvcMenu()');
  assert.deepEqual(svcNames(d), ['Old Special'], 'Orders search finds it too');
  w.document.getElementById('svc-item-search').value = ''; w.eval('renderSvcMenu()');
  // the "All" chip count follows what the grid shows
  w.eval("renderItemImageGrid('')");
  assert.equal(J(w, "hospScreenChips('sales')[0].n"), 3);
  // reactivating brings them back with the setting still ON
  w.eval("hospCatSetActive('cat-item-drinks', true); renderItemImageGrid('')");
  assert.ok(cellNames(d).includes('Soda'), 'active again: shown');
  // switching the setting OFF restores everything
  w.eval("hospCatSetHideOff(false)");
  assert.ok(svcNames(d).includes('Old Special'));
  assert.equal(J(w, 'hospConfig.hideInactiveCatItems'), false);
  assert.deepEqual(b.errors, []); b.close();
});

test('(b) the Categories window has the switch, only people who manage categories can change it, and it is audited', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("hospCatOpenManager('item')");
  const box = d.getElementById('hcat-hide-off');
  assert.ok(box, 'the checkbox is in the Categories manager');
  assert.match(box.parentElement.textContent, /Hide items of switched-off categories from the Sales Counter and Orders/);
  assert.equal(box.checked, false);
  box.checked = true; box.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(J(w, 'hospConfig.hideInactiveCatItems'), true);
  assert.ok(J(w, "adminActivityLog.some(a => /hide items of switched-off/i.test(JSON.stringify(a)) || /switched-off categories/.test(JSON.stringify(a)))"), 'written to the activity log');
  // a cashier without inventory access is refused
  w.eval("hospCatSetHideOff(false); staff.push({ id: 'st1', name: 'Sam', roles: ['sales-tab'] }); currentServer = { id: 'st1', name: 'Sam' }");
  w.eval("hospCatSetHideOff(true)");
  assert.equal(J(w, 'hospConfig.hideInactiveCatItems'), false, 'refused');
  assert.ok((w.__toasts || w.eval('window.__toasts')).some((t) => /Inventory access/.test(t)));
  assert.deepEqual(b.errors, []); b.close();
});

// ---------------------------------------------------------------- (c) cosmetic defects
test('(c) a dead photo link in the inventory table swaps to the placeholder; grid + Orders already do (zip 159)', async () => {
  const inv = INV(); inv[0].image = 'https://dead.invalid/soda.jpg';
  const b = await app(inv); const { w, d } = b;
  w.eval('renderInventoryTable()');
  const img = [...d.querySelectorAll('img.inv-thumb')].find((i) => i.alt === 'Soda');
  assert.ok(img, 'the row is there');
  assert.match(img.getAttribute('onerror') || '', /hospThumbFail\(this\)/, 'onerror is wired');
  assert.ok(/^https:\/\/dead\.invalid/.test(img.src));
  w.eval("hospThumbFail(document.querySelector('img.inv-thumb[alt=\"Soda\"]'))");
  assert.match(d.querySelector('img.inv-thumb[alt="Soda"]').src, /^data:image\/svg\+xml/, 'the broken link became the placeholder');
  // Sales Counter grid / Orders menu
  w.eval("renderItemImageGrid(''); renderSvcMenu()");
  assert.match(SRC, /onerror="hospImgFail\(this\)"/);
  const gi = d.querySelector('#item-image-grid img');
  if (gi) { w.eval("hospImgFail(document.querySelector('#item-image-grid img'))"); assert.ok(!d.querySelector('#item-image-grid img[src*="dead.invalid"]'), 'grid: replaced by the type icon'); }
  assert.deepEqual(b.errors, []); b.close();
});

test('(c) CSS: 44 px touch targets in Stations/printers/modifiers, and the Orders new-order row wraps with full-width selects', () => {
  assert.match(SRC, /#hosp-station-settings label \{ display: inline-flex; align-items: center; gap: 6px; min-height: 44px; \}/);
  assert.match(SRC, /#hosp-station-settings input\[type=checkbox\][^{]*\{ width: 24px !important; height: 24px;/);
  assert.match(SRC, /#svc-new-fields select, #svc-new-fields input \{ min-width: 100%; max-width: 100%; width: 100%; box-sizing: border-box; \}/);
  assert.match(SRC, /@media \(max-width: 640px\) \{ #svc-new-fields > div \{ flex: 1 1 100% !important; \} \}/);
});

// ---------------------------------------------------------------- (f) banner overlap without :has()
test('(f) the banner-overlap fix no longer depends on :has(): a body class is toggled and the CSS is keyed on it (receipt-size window + category / import windows)', async () => {
  assert.match(SRC, /body\.rsz-open #notif-prompt-banner \{ display: none !important; \}/);
  assert.match(SRC, /body\.hcat-open #notif-prompt-banner \{ display: none !important; \}/);
  const b = await app(); const { w, d } = b;
  w.eval('receiptSizeOpen()');
  assert.ok(d.body.classList.contains('rsz-open'), 'receipt size window open -> class on');
  w.eval('receiptSizeClose()');
  assert.ok(!d.body.classList.contains('rsz-open'), 'closed -> class off');
  w.eval("hospCatOpenManager('item')");
  assert.ok(d.body.classList.contains('hcat-open'));
  w.eval("hospImportOpen('item')");
  assert.ok(d.body.classList.contains('hcat-open'));
  w.eval('hospImpClose()');
  assert.ok(d.body.classList.contains('hcat-open'), 'the manager is still open behind it');
  w.eval('hospCatCloseManager()');
  assert.ok(!d.body.classList.contains('hcat-open'), 'all closed -> class off');
  // every module that carries the receipt-size window got the class rules (shared block)
  for (const f of ['index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'water/index.html', 'hotel/index.html']) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (t.includes('id="receipt-size-modal"')) assert.match(t, /body\.rsz-open #notif-prompt-banner/, f);
  }
  assert.deepEqual(b.errors, []); b.close();
});

// ---------------------------------------------------------------- (d) AI type suggestion
const csvOf = (rows) => rows.map((r) => r.map((c) => /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',')).join('\n');
function aiFetch(state) {
  return async (url, opts) => {
    if (String(url).includes('/api/ai-capture-list') && opts && opts.method === 'PUT') {
      const body = JSON.parse(opts.body);
      if (body.inventoryTypes) {
        state.calls.push(body.inventoryTypes);
        if (state.down) throw new Error('offline');
        const types = body.inventoryTypes.rows.map((r) => ({ n: r.n, type: state.answer ? state.answer(r) : 'dish' }));
        if (state.junk) types.push({ n: 99999, type: 'dish' }, { n: body.inventoryTypes.rows[0].n, type: 'spaceship' });
        return { ok: true, status: 200, json: async () => ({ types }) };
      }
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return Promise.reject(new Error('offline'));
  };
}
async function importAll(b, text) {
  const { w } = b;
  w.eval("hospImportOpen('all')");
  await w.eval(`hospImpLoadRows(hospImpParseText(${JSON.stringify(text)}), 'f.csv')`);
  await new Promise((r) => setTimeout(r, 30));
}
test('(d) Ask AI to suggest types: only open rows (name, category, price) are sent; answers fill the Type box as "AI suggested", never override a user or file type', async () => {
  const st = { calls: [], answer: (r) => (/soup|burger/i.test(r.name) ? 'dish' : 'item') };
  const b = await app([], { opts: { fetch: aiFetch(st) } }); const { w, d } = b;
  await importAll(b, csvOf([['Name', 'Category', 'Price', 'Qty', 'Code', 'Phone'], ['Tomato Soup', 'Starters', '300', '', 'C1', '0712345678'], ['Cola', 'Drinks', '80', '10', 'C2', '0700000000'], ['Chef Special', '', '900', '', 'C3', ''], ['Mystery', 'Misc', '', '', 'C4', '']]));
  // the user picks a type for row 4; row 3 is set by the rules first
  w.eval("hospImpSetKind(4, 'utensil')");
  w.eval('hospImpSuggest()');
  const before = J(w, "hospImp.rowsE.map(r => [r.n, r.kind, r.kindSrc])");
  assert.equal(before.find((x) => x[0] === 4)[2], 'user');
  assert.ok(d.getElementById('himp-ai-types'), 'the optional button is there');
  const out = await w.eval('hospImpAiSuggest()');
  assert.equal(st.calls.length, 1);
  const sent = st.calls[0];
  assert.ok(sent.rows.every((r) => Object.keys(r).sort().join() === 'category,n,name,price'), 'only name + category + price (+ the row number)');
  assert.ok(!sent.rows.some((r) => r.n === 4), 'a row whose type the user chose is not sent');
  assert.ok(sent.types.some((t) => t.id === 'dish') && sent.types.every((t) => t.id && t.label), 'the shop\'s types are given');
  assert.ok(!JSON.stringify(sent).includes('0712345678') && !JSON.stringify(sent).includes('C1'), 'no phone numbers or codes leave the device');
  const after = J(w, "hospImp.rowsE.map(r => [r.n, r.kind, r.kindSrc])");
  assert.equal(after.find((x) => x[0] === 4)[1], 'utensil', 'the user\'s choice stays');
  assert.equal(after.find((x) => x[0] === 1)[1], 'dish'); assert.equal(after.find((x) => x[0] === 1)[2], 'ai');
  assert.equal(after.find((x) => x[0] === 2)[1], 'item');
  assert.ok(out.applied >= 2);
  assert.match(d.getElementById('hosp-imp-modal').textContent, /AI suggested/, 'flagged for review');
  assert.equal(J(w, 'inventory.length'), 0, 'nothing was imported: it only suggests');
  // asking again does not touch rows the user chose afterwards
  w.eval("hospImpSetKind(1, 'service')");
  st.answer = () => 'ingredient';
  await w.eval('hospImpAiSuggest()');
  assert.equal(J(w, "hospImp.rowsE.find(r => r.n === 1).kind"), 'service');
  assert.equal(J(w, "hospImp.rowsE.find(r => r.n === 1).kindSrc"), 'user');
  assert.deepEqual(b.errors, []); b.close();
});

test('(d) a file Type column is respected (those rows are not sent), junk answers are ignored, and 450 open rows go in calls of at most 200', async () => {
  const st = { calls: [], junk: true };
  const b = await app([], { opts: { fetch: aiFetch(st) } }); const { w } = b;
  const rows = [['Name', 'Type', 'Price']]; rows.push(['Typed Row', 'Dish', '10']);
  for (let i = 0; i < 450; i++) rows.push(['Thing ' + i, '', '20']);
  await importAll(b, csvOf(rows));
  const out = await w.eval('hospImpAiSuggest()');
  assert.deepEqual(st.calls.map((c) => c.rows.length), [200, 200, 50]);
  assert.ok(st.calls.every((c) => !c.rows.some((r) => r.name === 'Typed Row')), 'the row with a Type column is not sent');
  assert.equal(J(w, "hospImp.rowsE.find(r => r.name === 'Typed Row').kindSrc"), 'column');
  assert.ok(J(w, "hospImp.rowsE.filter(r => r.kindSrc === 'ai').every(r => r.kind === 'dish')"));
  assert.equal(J(w, "hospImp.rowsE.some(r => r.kind === 'spaceship')"), false, 'an unknown type id is dropped');
  assert.ok(out.applied > 0);
  assert.deepEqual(b.errors, []); b.close();
});

test('(d) when the AI cannot be reached: a friendly message, nothing changed, the built-in suggestion is still there', async () => {
  const st = { calls: [], down: true };
  const b = await app([], { opts: { fetch: aiFetch(st) } }); const { w, d } = b;
  await importAll(b, csvOf([['Name', 'Category', 'Price', 'Qty'], ['Tomato Soup', 'Starters', '300', ''], ['Cola', 'Drinks', '80', '10']]));
  w.eval('hospImpSuggest()');
  const rules = J(w, "hospImp.rowsE.map(r => [r.kind, r.kindSrc])");
  assert.deepEqual(rules, [['dish', 'guess'], ['item', 'guess']]);
  const out = await w.eval('hospImpAiSuggest()');
  assert.equal(out.failed, true);
  assert.deepEqual(J(w, "hospImp.rowsE.map(r => [r.kind, r.kindSrc])"), rules, 'the rules-based suggestion stays as it was');
  assert.match(d.getElementById('hosp-imp-modal').textContent, /could not be reached/);
  assert.equal(J(w, 'hospImp.aiBusy'), false, 'the button is usable again');
  assert.deepEqual(b.errors, []); b.close();
});

test('(d) the server has the new request shape (a mode of the SAME endpoint), capped at 200 rows, keeping only ids it was given', () => {
  const src = fs.readFileSync(path.join(ROOT, 'functions/api/ai-capture-list.js'), 'utf8');
  assert.match(src, /body\.inventoryTypes/);
  assert.match(src, /MAX_TYPE_ROWS = 200/);
  assert.match(src, /okIds\.has\(x\.type\)/);
  assert.match(SRC, /\/api\/ai-capture-list/);
});

// ---------------------------------------------------------------- (e) chip switching is cheap
test('(e) chip switches reuse the Bar index and an unchanged panel / grid is not rebuilt; a stock change still repaints', async () => {
  const inv = []; for (let i = 0; i < 3000; i++) inv.push({ code: 'P' + i, type: 'item', name: 'Product ' + i, category: 'Cat ' + (i % 12), price: 10 + (i % 90), qty: 5, unit: 'pcs' });
  for (let i = 0; i < 40; i++) { inv.push({ code: 'W' + i, type: 'item', name: 'Whisky ' + i, category: 'Spirits', bottleMl: 750, qty: 4, price: 0, unit: 'pcs' }); inv.push({ code: 'WS' + i, type: 'item', name: 'Shot', pourOf: { code: 'W' + i, ml: 30 }, price: 100, unit: 'pcs' }); }
  const b = await app(inv); const { w, d } = b;
  w.eval("renderItemImageGrid('')");
  const panel = d.getElementById('bar-serve-panel');
  assert.ok(panel.querySelectorAll('.bar-serve-row').length === 40, 'the bar panel shows its 40 bottles');
  const details = panel.querySelector('details');
  const idx0 = w.eval('hospBarIndex()');
  const chips = [...d.querySelectorAll('#sc-cat-bar .hcat-chip')].map((c) => c.dataset.id);
  assert.ok(chips.length > 5);
  for (const id of chips.slice(0, 6)) w.eval(`hospCatPick('sales', '${id}')`);
  assert.equal(w.eval('hospBarIndex()'), idx0, 'the Bar index was not rebuilt by chip taps');
  assert.equal(panel.querySelector('details'), details, 'the unchanged Bar panel DOM was kept (not re-created)');
  // the same chip painted twice: the grid DOM node stays
  w.eval("hospCatPick('sales', '" + chips[1] + "')");
  const cell = d.querySelector('#item-image-grid .item-grid-cell');
  w.eval("renderItemImageGrid('')");
  assert.equal(d.querySelector('#item-image-grid .item-grid-cell'), cell, 'an identical grid is not re-created');
  // stock changed: the panel text updates
  w.eval("inventory.find(p => p.code === 'W0').qty = 0; renderItemImageGrid('')");
  assert.match(panel.textContent, /OUT OF STOCK/);
  // a serving added -> new structure -> new index
  w.eval("inventory.push({ code: 'WS-new', type: 'item', name: 'Double', pourOf: { code: 'W1', ml: 60 }, price: 180, unit: 'pcs' }); queuePush && (window.__hospCatDirty = true); renderItemImageGrid('')");
  assert.match(panel.textContent, /DOUBLE|Double/i);
  assert.deepEqual(b.errors, []); b.close();
});
