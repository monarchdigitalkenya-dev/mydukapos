import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, ROOT } from './helpers.mjs';

// Zip 178 — Hotel/Restaurant import reads a "Sub-category" column: categories AND their sub-categories are created, and the same item name may
// exist once per sub-category (Camel Tea 80 / Camel Tea 150).
const J = (w, js) => { const r = w.eval(`JSON.stringify(${js})`); return r === undefined ? undefined : JSON.parse(r); };
const CSV = fs.readFileSync(path.join(ROOT, 'tests/fixtures/menu-import.csv'), 'utf8');

for (const ctx of ['all', 'dish']) {
  test(`menu workbook imports into "${ctx}": 5 categories, their sub-categories, two Camel Teas, every flavour in both milkshake sizes`, async () => {
    const { w, errors, close } = await boot('hotel/index.html', { storage: { pos_inventory: '[]', pos_utensils: '[]' }, wait: 1200 });
    w.eval("showToast = function () {}; window.confirm = () => true; window.prompt = () => null");
    w.eval(`hospImportOpen('${ctx}')`);
    await w.eval(`hospImpLoadRows(hospImpParseText(${JSON.stringify(CSV)}), 'menu.csv')`);
    assert.equal(J(w, 'hospImp.map.subcategory') !== undefined, true, 'Sub-category column recognised');
    assert.equal(J(w, 'hospImp.map.category') !== J(w, 'hospImp.map.subcategory'), true, 'not mistaken for the Category column');
    const res = await w.eval('hospImpCommit()');
    assert.equal(res.created, 51); assert.equal(res.attention, 0, JSON.stringify(res.problems));
    const cats = J(w, 'hospCategories.filter(c => !c._deleted).map(c => c.name).sort()');
    assert.deepEqual(cats, ['Beverages', 'Frozen Treats', 'Ice Cream', 'Milkshakes', 'Snacks']);
    const subs = J(w, `Object.fromEntries(hospCategories.filter(c => !c._deleted).map(c => [c.name, hospSubList(c.id).map(x => x.name)]))`);
    assert.deepEqual(subs.Milkshakes, ['100', '200']); assert.deepEqual(subs['Ice Cream'], ['50', '100']);
    assert.deepEqual(subs.Beverages.sort(), ['100', '150', '50', '60', '80']);
    assert.deepEqual(subs.Snacks, []);
    const subName = (code) => J(w, `(() => { const p = inventory.find(x => x.code === '${code}'); return hospSubList(p.categoryId).find(x => x.id === p.subCat).name; })()`);
    const camel = J(w, "inventory.filter(p => p.name === 'Camel Tea').map(p => p.price).sort((a,b)=>a-b)");
    assert.deepEqual(camel, [80, 150], 'two Camel Teas, one per price (not renamed "(2)")');
    assert.equal(subName('BEV-CAMEL-80'), '80'); assert.equal(subName('BEV-CAMEL-150'), '150');
    assert.equal(J(w, "inventory.find(p => p.code === 'MSH-VAN-200').price"), 200);
    assert.equal(subName('MSH-VAN-200'), '200'); assert.equal(subName('MSH-VAN-100'), '100');
    assert.equal(J(w, "inventory.filter(p => p.category === 'Milkshakes').length"), 14);
    assert.equal(J(w, "inventory.every(p => hospCatKindOf(p) === 'dish')"), true);
    // importing the same file again changes nothing (duplicates are skipped, not doubled)
    w.eval(`hospImportOpen('${ctx}')`);
    await w.eval(`hospImpLoadRows(hospImpParseText(${JSON.stringify(CSV)}), 'menu.csv')`);
    const again = await w.eval('hospImpCommit()');
    assert.equal(again.created, 0); assert.equal(J(w, 'inventory.length'), 51);
    assert.deepEqual(errors, []);
    close();
  });
}
