import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, ROOT } from './helpers.mjs';

// zip 348: simple material form + CSV, 9-step production with a water tank, client default bottles, price list + invoices.
const SAMPLE = fs.readFileSync(path.join(ROOT, 'templates', 'aqua_materials_sample.csv'), 'utf8');
const CLIENTS = fs.readFileSync(path.join(ROOT, 'templates', 'aqua_client_bottles_sample.csv'), 'utf8');

async function app() {
  const b = await boot('water/index.html', { wait: 900 });
  const j = (code) => JSON.parse(b.w.eval(`JSON.stringify((function(){${code}})())`) ?? 'null');
  b.w.eval(`
    rawMaterials.length = 0; products.length = 0; productionLog.length = 0; restockLog.length = 0; matMovements.length = 0; customers.length = 0; aquaInvoices.length = 0;
    window.__site = (sites.find(function (s) { return s.type === 'production'; }) || sites[0]).id;
    activeSiteId = window.__site;
    products.push({ code: 'S500', name: '500ml Sealed Bottle', siteId: window.__site, category: 'bottled', sizeML: 500, price: 30, qty: 0, vatCategory: 'A', productionRecipe: [] });
    products.push({ code: 'S1000', name: '1000ml Sealed Bottle', siteId: window.__site, category: 'bottled', sizeML: 1000, price: 50, qty: 0, vatCategory: 'A', productionRecipe: [] });
    products.push({ code: 'B500', name: '500ml Bale (Case) - 24 pcs', siteId: window.__site, category: 'bale', sizeML: 500, bottlesPerBale: 24, linkedBottleCode: 'S500', price: 380, qty: 0, vatCategory: 'A', productionRecipe: [], priceTiers: [{ minQty: 10, price: 360 }] });
    products.push({ code: 'C500', name: '500ml Executive Bale', siteId: window.__site, category: 'bale', baleKind: 'custom', sizeML: 500, bottlesPerBale: 24, price: 550, qty: 0, vatCategory: 'A', productionRecipe: [] });
  `);
  const imp = () => j(`var p = AquaFlow.csvPlan(${JSON.stringify(SAMPLE)}); var r = AquaFlow.csvApply(p); return { plan: { n: p.rows.length, bad: p.bad, errors: p.errors, warn: p.warnings.length }, res: r };`);
  const mat = (name) => j(`var m = rawMaterials.find(function (x) { return x.name === ${JSON.stringify(name)}; }); return m || null;`);
  const stock = (name) => Number(b.w.eval(`rawMaterials.find(function (m) { return m.name === ${JSON.stringify(name)}; }).stockQty`));
  const topUp = (name, qty) => b.w.eval(`(function(){ var m = rawMaterials.find(function (x) { return x.name === ${JSON.stringify(name)}; }); m.stockQty = ${qty}; })()`);
  const stockAll = () => { ['Hexa plain 500ml', 'Aqua clear 500ml', 'Grip plain 500ml', 'All Caps', 'Security seals', 'Stickers 500ml 1000ml 1500ml', 'Wrappers 500ml'].forEach((n) => topUp(n, 1000)); };
  return { ...b, j, imp, mat, stock, topUp, stockAll, errors: b.errors };
}
const tank = (w, extra = '') => w.eval(`(function(){ var r = AquaFlow.createTank({ name: 'Prod tank', capacity: 1000, start: 100 ${extra} }); return r.tank.id; })()`);

test('1 the sample CSV imports: 26 materials, prices, bag conversion, links by size and type', async () => {
  const a = await app();
  try {
    const r = a.imp();
    assert.deepEqual(r.plan.errors, []); assert.equal(r.plan.bad, 0, 'every sample row is understood'); assert.equal(r.res.created, 26); assert.deepEqual(r.res.failed, []);
    const hexa = a.mat('Hexa plain 500ml'); assert.equal(hexa.category, 'bottle'); assert.equal(hexa.unitCost, 9.1);
    assert.deepEqual(hexa.forItems.sort(), ['500:bale', '500:custom', '500:sealed']);
    const wrap = a.mat('Wrappers 500ml'); assert.equal(wrap.category, 'packaging'); assert.equal(wrap.bagCost, 2320); assert.equal(wrap.perBag, 100); assert.ok(Math.abs(wrap.unitCost - 23.2) < 1e-9, 'a bag of 100 at 2320 = 23.20 each');
    assert.deepEqual(wrap.forItems.sort(), ['500:bale', '500:custom']);
    assert.equal(a.mat('Grip plain 1500ml').unitCost, 0, 'blank price stays 0 and is reported, not guessed');
    assert.ok(r.plan.warn >= 10, 'rows with no price are listed');
    // re-import = update, never a duplicate and never touches stock
    a.topUp('Hexa plain 500ml', 777);
    const again = a.imp(); assert.equal(again.res.created, 0); assert.equal(again.res.updated, 26); assert.equal(a.stock('Hexa plain 500ml'), 777);
    assert.equal(a.j(`return rawMaterials.length`), 26);
    assert.deepEqual(a.errors, [], 'no page errors');
  } finally { a.close(); }
});

test('2 links become recipe lines; a product created later picks its materials up; wrapping only on bales', async () => {
  const a = await app();
  try {
    a.imp();
    const lines = a.j(`AquaFlow.syncRecipes(); return products.map(function (p) { return { code: p.code, cats: p.productionRecipe.map(function (r) { return r.category + ':' + r.eligible.length + ':' + (r.perBottle ? 'pb' : 'u') + ':' + (r.optional ? 'opt' : 'req'); }).sort() }; });`);
    const s500 = lines.find((l) => l.code === 'S500').cats, b500 = lines.find((l) => l.code === 'B500').cats;
    assert.ok(s500.includes('bottle:7:u:req'), s500.join()); // Hexa plain/clear/blue, Aqua clear/blue, Banana, Grip = 7 bottles for 500ml
    assert.ok(!s500.some((x) => x.startsWith('packaging')), 'no wrapping on a sealed bottle');
    assert.ok(b500.some((x) => x.startsWith('packaging:1:u:req')), 'wrapper is one per bale: ' + b500.join());
    assert.ok(b500.includes('bottle:7:pb:req'), 'bale uses one bottle per bottle in it: ' + b500.join());
    const again = a.j(`return AquaFlow.syncRecipes();`); assert.equal(again, 0, 'idempotent: nothing changes the second time');
    // a new 1000ml sealed product created AFTER the import is linked automatically
    const n = a.j(`products.push({ code: 'S1500', name: '1500ml Sealed Bottle', siteId: window.__site, category: 'bottled', sizeML: 1500, price: 60, qty: 0, productionRecipe: [] }); AquaFlow.syncRecipes(); return products.find(function (p) { return p.code === 'S1500'; }).productionRecipe.map(function (r) { return r.category; }).sort();`);
    assert.deepEqual(n, ['bottle', 'cap', 'label', 'seal']);
    // unmatched: 18.9L etc. have materials but no product yet
    assert.ok(a.j(`return AquaFlow.unmatchedKeys();`).includes('18900:sealed'));
    assert.deepEqual(a.errors, []);
  } finally { a.close(); }
});

test('3 sealed-bottle run: only the picked bottle, cap, seal, label are used; water leaves the tank; finished goods credited; one record', async () => {
  const a = await app();
  try {
    a.imp(); a.stockAll(); const id = tank(a.w);
    const r = a.j(`return AquaFlow.produce({ txId: 'T1', code: 'S500', qty: 10, picks: { bottle: rawMaterials.find(function (m) { return m.name === 'Aqua clear 500ml'; }).id }, tankId: ${JSON.stringify(id)}, extras: [] });`);
    assert.equal(r.ok, true, r.error);
    assert.equal(a.stock('Aqua clear 500ml'), 990); assert.equal(a.stock('Hexa plain 500ml'), 1000, 'other bottles untouched');
    assert.equal(a.stock('All Caps'), 990); assert.equal(a.stock('Security seals'), 990); assert.equal(a.stock('Stickers 500ml 1000ml 1500ml'), 990);
    assert.equal(a.stock('Wrappers 500ml'), 1000, 'no wrapper for a sealed bottle');
    assert.equal(a.j(`return tanks.find(function (t) { return t.id === ${JSON.stringify(id)}; }).currentVolumeLiters`), 95, '10 x 0.5 L = 5 L');
    assert.equal(a.j(`return products.find(function (p) { return p.code === 'S500'; }).qty`), 10);
    const rec = a.j(`return productionLog[0];`); assert.equal(rec.water.litres, 5); assert.equal(rec.workflow, 'flow');
    // pressing record twice (same transaction) does nothing more
    const dup = a.j(`return AquaFlow.produce({ txId: 'T1', code: 'S500', qty: 10, picks: {}, tankId: ${JSON.stringify(id)}, extras: [] });`);
    assert.equal(dup.duplicate, true); assert.equal(a.stock('All Caps'), 990); assert.equal(a.j(`return productionLog.length`), 1);
    assert.deepEqual(a.errors, []);
  } finally { a.close(); }
});

test('4 bale run: bottles x bottles-per-bale, one wrapper per bale, water for every bottle; credits the linked bottle', async () => {
  const a = await app();
  try {
    a.imp(); a.stockAll(); const id = tank(a.w);
    const r = a.j(`return AquaFlow.produce({ txId: 'T2', code: 'B500', qty: 2, picks: { bottle: rawMaterials.find(function (m) { return m.name === 'Hexa plain 500ml'; }).id }, tankId: ${JSON.stringify(id)}, extras: [] });`);
    assert.equal(r.ok, true, r.error);
    assert.equal(a.stock('Hexa plain 500ml'), 952, '2 bales x 24'); assert.equal(a.stock('All Caps'), 952); assert.equal(a.stock('Wrappers 500ml'), 998, 'one wrapper per bale');
    assert.equal(a.j(`return tanks[tanks.length - 1].currentVolumeLiters`), 76, '48 bottles x 0.5 L = 24 L');
    assert.equal(a.j(`return products.find(function (p) { return p.code === 'S500'; }).qty`), 48, 'the sealed bottle the bale is linked to gets 48');
  } finally { a.close(); }
});

test('5 everything is checked first: not enough water / material / extra changes NOTHING', async () => {
  const a = await app();
  try {
    a.imp(); a.stockAll(); const id = tank(a.w);
    const snap = () => JSON.stringify([a.stock('Hexa plain 500ml'), a.stock('All Caps'), a.j(`return tanks[tanks.length - 1].currentVolumeLiters`), a.j(`return matMovements.length`), a.j(`return productionLog.length`), a.j(`return products.find(function (p) { return p.code === 'S500'; }).qty`)]);
    const before = snap(), hx = `rawMaterials.find(function (m) { return m.name === 'Hexa plain 500ml'; }).id`;
    let r = a.j(`return AquaFlow.produce({ txId: 'W1', code: 'S500', qty: 300, picks: { bottle: ${hx} }, tankId: ${JSON.stringify(id)}, extras: [] });`);
    assert.equal(r.ok, false); assert.match(r.error, /Not enough water/); assert.equal(snap(), before);
    a.topUp('All Caps', 3);
    r = a.j(`return AquaFlow.produce({ txId: 'W2', code: 'S500', qty: 10, picks: { bottle: ${hx} }, tankId: ${JSON.stringify(id)}, extras: [] });`);
    assert.equal(r.ok, false); assert.match(r.error, /Not enough/); a.topUp('All Caps', 1000); assert.equal(a.j(`return tanks[tanks.length - 1].currentVolumeLiters`), 100, 'water untouched');
    a.topUp('Grip plain 500ml', 4);
    r = a.j(`return AquaFlow.produce({ txId: 'W3', code: 'S500', qty: 10, picks: { bottle: ${hx} }, tankId: ${JSON.stringify(id)}, extras: [{ materialId: rawMaterials.find(function (m) { return m.name === 'Grip plain 500ml'; }).id, qty: 9 }] });`);
    assert.equal(r.ok, false); assert.match(r.error, /Not enough Grip/); assert.equal(a.stock('Hexa plain 500ml'), 1000); assert.equal(a.j(`return productionLog.length`), 0);
    // an extra that is the SAME material as the bottle is counted together with the bottle
    a.topUp('Hexa plain 500ml', 12);
    r = a.j(`return AquaFlow.produce({ txId: 'W4', code: 'S500', qty: 10, picks: { bottle: ${hx} }, tankId: ${JSON.stringify(id)}, extras: [{ materialId: ${hx}, qty: 5 }] });`);
    assert.equal(r.ok, false, 'needs 15 in total, only 12'); assert.equal(a.stock('Hexa plain 500ml'), 12);
    // a missing choice is refused, never guessed
    r = a.j(`return AquaFlow.produce({ txId: 'W5', code: 'S500', qty: 1, picks: {}, tankId: ${JSON.stringify(id)}, extras: [] });`);
    assert.equal(r.ok, false); assert.match(r.error, /Choose the bottle/);
  } finally { a.close(); }
});

test('6 extras are deducted and recorded; an unlimited tank is not drawn down; a reversal returns materials AND water', async () => {
  const a = await app();
  try {
    a.imp(); a.stockAll(); a.topUp('Grip plain 500ml', 50);
    const inf = a.w.eval(`AquaFlow.createTank({ name: 'Borehole', infinite: true }).tank.id`), fin = tank(a.w);
    let r = a.j(`return AquaFlow.produce({ txId: 'X1', code: 'S500', qty: 4, picks: { bottle: rawMaterials.find(function (m) { return m.name === 'Hexa plain 500ml'; }).id }, tankId: ${JSON.stringify(inf)}, extras: [{ materialId: rawMaterials.find(function (m) { return m.name === 'Grip plain 500ml'; }).id, qty: 3 }] });`);
    assert.equal(r.ok, true, r.error); assert.equal(a.stock('Grip plain 500ml'), 47); assert.equal(a.j(`return tanks.find(function (t) { return t.id === ${JSON.stringify(inf)}; }).infinite`), true);
    const rec = a.j(`return productionLog[0];`); assert.ok(rec.componentsUsed.some((c) => c.category === 'extra' && c.qtyUsed === 3)); assert.equal(rec.extraCost, 14.55);
    r = a.j(`return AquaFlow.produce({ txId: 'X2', code: 'S500', qty: 10, picks: { bottle: rawMaterials.find(function (m) { return m.name === 'Hexa plain 500ml'; }).id }, tankId: ${JSON.stringify(fin)}, extras: [] });`);
    assert.equal(a.j(`return tanks.find(function (t) { return t.id === ${JSON.stringify(fin)}; }).currentVolumeLiters`), 95);
    const rev = a.j(`return AquaMat.reverseProduction(productionLog[1].id, 'wrong count');`); assert.equal(rev.ok, true, rev.error);
    assert.equal(a.j(`return tanks.find(function (t) { return t.id === ${JSON.stringify(fin)}; }).currentVolumeLiters`), 100, 'water returned');
    assert.equal(a.stock('All Caps'), 996, 'caps of the reversed run returned (1000 - 4)');
    const rev2 = a.j(`return AquaMat.reverseProduction(productionLog[1].id, 'again');`); assert.equal(a.j(`return tanks.find(function (t) { return t.id === ${JSON.stringify(fin)}; }).currentVolumeLiters`), 100, 'a second reversal never returns water twice');
  } finally { a.close(); }
});

test('7 production-only tanks are never drawn by refill sales and not counted in the sales water total', async () => {
  const a = await app();
  try {
    const sale = a.j(`var shop = sites.find(function (s) { return s.type === 'shop'; }) || sites[0]; var before = totalTankVolume(shop.id); tanks.push({ id: 'ptx', siteId: shop.id, name: 'P', capacityLiters: 500, currentVolumeLiters: 500, lowStockThresholdLiters: 50, refillLog: [], productionOnly: true });
      var after = totalTankVolume(shop.id); deductFromTanks(10, shop.id); return { before: before, after: after, level: tanks.find(function (t) { return t.id === 'ptx'; }).currentVolumeLiters };`);
    assert.equal(sale.before, sale.after); assert.equal(sale.level, 500);
  } finally { a.close(); }
});

test('8 client default bottles: CSV import creates clients, prefills the bottle, stays changeable, can be remembered', async () => {
  const a = await app();
  try {
    a.imp(); a.stockAll();
    const res = a.j(`var p = AquaFlow.clientCsvPlan(${JSON.stringify(CLIENTS)}); var r = AquaFlow.clientCsvApply(p); return { bad: p.bad, errs: p.errors, r: r, n: customers.length };`);
    assert.equal(res.bad, 0); assert.equal(res.r.createdClients, 4); assert.equal(res.n, 4); assert.equal(res.r.saved, 6);
    const neat = a.j(`var c = customers.find(function (x) { return x.name === 'Neat Caterers'; }); return c.bottlePrefs['500'].map(function (id) { return rawMaterials.find(function (m) { return m.id === id; }).name; });`);
    assert.deepEqual(neat, ['Banana plain 500ml', 'Aqua clear 500ml'], 'first listed = default, the other is "also used"');
    // the Production screen: pick the item, then the client -> bottle step is already chosen
    a.b?.w; a.w.eval(`AquaFlow.fProduct('S500'); AquaFlow.fClient(customers.find(function (x) { return x.name === "Jay's Kitchen"; }).id);`);
    const sel = a.w.eval(`(function(){ var el = Array.prototype.filter.call(document.querySelectorAll('#aqf-root select'), function (s) { return /fPick\\('bottle'/.test(s.getAttribute('onchange') || ''); })[0]; return el ? el.options[el.selectedIndex].text : null; })()`);
    assert.match(String(sel), /^Hexa clear 500ml/, 'saved bottle preloaded: ' + sel);
    assert.match(a.w.eval(`document.getElementById('aqf-root').innerHTML`), /saved bottle \(you can change it\)/);
    // changed to another bottle and remembered as the new default
    const id = tank(a.w);
    const r = a.j(`var jk = customers.find(function (x) { return x.name === "Jay's Kitchen"; }); var out = AquaFlow.produce({ txId: 'K1', code: 'S500', qty: 6, clientId: jk.id, remember: true, picks: { bottle: rawMaterials.find(function (m) { return m.name === 'Grip plain 500ml'; }).id }, tankId: ${JSON.stringify(id)}, extras: [] }); return { out: out, first: rawMaterials.find(function (m) { return m.id === jk.bottlePrefs['500'][0]; }).name, rec: productionLog[0] };`);
    assert.equal(r.out.ok, true, r.out.error); assert.equal(r.first, 'Grip plain 500ml'); assert.equal(r.rec.clientName, "Jay's Kitchen");
    assert.deepEqual(a.errors, []);
  } finally { a.close(); }
});

test('9 the 9-step screen draws without errors and refuses to record until it is complete', async () => {
  const a = await app();
  try {
    a.imp(); a.stockAll(); const id = tank(a.w);
    a.w.eval(`AquaFlow.fProduct('B500'); AquaFlow.fQty('2'); AquaFlow.fTank(${JSON.stringify(id)});`);
    const html = a.w.eval(`document.getElementById('aqf-root').innerHTML`);
    for (const t of ['What are you producing', 'Client', 'Bottle', 'Seal', 'Cap', 'Label', 'Wrapping', 'Water', 'Any other material']) assert.match(html, new RegExp(t), t);
    assert.match(html, /Choose the bottle|choose the bottle/, 'asks for the bottle when several are possible');
    assert.equal(a.w.eval(`document.getElementById('aqf-go').disabled`), true);
    a.w.eval(`AquaFlow.fPick('bottle', rawMaterials.find(function (m) { return m.name === 'Hexa plain 500ml'; }).id);`);
    assert.match(a.w.eval(`document.getElementById('aqf-root').innerHTML`), /Uses 48/);
    assert.equal(a.w.eval(`document.getElementById('aqf-go').disabled`), false);
    a.w.eval(`AquaFlow.record();`);
    assert.equal(a.j(`return productionLog.length`), 1); assert.equal(a.stock('Hexa plain 500ml'), 952);
    assert.deepEqual(a.errors, []);
  } finally { a.close(); }
});

test('10 material form: add with bags + loose pieces, cost per bag, links; edit keeps stock', async () => {
  const a = await app();
  try {
    const r = a.j(`return AquaFlow.saveMaterial({ name: 'Grip plain 500ml', code: 'GP5', cat: 'bottle', sizes: [500], kinds: ['sealed', 'bale'], cost: 485, costPer: 'bag', ppb: 100, bags: 2, loose: 30 });`);
    assert.equal(r.ok, true, r.error);
    const m = a.mat('Grip plain 500ml'); assert.equal(m.stockQty, 230); assert.ok(Math.abs(m.unitCost - 4.85) < 1e-9); assert.equal(m.bagCost, 485); assert.deepEqual(m.forItems.sort(), ['500:bale', '500:sealed']); assert.equal(m.sku, 'GP5');
    assert.equal(a.j(`return matMovements.filter(function (x) { return x.type === 'opening'; }).length`), 1);
    assert.equal(a.j(`return AquaFlow.saveMaterial({ name: 'Bad', cat: 'cap', sizes: [500], kinds: [], cost: 1, costPer: 'piece' });`).ok, false, 'size without type is refused');
    assert.equal(a.j(`return AquaFlow.saveMaterial({ name: 'Bad2', cat: 'cap', sizes: [], kinds: [], cost: 100, costPer: 'bag' });`).ok, false, 'cost per bag needs pieces per bag');
    const e = a.j(`return AquaFlow.saveMaterial({ id: rawMaterials[0].id, name: 'Grip plain 500ml', cat: 'bottle', sizes: [500], kinds: ['sealed'], cost: 5, costPer: 'piece' });`);
    assert.equal(e.ok, true); assert.equal(a.mat('Grip plain 500ml').stockQty, 230, 'editing never changes stock'); assert.equal(a.mat('Grip plain 500ml').unitCost, 5);
    assert.equal(a.j(`return AquaFlow.saveMaterial({ name: 'grip PLAIN 500ml', cat: 'bottle', sizes: [], kinds: [] });`).ok, false, 'same name in the same type is refused');
    // the form itself opens and saves through the screen
    a.w.eval(`AquaFlow.openMat();`); a.w.eval(`document.getElementById('aqf-m-name').value = 'Test cap'; AquaFlow.mCat('cap'); AquaFlow.mSize(1000); AquaFlow.mKind('sealed'); document.getElementById('aqf-m-cost').value = '60'; document.getElementById('aqf-m-cu').value = 'bag'; document.getElementById('aqf-m-ppb').value = '100'; AquaFlow.mCalc(); AquaFlow.mSave();`);
    assert.deepEqual(a.mat('Test cap').forItems, ['1000:sealed']);
    assert.deepEqual(a.errors, []);
  } finally { a.close(); }
});

test('11 price list with client prices; invoices: totals, payments, void, numbering; persisted and in the sync payload', async () => {
  const a = await app();
  try {
    a.j(`customers.push({ id: 'c1', name: 'The Twist', phone: '0712', tokens: 0 }); return 1;`);
    assert.equal(a.j(`return AquaFlow.setClientPrice('c1', 'S500', 25);`), true);
    const pl = a.j(`var d = AquaFlow.priceListDoc('c1'); return { text: d.text, std: AquaFlow.priceListDoc('').text };`);
    assert.match(pl.text, /500ml Sealed Bottle: KES 25\.00/); assert.match(pl.std, /500ml Sealed Bottle: KES 30\.00/); assert.match(pl.std, /500ml Bale \(Case\) - 24 pcs: KES 380\.00/);
    const r = a.j(`return AquaFlow.saveInvoice({ clientId: 'c1', lines: [{ code: 'S500', qty: 10, price: 25 }, { code: 'B500', qty: 10, price: 360 }], discount: 100, delivery: 200, paid: 1000, dueDays: 7, notes: 'thanks' });`);
    assert.equal(r.ok, true, r.error); const inv = r.invoice;
    assert.equal(inv.subtotal, 3850); assert.equal(inv.total, 3950); assert.equal(inv.status, 'part'); assert.match(inv.no, /^INV-\d{8}-001$/);
    assert.equal(a.j(`return AquaFlow.saveInvoice({ name: 'Walk in', lines: [{ code: 'S500', qty: 1 }] }).invoice.no.slice(-3);`), '002');
    assert.equal(a.j(`return AquaFlow.recordPayment(aquaInvoices[0].id, 99999).ok;`), false, 'cannot over-pay');
    assert.equal(a.j(`return AquaFlow.recordPayment(aquaInvoices[0].id, 2950).invoice.status;`), 'paid');
    assert.equal(a.j(`return AquaFlow.voidInvoice(aquaInvoices[1].id, '').ok;`), false); assert.equal(a.j(`return AquaFlow.voidInvoice(aquaInvoices[1].id, 'wrong client').ok;`), true);
    assert.equal(a.j(`return AquaFlow.saveInvoice({ id: aquaInvoices[1].id, name: 'x', lines: [{ code: 'S500', qty: 1 }] }).ok;`), false, 'voided invoice cannot be edited');
    const doc = a.j(`var d = AquaFlow.invoiceDoc(aquaInvoices[0]); return d.text;`); assert.match(doc, /TOTAL: KES 3,950\.00/); assert.match(doc, /PAID|Balance: KES 0\.00/i);
    a.w.eval(`AquaFlow.viewInvoice(aquaInvoices[0].id)`); assert.match(a.w.eval(`document.getElementById('sales-report-body').innerHTML`), /INVOICE/);
    // persisted + in the payload sent to the server
    a.w.eval(`saveAllLocal()`); assert.equal(JSON.parse(a.w.localStorage.getItem('aqua_invoices')).length, 2);
    assert.equal(a.j(`return collectSyncPayload().aquaInvoices.length`), 2);
    // the tab draws
    a.w.eval(`AquaFlow.renderDocs(); AquaFlow.dSet('tab', 'inv');`); assert.match(a.w.eval(`document.getElementById('aqf-docs-root').innerHTML`), /INV-\d{8}-001/);
    assert.deepEqual(a.errors, []);
  } finally { a.close(); }
});

test('12 the server merges aquaInvoices by id', async () => {
  const m = await import(path.join(ROOT, 'functions', 'api', '_merge.js'));
  assert.ok(m.MERGE_BY_ID_FIELDS.includes('aquaInvoices'));
});
