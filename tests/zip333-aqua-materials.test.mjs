import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 333: Aqua raw-material varieties, eligible-material recipes, variety-chosen production, audited restock.
async function app() {
  const b = await boot('water/index.html', { wait: 900 });
  const ev = (code) => JSON.parse(b.w.eval(`JSON.stringify((function(){${code}})())`) ?? 'null');
  // fresh deterministic data on the production site
  b.w.eval(`
    rawMaterials.length = 0; products.length = 0; productionLog.length = 0; restockLog.length = 0; matMovements.length = 0;
    window.__site = (sites.find(function (s) { return s.type === 'production'; }) || sites[0]).id;
    activeSiteId = window.__site;
    function M(id, name, cat, qty, cost, units) { rawMaterials.push({ id: id, siteId: window.__site, name: name, category: cat, stockQty: qty, unitCost: cost, baseUnit: 'pcs', units: units || [], active: true, matModel: 1, sku: id.toUpperCase() }); }
    M('b1', 'Hex 500ml', 'bottle', 1000, 5); M('b2', 'Round 500ml', 'bottle', 1000, 6, [{ name: 'bag', factor: 100 }]);
    M('c1', 'Blue cap', 'cap', 5000, 1); M('c2', 'Red cap', 'cap', 5000, 1.5);
    products.push({ code: 'W500', name: 'Water 500ml', siteId: window.__site, category: 'bottled', price: 30, qty: 0, vatCategory: 'A',
      productionRecipe: [ { lineId: 'L1', category: 'bottle', qtyPerUnit: 1, eligible: ['b1', 'b2'], materialId: 'b1', wastePct: 0 }, { lineId: 'L2', category: 'cap', qtyPerUnit: 1, eligible: ['c1'], materialId: 'c1', wastePct: 0 } ] });
    products.push({ code: 'W1L', name: 'Water 1L', siteId: window.__site, category: 'bottled', price: 50, qty: 0, vatCategory: 'A',
      productionRecipe: [ { lineId: 'M1', category: 'bottle', qtyPerUnit: 1, eligible: ['b1'], materialId: 'b1', wastePct: 0 } ] });
  `);
  return { ...b, ev, stock: (id) => Number(b.w.eval(`rawMaterials.find(function(m){return m.id==='${id}'}).stockQty`)) };
}

test('A1/B1 only the picked variety is deducted; the other variety and other products are untouched', async () => {
  const { w, stock, close } = await app();
  try {
    const r = JSON.parse(w.eval(`JSON.stringify(AquaMat.produce({ txId: 't1', code: 'W500', qty: 10, picks: { L1: 'b2' } }))`));
    assert.equal(r.ok, true, r.error);
    assert.equal(stock('b2'), 990); assert.equal(stock('b1'), 1000, 'Hex bottle untouched'); assert.equal(stock('c1'), 4990); assert.equal(stock('c2'), 5000);
    assert.equal(Number(w.eval(`products.find(function(p){return p.code==='W500'}).qty`)), 10, 'finished goods credited');
  } finally { close(); }
});

test('B2 auto-selects only when exactly one valid variety; several = must choose, none = blocked', async () => {
  const { w, close } = await app();
  try {
    const plan = (picks) => JSON.parse(w.eval(`JSON.stringify(AquaMat.plan(products[0], 5, ${JSON.stringify(picks)}, {}))`));
    const p0 = plan({});
    const bottle = p0.lines.find(l => l.lineId === 'L1'), cap = p0.lines.find(l => l.lineId === 'L2');
    assert.match(bottle.error, /Choose the bottle/); assert.equal(cap.auto, true); assert.equal(p0.ok, false, 'no silent substitution for the bottle');
    assert.equal(plan({ L1: 'b1' }).ok, true);
    w.eval(`rawMaterials.find(function(m){return m.id==='c1'}).active = false`);
    const none = plan({ L1: 'b1' });
    assert.equal(none.ok, false); assert.match(none.errors.join(' '), /No active caps variety is eligible/);
  } finally { close(); }
});

test('B3 an ineligible, inactive or other-site variety is refused', async () => {
  const { w, close } = await app();
  try {
    const run = (picks) => JSON.parse(w.eval(`JSON.stringify(AquaMat.produce({ txId: 'x' + Math.random(), code: 'W1L', qty: 1, picks: ${JSON.stringify(picks)} }))`));
    assert.match(run({ M1: 'b2' }).error, /not eligible/);
    w.eval(`rawMaterials.find(function(m){return m.id==='b1'}).active = false`);
    assert.equal(run({ M1: 'b1' }).ok, false);
  } finally { close(); }
});

test('B4 insufficient stock blocks the whole run: nothing is deducted or logged', async () => {
  const { w, stock, close } = await app();
  try {
    w.eval(`rawMaterials.find(function(m){return m.id==='c1'}).stockQty = 3`);
    const r = JSON.parse(w.eval(`JSON.stringify(AquaMat.produce({ txId: 'short', code: 'W500', qty: 10, picks: { L1: 'b1' } }))`));
    assert.equal(r.ok, false); assert.match(r.error, /Not enough Blue cap/);
    assert.equal(stock('b1'), 1000); assert.equal(stock('c1'), 3); assert.equal(Number(w.eval('productionLog.length')), 0); assert.equal(Number(w.eval('matMovements.length')), 0);
  } finally { close(); }
});

test('B5 a duplicate transaction id (double click / replay) changes nothing', async () => {
  const { w, stock, close } = await app();
  try {
    w.eval(`AquaMat.produce({ txId: 'dup', code: 'W500', qty: 10, picks: { L1: 'b1' } })`);
    const again = JSON.parse(w.eval(`JSON.stringify(AquaMat.produce({ txId: 'dup', code: 'W500', qty: 10, picks: { L1: 'b1' } }))`));
    assert.equal(again.duplicate, true); assert.equal(stock('b1'), 990); assert.equal(Number(w.eval('productionLog.length')), 1);
  } finally { close(); }
});

test('B6 failure half-way rolls everything back', async () => {
  const { w, stock, close } = await app();
  try {
    w.eval(`window.__orig = creditProducedProduct; creditProducedProduct = function () { throw new Error('boom'); }`);
    const r = JSON.parse(w.eval(`JSON.stringify(AquaMat.produce({ txId: 'rb', code: 'W500', qty: 10, picks: { L1: 'b1' } }))`));
    assert.equal(r.ok, false); assert.match(r.error, /nothing was changed/);
    assert.equal(stock('b1'), 1000); assert.equal(stock('c1'), 5000); assert.equal(Number(w.eval('productionLog.length')), 0); assert.equal(Number(w.eval('matMovements.length')), 0);
  } finally { close(); }
});

test('B7 cost is snapshotted: a later price change does not rewrite the past', async () => {
  const { w, close } = await app();
  try {
    w.eval(`AquaMat.produce({ txId: 'c1x', code: 'W500', qty: 10, picks: { L1: 'b1' } })`);
    const before = JSON.parse(w.eval('JSON.stringify(productionLog[0])'));
    assert.equal(before.materialCost, 60); // 10*5 + 10*1
    w.eval(`rawMaterials.find(function(m){return m.id==='b1'}).unitCost = 50`);
    const after = JSON.parse(w.eval('JSON.stringify(productionLog[0])'));
    assert.equal(after.materialCost, 60); assert.equal(after.componentsUsed.find(c => c.materialId === 'b1').unitCost, 5);
    assert.equal(JSON.parse(w.eval('JSON.stringify(matMovements.filter(function(m){return m.type==="production"}))')).find(m => m.materialId === 'b1').unitCost, 5);
  } finally { close(); }
});

test('A2 a variety can be tied to many products, a product to many varieties; association alone deducts nothing', async () => {
  const { w, stock, close } = await app();
  try {
    w.eval(`AquaMat.associate('c2', 'W500', true); AquaMat.associate('c2', 'W1L', true);`);
    const prods = JSON.parse(w.eval(`JSON.stringify(AquaMat.productsFor('c2').map(function(p){return p.code}))`));
    assert.deepEqual(prods.sort(), ['W1L', 'W500']);
    const caps = JSON.parse(w.eval(`JSON.stringify(products.find(function(p){return p.code==='W500'}).productionRecipe.find(function(r){return r.category==='cap'}).eligible)`));
    assert.deepEqual(caps, ['c1', 'c2']); assert.equal(stock('c2'), 5000);
    w.eval(`AquaMat.associate('c2', 'W500', false)`);
    assert.deepEqual(JSON.parse(w.eval(`JSON.stringify(AquaMat.productsFor('c2').map(function(p){return p.code}))`)), ['W1L']);
  } finally { close(); }
});

test('C1 restock adds through a receipt: base-unit conversion, weighted-average cost, credit is not paid, idempotent', async () => {
  const { w, stock, close } = await app();
  try {
    // 3 bags of 100 at KES 900 total on credit
    const r = JSON.parse(w.eval(`JSON.stringify(AquaMat.receive({ txId: 'r1', materialId: 'b2', qty: 3, unit: 'bag', totalCost: 900, payMethod: 'credit', supplierId: null }))`));
    assert.equal(r.ok, true, r.error); assert.equal(r.base, 300); assert.equal(stock('b2'), 1300);
    const m = JSON.parse(w.eval(`JSON.stringify(rawMaterials.find(function(x){return x.id==='b2'}))`));
    assert.equal(m.unitCost, Number(((1000 * 6 + 900) / 1300).toFixed(4)));
    const mv = JSON.parse(w.eval(`JSON.stringify(matMovements.find(function(x){return x.txId==='r1'}))`));
    assert.equal(mv.paidAmount, 0); assert.equal(mv.outstanding, 900); assert.equal(mv.unitCost, 3);
    const dup = JSON.parse(w.eval(`JSON.stringify(AquaMat.receive({ txId: 'r1', materialId: 'b2', qty: 3, unit: 'bag', totalCost: 900 }))`));
    assert.equal(dup.duplicate, true); assert.equal(stock('b2'), 1300);
    // other variety untouched
    assert.equal(stock('b1'), 1000);
  } finally { close(); }
});

test('C2 restock refuses a unit with no conversion, a zero/negative quantity and an overpayment', async () => {
  const { w, stock, close } = await app();
  try {
    const go = (o) => JSON.parse(w.eval(`JSON.stringify(AquaMat.receive(Object.assign({ txId: 'e' + Math.random(), materialId: 'b1' }, ${JSON.stringify(o)})))`));
    assert.match(go({ qty: 2, unit: 'bag' }).error, /no conversion/);
    assert.equal(go({ qty: 0 }).ok, false); assert.equal(go({ qty: -4 }).ok, false);
    assert.match(go({ qty: 10, totalCost: 100, paid: 500 }).error, /Amount paid/);
    assert.equal(stock('b1'), 1000);
  } finally { close(); }
});

test('C3 a decimal-safe conversion: 0.1 + 0.2 style quantities do not drift', async () => {
  const { w, stock, close } = await app();
  try {
    w.eval(`rawMaterials.push({ id: 'k1', siteId: window.__site, name: 'Roll', category: 'label', stockQty: 0, unitCost: 0, baseUnit: 'm', units: [{ name: 'roll', factor: 0.1 }], active: true, matModel: 1 })`);
    w.eval(`AquaMat.receive({ txId: 'd1', materialId: 'k1', qty: 1, unit: 'roll' }); AquaMat.receive({ txId: 'd2', materialId: 'k1', qty: 2, unit: 'roll' })`);
    assert.equal(stock('k1'), 0.3);
  } finally { close(); }
});

test('A3 opening stock is an auditable movement; creating a duplicate name+category is refused', async () => {
  const { w, close } = await app();
  try {
    const r = JSON.parse(w.eval(`JSON.stringify(AquaMat.createMaterial({ txId: 'o1', name: 'Crystal 500ml', category: 'bottle', unitCost: 4, openingQty: 200, openingTotalCost: 800 }))`));
    assert.equal(r.ok, true, r.error);
    const mv = JSON.parse(w.eval(`JSON.stringify(matMovements.filter(function(x){return x.txId==='o1'}))`));
    assert.equal(mv.length, 1); assert.equal(mv[0].type, 'opening'); assert.equal(mv[0].qty, 200);
    assert.match(JSON.parse(w.eval(`JSON.stringify(AquaMat.createMaterial({ name: 'crystal 500ml', category: 'bottle' }))`)).error, /already a Bottles/);
  } finally { close(); }
});

test('A4 migration is idempotent: category guessed, unknown flagged, opening balance recorded once, recipes get eligible lists', async () => {
  const { w, close } = await app();
  try {
    w.eval(`rawMaterials.length = 0; matMovements.length = 0;
      rawMaterials.push({ id: 'o1', siteId: window.__site, name: 'Blue Cap', stockQty: 50, unitCost: 2 });
      rawMaterials.push({ id: 'o2', siteId: window.__site, name: 'Mystery', stockQty: 0, unitCost: 0 });
      products[0].productionRecipe = [{ materialId: 'o1', qtyPerUnit: 1 }];`);
    w.eval('AquaMat.migrate(); AquaMat.migrate()');
    const m = JSON.parse(w.eval('JSON.stringify(rawMaterials)'));
    assert.equal(m[0].category, 'cap'); assert.equal(m[1].category, 'other'); assert.equal(m[1].needsReview, true);
    assert.equal(JSON.parse(w.eval('JSON.stringify(matMovements)')).length, 1, 'one opening movement for the 50 caps, not two');
    const r = JSON.parse(w.eval('JSON.stringify(products[0].productionRecipe[0])'));
    assert.deepEqual(r.eligible, ['o1']); assert.ok(r.lineId); assert.equal(r.category, 'cap');
  } finally { close(); }
});

test('B8 order reference: producing more than ordered needs confirmation, reversal restores stock exactly once', async () => {
  const { w, stock, close } = await app();
  try {
    const run = (tx, q, extra) => JSON.parse(w.eval(`JSON.stringify(AquaMat.produce(Object.assign({ txId: '${tx}', code: 'W1L', qty: ${q}, picks: { M1: 'b1' }, orderRef: 'ORD-7', orderQty: 10 }, ${JSON.stringify(extra || {})})))`));
    assert.equal(run('p1', 6).ok, true);
    const over = run('p2', 6); assert.equal(over.ok, false); assert.equal(over.needConfirm, true); assert.equal(stock('b1'), 994);
    assert.equal(run('p3', 4).ok, true);
    const id = w.eval(`productionLog[0].id`);
    const rv = JSON.parse(w.eval(`JSON.stringify(AquaMat.reverseProduction('${id}', 'wrong batch'))`));
    assert.equal(rv.ok, true, rv.error); assert.equal(stock('b1'), 1000 - 4);
    assert.equal(JSON.parse(w.eval(`JSON.stringify(AquaMat.reverseProduction('${id}', 'again'))`)).duplicate, true); assert.equal(stock('b1'), 996);
    assert.equal(Number(w.eval(`products.find(function(p){return p.code==='W1L'}).qty`)), 4);
    assert.match(JSON.parse(w.eval(`JSON.stringify(AquaMat.reverseProduction('${id}', ''))`)).error, /reason is required/);
  } finally { close(); }
});

test('B9 no recipe blocks production unless explicitly allowed', async () => {
  const { w, close } = await app();
  try {
    w.eval(`products.push({ code: 'RAW', name: 'No recipe', siteId: window.__site, category: 'bottled', qty: 0, price: 1 })`);
    const r = JSON.parse(w.eval(`JSON.stringify(AquaMat.produce({ txId: 'nr', code: 'RAW', qty: 2 }))`));
    assert.equal(r.ok, false); assert.match(r.error, /no recipe/);
    assert.equal(JSON.parse(w.eval(`JSON.stringify(AquaMat.produce({ txId: 'nr2', code: 'RAW', qty: 2, allowNoRecipe: true }))`)).ok, true);
  } finally { close(); }
});

test('G1 the new arrays sync: matMovements is in the payload and merges by id on the server', async () => {
  const { w, close } = await app();
  try {
    assert.match(w.eval(`JSON.stringify(Object.keys(collectSyncPayload()))`), /matMovements/);
  } finally { close(); }
  const { MERGE_BY_ID_FIELDS } = await import('../functions/api/_merge.js');
  for (const f of ['matMovements', 'productionLog', 'restockLog']) assert.ok(MERGE_BY_ID_FIELDS.includes(f), f);
});
