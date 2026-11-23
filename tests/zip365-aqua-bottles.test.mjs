// zip 365 - Aqua POS: finished water stock PER BOTTLE (Grip, Aqua clear...), client bottles counted but off the Sales Counter / Price List,
// "📋 Paste stock balances" in Production (the owner's list, as typed), and production going to the bottle actually picked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

const LIST = `Packaged Water balances as @ 04/5/2026

1ltr Grip blue 26bales
1ltr clear blue 2bales
1ltr antik plain 12bales

500ml banana/Grip  117bales
500ml Aqua clear  38bales
500ml Aqua blue 3bales
500ml Jays Hexa 5bales
500ml Bistro Hexa 8bales
1500ml Grip clear 4bales`;

async function app() {
  const b = await boot('water/index.html', { wait: 1200 });
  const j = (code) => JSON.parse(b.w.eval(`JSON.stringify((function(){${code}})())`) ?? 'null');
  b.w.eval(`
    window.confirm = function () { return true; }; window.prompt = function () { return null; };
    rawMaterials.length = 0; products.length = 0; productionLog.length = 0; matMovements.length = 0; customers.length = 0;
    window.__site = (sites.find(function (s) { return s.type === 'production'; }) || sites[0]).id; activeSiteId = window.__site;
    products.push({ code: 'S500', name: '500ml Sealed Bottle', siteId: window.__site, category: 'bottled', sizeML: 500, price: 30, qty: 240, stock: {}, priceTiers: [], vatCategory: 'A', productionRecipe: [] });
    products.push({ code: 'B500', name: '500ml Bale (Case) - 24 pcs', siteId: window.__site, category: 'bale', sizeML: 500, bottlesPerBale: 24, linkedBottleCode: 'S500', price: 380, qty: 10, stock: {}, priceTiers: [], vatCategory: 'A', productionRecipe: [] });
    products.push({ code: 'S1000', name: '1L Sealed Bottle', siteId: window.__site, category: 'bottled', sizeML: 1000, price: 50, qty: 0, stock: {}, priceTiers: [], vatCategory: 'A', productionRecipe: [] });
    products.push({ code: 'B1000', name: '1L Bale (Case) - 12 pcs', siteId: window.__site, category: 'bale', sizeML: 1000, bottlesPerBale: 12, linkedBottleCode: 'S1000', price: 500, qty: 0, stock: {}, priceTiers: [], vatCategory: 'A', productionRecipe: [] });
    commitQtyView(window.__site);
    customers.push({ id: 'c-jays', name: 'Jays Kitchen', phone: '0711000001' }, { id: 'c-bistro', name: 'Bistro Cafe', phone: '0711000002' });
    ['Grip plain 500ml', 'Aqua clear 500ml', 'Aqua blue 500ml', 'Hexa plain 500ml'].forEach(function (n) { AquaFlow.saveMaterial({ name: n, cat: 'bottle', sizes: [500], kinds: ['sealed', 'bale'] }); });
    AquaFlow.saveMaterial({ name: 'Caps', cat: 'cap', sizes: [500, 1000, 1500], kinds: ['sealed', 'bale'], cost: 1, costPer: 'piece', bags: 0, loose: 100000 });
    AquaFlow.syncRecipes();
  `);
  return { ...b, j };
}

test('the owner\'s list, pasted as typed: read, matched, client bottles found, saved per bottle', async () => {
  const a = await app();
  try {
    const plan = a.j(`return AquaBottles.parse(${JSON.stringify(LIST)});`);
    assert.equal(plan.date, '04/5/2026');
    assert.equal(plan.rows.length, 9, JSON.stringify(plan.skipped)); assert.equal(plan.skipped.length, 0);
    const by = (t) => plan.rows.find((r) => r.text.startsWith(t));
    const nameOf = (id) => a.j(`var m = rawMaterials.find(function (x) { return x.id === ${JSON.stringify(id)}; }); return m ? m.name : null;`);
    assert.equal(nameOf(by('500ml banana/Grip').matId), 'Grip plain 500ml'); assert.equal(by('500ml banana/Grip').qty, 117);
    assert.equal(nameOf(by('500ml Aqua clear').matId), 'Aqua clear 500ml');
    assert.equal(nameOf(by('500ml Aqua blue').matId), 'Aqua blue 500ml');
    assert.equal(by('500ml Jays Hexa').clientId, 'c-jays'); assert.equal(by('500ml Jays Hexa').matId, '', 'a client bottle, not the general Hexa');
    assert.equal(by('500ml Bistro Hexa').clientId, 'c-bistro');
    assert.equal(by('1ltr Grip blue').size, 1000); assert.equal(by('1ltr Grip blue').matId, ''); assert.equal(by('1ltr Grip blue').newName, 'Grip blue 1000ml');
    assert.equal(by('1500ml Grip clear').size, 1500);
    // the preview, then Save
    a.w.eval(`AquaBottles.openPaste(); document.getElementById('aqb-text').value = ${JSON.stringify(LIST)}; AquaBottles.preview();`);
    assert.equal(a.d.querySelectorAll('#aqb-box tbody tr').length, 9);
    assert.ok(a.d.getElementById('aqb-zero'), 'offers to zero the old stock with no bottle');
    a.w.eval('AquaBottles.apply()');
    assert.equal(a.d.getElementById('aqb-ov').classList.contains('on'), false, a.d.getElementById('aqb-err') && a.d.getElementById('aqb-err').textContent);
    const bales = (label, size) => a.j(`var p = products.find(function (x) { return x.bottleOf && x.category === 'bale' && x.sizeML === ${size} && x.name.indexOf(${JSON.stringify(label)}) >= 0; }); return p ? { code: p.code, qty: effectiveQtyOf(p), name: p.name, client: p.clientId || null, link: p.linkedBottleCode } : null;`);
    const grip = bales('— Grip plain', 500); assert.equal(grip.qty, 117); assert.match(grip.name, /^500ml Bale \(Case\) - 24 pcs — Grip plain$/);
    assert.equal(a.j(`return products.find(function (x) { return x.code === ${JSON.stringify(grip.link)}; }).qty`), 117 * 24, 'stored as sealed bottles (one pool)');
    assert.equal(bales('Aqua clear', 500).qty, 38); assert.equal(bales('Aqua blue', 500).qty, 3);
    const jays = bales('Jays Hexa', 500); assert.equal(jays.qty, 5); assert.equal(jays.client, 'c-jays'); assert.match(jays.name, /client: Jays Kitchen/);
    assert.equal(bales('Bistro Hexa', 500).qty, 8);
    assert.equal(bales('Grip blue', 1000).qty, 26); assert.equal(bales('clear blue', 1000).qty, 2); assert.equal(bales('antik plain', 1000).qty, 12);
    assert.equal(bales('Grip clear', 1500).qty, 4, '1.5L items made for a size that had none');
    assert.equal(a.j(`return products.find(function (x) { return x.code === 'S500'; }).qty`), 0, 'old stock with no bottle set to 0');
    // new bottles went to Materials, the Jays bottle marked as theirs
    assert.equal(a.j(`return rawMaterials.find(function (m) { return m.name === 'Jays Hexa 500ml'; }).clientId`), 'c-jays');
    assert.equal(a.j(`return rawMaterials.find(function (m) { return m.name === 'Hexa plain 500ml'; }).clientId || null`), null, 'the general Hexa stays general');
    // stock movements logged with the date
    assert.ok(a.j(`return stockMovementLog.some(function (x) { return /as at 04\\/5\\/2026/.test(x.reason || x.note || ''); })`), 'movement logged');
    // Sales Counter: general bottles shown, clients and the emptied plain items hidden
    a.w.eval("activeSiteId = window.__site; renderAllItemsGrid();");
    const grid = a.d.getElementById('all-items-grid').textContent;
    assert.match(grid, /Grip plain/); assert.match(grid, /Aqua clear/);
    assert.equal(/Jays Hexa|Bistro Hexa/.test(grid), false, 'client bottles not on the counter');
    assert.equal(a.j(`return AquaBottles.hideOnCounter(products.find(function (x) { return x.code === 'B500'; }))`), true, 'plain bale hidden once empty');
    // Price List: bottle items, no client bottles, no plain items
    const pl = a.j(`return AquaFlow.sellables().map(function (x) { return x.name; })`);
    assert.ok(pl.some((n) => /— Aqua clear/.test(n))); assert.equal(pl.some((n) => /Jays|Bistro/.test(n)), false); assert.equal(pl.includes('500ml Bale (Case) - 24 pcs'), false);
    // pasting again sets (not adds)
    a.w.eval(`AquaBottles.openPaste(); document.getElementById('aqb-text').value = '500ml Aqua clear 40 bales'; AquaBottles.preview(); AquaBottles.apply();`);
    assert.equal(bales('Aqua clear', 500).qty, 40);
    assert.deepEqual(a.errors, []);
  } finally { a.close(); }
});

test('production of the plain item goes to the bottle picked; a line it cannot read is reported', async () => {
  const a = await app();
  try {
    const grip = a.j(`return rawMaterials.find(function (m) { return m.name === 'Grip plain 500ml'; }).id`);
    a.w.eval(`rawMaterials.forEach(function (m) { if (m.category === 'bottle') m.stockQty = 10000; });`);
    // off by default: one stock per size, as before
    assert.equal(a.j(`return AquaBottles.perBottleOn(products.find(function (x) { return x.code === 'B500'; }))`), false);
    a.w.eval('AquaBottles.switchOn(true)');
    const ln = a.j(`var p = products.find(function (x) { return x.code === 'B500'; }); AquaMat.plan(p, 1, {}, {}); return p.productionRecipe.find(function (r) { return r.category === 'bottle'; }).lineId;`);
    const r = a.j(`return AquaMat.produce({ txId: 'tx-t1', code: 'B500', qty: 5, picks: { ${JSON.stringify(ln)}: ${JSON.stringify(grip)} }, allowNoRecipe: true, site: window.__site });`);
    assert.equal(r.ok, true, r.error);
    const v = a.j(`return products.find(function (x) { return x.bottleOf === 'B500' && x.bottleMatId === ${JSON.stringify(grip)}; })`);
    assert.ok(v, 'Grip bale item created'); assert.equal(a.j(`return effectiveQtyOf(products.find(function (x) { return x.code === ${JSON.stringify(v.code)}; }))`), 5);
    assert.equal(a.j(`return productionLog[productionLog.length - 1].targetId`), v.code, 'logged against the Grip bale');
    assert.equal(a.j(`return products.find(function (x) { return x.code === 'S500'; }).qty`), 240, 'plain stock untouched');
    // the variety's recipe uses only its own bottle
    assert.deepEqual(a.j(`AquaFlow.syncRecipes(); return products.find(function (x) { return x.code === ${JSON.stringify(v.code)}; }).productionRecipe.find(function (r) { return r.category === 'bottle'; }).eligible`), [grip]);
    // production lists the plain items only
    const p = a.j(`return AquaBottles.parse('hello there\\n500ml 3 bales\\nGrip 4 bales');`);
    assert.equal(p.skipped.length, 1, 'no size'); assert.equal(p.rows.length, 1);
    assert.deepEqual(a.errors, []);
  } finally { a.close(); }
});
