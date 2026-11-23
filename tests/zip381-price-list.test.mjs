// zip 381: Shop Price List - import of an E254-style price list (services straight in, MOQ, KSh targets), editing, MOQ at the counter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot } from './helpers.mjs';

// rows exactly as they appear in the E254 Services sheet (title row, header row, carried categories, ranges, prices in the wrong column, a total row)
const E254 = [
  ['E254 GROUP — SERVICES & TARGETS'],
  ['Service Category', 'Service / Product', 'Price list', 'Quantities', 'Target Amount (KSh)', 'Source Page'],
  ['Cyber Café & Digital Services', 'B/W Printing A4', '15', '', 'KSh 30,000', '1'],
  ['Cyber Café & Digital Services', 'Colour Printing A4', '40', '', 'KSh 30,000', '1'],
  ['Cyber Café & Digital Services', 'Company Registration', '17,500', '', 'KSh 4,000', '1'],
  ['Branding & Printing', 'Photo Studio Rental', '', '', 'KSh 15,000', '2'],
  ['Branding & Printing', 'Plan Printing A2', '125', '', 'KSh 2,000', '2'],
  ['', 'Plan Printing A1', '225', '', 'KSh 3,500'],
  ['Branding & Printing', 'Invitation card A5', '80'],
  ['packaging', 'brown bags plain A5', '40'],
  ['Packaging', 'Brown Bags Plain A3', '65', '', 'KSh 2,000', '2'],
  ['Packaging', 'Brown Bags Branded – one-colour branding A3', 'KSh 73', '150 pcs ', 'KSh 60,000'],
  ['Packaging', 'Brown Bags Branded – one-colour branding A4', 'KSh 62', '150 pcs ', 'KSh 54', '2'],
  ['Packaging', 'Luxury Bags Matte or glossy – one-colour branding A5+', 'KSh 110', '150 pcs (was 200 pcs)', 'KSh 78', '2'],
  ['Packaging', 'Luxury Bags Matte or glossy – one-colour branding A5+', 'KSh 90', '150 pcs (was 200 pcs)', 'KSh 63'],
  ['Packaging', 'Non-Woven Bags Branded – one-colour branding A6', '', '150 pcs', 'KSh 15,000'],
  ['Packaging', 'Wrapping paper', '', '(30-45)', 'KSh 4,000'],
  ['Town office', 'Cutting', '', 'KSh 50', 'KSh 5,000'],
  ['Town office', 'lamination', '', 'KSh 7', 'KSh 10,000'],
  [], [],
  ['', '', '', '', 'KSh 886,645'],
  ['HOW CAN I INCREASE TO KSH 1000,000'],
];

const boots = async () => boot('index.html', { storage: { pos_biz_name: 'E254' }, wait: 1500 });

test('the block is registered for the shop only and listed under Stock', () => {
  assert.match(fs.readFileSync('tools/lib.mjs', 'utf8'), /'price-list': \{ startMarker: '<!-- PRICE LIST', only: \['index.html'\] \}/);
  assert.match(fs.readFileSync('src/shared/blocks/sidebar-nav.html', 'utf8'), /'inventory-list-tab', 'price-list-tab'/);
  assert.equal(fs.readFileSync('hotel/index.html', 'utf8').includes('window.PriceList = {'), false);
});

test('E254 price list: services straight in, MOQ, KSh targets, ranges, prices in the wrong column', async () => {
  const d = await boots();
  try {
    const w = d.w;
    w.__rows = E254;
    const plan = w.eval("PriceList.planImport([{ name: 'E254 Services', rows: window.__rows }], [])");
    const by = (n) => plan.rows.find((r) => r.name === n);
    assert.equal(plan.rows.length, 17, 'every named row, nothing from the title / total / note rows');
    assert.ok(plan.rows.every((r) => r.type === 'service'), 'all services (the sheet is named Services, no stock given)');
    assert.equal(by('B/W Printing A4').price, 15);
    assert.equal(by('B/W Printing A4').target, 30000);
    assert.equal(by('B/W Printing A4').category, 'Cyber Café & Digital Services');
    assert.equal(by('Company Registration').price, 17500);
    assert.equal(by('Plan Printing A1').category, 'Branding & Printing', 'blank category carries the row above');
    assert.equal(by('brown bags plain A5').category, 'packaging');
    assert.equal(by('Brown Bags Plain A3').category, 'packaging', 'Packaging / packaging are one category');
    assert.equal(by('Brown Bags Branded – one-colour branding A3').moq, 150);
    assert.equal(by('Brown Bags Branded – one-colour branding A3').price, 73);
    assert.equal(by('Brown Bags Branded – one-colour branding A3').target, 60000);
    assert.equal(by('Brown Bags Branded – one-colour branding A4').target, null, 'KSh 54 is not a month target');
    assert.ok(by('Brown Bags Branded – one-colour branding A4').warns.some((x) => /minimum order \(KES 62\)/.test(x)), 'KES 54 is less than one order of 150 at KES 62');
    assert.equal(by('Photo Studio Rental').category, 'Branding & Printing');
    assert.ok(by('Luxury Bags Matte or glossy – one-colour branding A5+ (2)'), 'the repeated name is kept, renamed');
    assert.equal(by('Luxury Bags Matte or glossy – one-colour branding A5+').moq, 150, '"150 pcs (was 200 pcs)" = 150');
    const ws = by('Wrapping paper');
    assert.equal(ws.price, 30); assert.equal(ws.priceAtCounter, true); assert.match(ws.priceNote, /30–45/);
    assert.equal(by('Cutting').price, 50, 'KSh 50 in the quantities column is the price');
    assert.equal(by('lamination').price, 7);
    const st = by('Photo Studio Rental'); assert.equal(st.price, 0); assert.equal(st.priceAtCounter, true);
    assert.equal(by('Non-Woven Bags Branded – one-colour branding A6').moq, 150);
    assert.ok(plan.skipped.some((s) => /886,645/.test(s.why)), 'the total row is reported, not imported');

    // apply
    const n0 = w.eval('inventory.length');
    const res = w.eval("(function(){ var p = PriceList.planImport([{ name: 'E254 Services', rows: window.__rows }]); return PriceList.applyImport(p, {}); })()");
    assert.equal(res.created, 17); assert.equal(res.services, 17);
    assert.equal(w.eval('inventory.length'), n0 + 17);
    const bag = w.eval("JSON.stringify(inventory.find(p => p.name === 'Brown Bags Branded – one-colour branding A3'))");
    const b = JSON.parse(bag);
    assert.equal(b.type, 'service'); assert.equal(b.qty, null); assert.equal(b.moq, 150); assert.equal(b.monthlyTargetAmount, 60000); assert.equal(b.category, 'packaging');
    const codes = w.eval('JSON.stringify(inventory.map(p => p.code))'); const cs = JSON.parse(codes);
    assert.equal(new Set(cs).size, cs.length, 'every code unique');

    // re-import = updates, never duplicates
    const again = w.eval("(function(){ var p = PriceList.planImport([{ name: 'E254 Services', rows: window.__rows }]); return { upd: p.rows.filter(r => r.existing).length, res: PriceList.applyImport(p, {}) }; })()");
    assert.equal(again.res.created, 0); assert.equal(again.res.updated, 17);
    assert.equal(w.eval('inventory.length'), n0 + 17);

    // MOQ at the counter. KES 73 buys 150 pieces. Whole packs (the default): 1 pack = KES 73, 2 packs = 300 pcs = KES 146.
    const code = b.code;
    assert.equal(b.moqMode, 'pack');
    w.eval(`currentCart = {}; addToCart(${JSON.stringify(code)});`);
    let l = JSON.parse(w.eval('JSON.stringify(Object.values(currentCart)[0])'));
    assert.equal(l.qty, 1); assert.equal(l.price, 73); assert.equal(l.unitPieces, 150); assert.match(l.name, /pack of 150/);
    assert.equal(w.eval('cartTotal()'), 73, '150 pcs = KES 73');
    w.eval(`addToCart(${JSON.stringify(code)})`);
    assert.equal(w.eval('cartTotal()'), 146, '300 pcs = KES 146');
    w.eval('var k = Object.keys(currentCart)[0]; setCartQty(k, 1.5);');
    assert.equal(w.eval('Object.values(currentCart)[0].qty'), 2, 'half a pack refused');
    // any number from 150 up: 200 pcs = 200 x 73 / 150 = 97.33 -> KES 97 (whole shillings only)
    w.eval(`inventory.find(p => p.code === ${JSON.stringify(code)}).moqMode = 'from'; currentCart = {}; addToCart(${JSON.stringify(code)});`);
    l = JSON.parse(w.eval('JSON.stringify(Object.values(currentCart)[0])'));
    assert.equal(l.fromPieces, 150); assert.equal(l.price, 73); assert.equal(l.qty, 1);
    w.eval('var k = Object.keys(currentCart)[0]; setCartQty(k, 200);');
    l = JSON.parse(w.eval('JSON.stringify(Object.values(currentCart)[0])'));
    assert.equal(l.price, 97); assert.equal(l.unitPieces, 200); assert.match(l.name, /200 pcs$/);
    assert.equal(w.eval('cartTotal()'), 97);
    w.eval('var k = Object.keys(currentCart)[0]; setCartQty(k, 100);');
    assert.equal(w.eval('Object.values(currentCart)[0].fromPieces'), 200, 'under 150 refused');
    w.eval('var k = Object.keys(currentCart)[0]; changeCartQty(k, 1);');
    assert.equal(w.eval('Object.values(currentCart)[0].price'), 98, '201 pcs = 97.82 -> 98');
    assert.equal(w.eval('Object.values(currentCart).every(l => Number.isInteger(l.price * l.qty))'), true, 'no cents');
    // a STOCKED item in packs: 400 pcs in stock, packs of 150 -> 2 packs fit, a 3rd does not; the sale takes 300 pieces
    w.eval(`inventory.push({ type: 'item', code: 'BAGX', name: 'Kraft Bag', price: 73, qty: 400, unit: 'pcs', vatCategory: 'A', moq: 150, moqMode: 'pack' });
            currentCart = {}; addToCart('BAGX'); addToCart('BAGX'); addToCart('BAGX');`);
    assert.equal(w.eval('Object.values(currentCart)[0].qty'), 2);
    w.eval('deductEntriesForBillRoot(Object.values(currentCart))');
    assert.equal(w.eval("inventory.find(p => p.code === 'BAGX').qty"), 100);
  } finally { d.close && d.close(); }
});

test('Price List screen: KSh target, MOQ and price edits save; achieved counts the month sales', async () => {
  const d = await boots();
  try {
    const w = d.w;
    w.eval(`inventory.push({ type: 'service', code: 'SV1', name: 'B/W Printing A4', price: 15, qty: null, recipe: [], unit: 'pcs', vatCategory: 'A' });
            inventory.push({ type: 'item', code: 'IT1', name: 'Matt Paper A4', price: 5, wholesalePrice: 2, qty: 500, unit: 'pcs', vatCategory: 'A' });
            salesLog.push({ id: 's1', timestamp: Date.now(), items: [{ code: 'SV1', qty: 100, price: 15 }] });`);
    w.eval("switchTab ? null : null; var t = document.getElementById('price-list-tab'); document.querySelectorAll('.tab-content').forEach(x => x.classList.remove('active')); t.classList.add('active'); PriceList.view('services');");
    const set = (sel, v) => { const e = w.document.querySelector(sel); e.value = v; e.dispatchEvent(new w.Event('change', { bubbles: true })); };
    set('#price-list-tab input[data-pl="target"][data-code="SV1"]', '3000');
    assert.equal(w.eval("inventory.find(p => p.code === 'SV1').monthlyTargetAmount"), 3000);
    assert.match(w.document.getElementById('price-list-tab').textContent, /50% · KES 1,500 to go/, '1,500 sold of 3,000');
    set('#price-list-tab input[data-pl="moq"][data-code="SV1"]', '10');
    assert.equal(w.eval("inventory.find(p => p.code === 'SV1').moq"), 10);
    w.eval("PriceList.view('items')");
    set('#price-list-tab input[data-pl="qty"][data-code="IT1"]', '480');
    assert.equal(w.eval("inventory.find(p => p.code === 'IT1').qty"), 480);
    assert.ok(w.eval("stockMovementLog.some(m => m.code === 'IT1' && /Price List count/.test(m.reason || ''))"), 'quantity change logged');
    set('#price-list-tab input[data-pl="price"][data-code="IT1"]', '6');
    assert.equal(w.eval("inventory.find(p => p.code === 'IT1').price"), 6);
  } finally { d.close && d.close(); }
});

test('a service that uses ONE of several materials: the cashier picks, that stock goes down', async () => {
  const d = await boots();
  try {
    const w = d.w;
    w.eval(`inventory.push({ type: 'item', code: 'MATT', name: 'Matt Paper', price: 0, qty: 100, unit: 'pcs', vatCategory: 'A' });
            inventory.push({ type: 'item', code: 'GLOS', name: 'Glossy Paper', price: 0, qty: 50, unit: 'pcs', vatCategory: 'A' });
            inventory.push({ type: 'service', code: 'PRT', name: 'Photo Print', price: 40, qty: null, recipe: [], unit: 'pcs', vatCategory: 'A',
              materialChoices: [{ code: 'MATT', qtyPerUnit: 1 }, { code: 'GLOS', qtyPerUnit: 1, price: 60 }] });
            currentCart = {}; addToCart('PRT');`);
    assert.equal(w.eval('Object.keys(currentCart).length'), 0, 'asks for the material first');
    assert.ok(w.document.getElementById('pl-ov').classList.contains('on'));
    w.eval("PriceList.pick('PRT', 'GLOS')");
    const l = JSON.parse(w.eval('JSON.stringify(Object.values(currentCart)[0])'));
    assert.equal(l.price, 60); assert.equal(l.material, 'GLOS'); assert.match(l.name, /Glossy Paper/);
    w.eval("deductEntriesForBillRoot(Object.values(currentCart))");
    assert.equal(w.eval("inventory.find(p => p.code === 'GLOS').qty"), 49);
    assert.equal(w.eval("inventory.find(p => p.code === 'MATT').qty"), 100);
  } finally { d.close && d.close(); }
});
