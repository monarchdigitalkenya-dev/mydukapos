import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 286 — "Sell at the bar": shots / doubles are always offered (first in the list), and a quantity can be a fraction (0.5, 1.5, 0.25).
const INV = [
  { code: 'JWB', type: 'item', name: 'JW Black 750ml', category: 'Whisky', price: 7000, wholesalePrice: 3000, qty: 2, unit: 'pcs', vatCategory: 'A' },
  { code: 'TUS', type: 'item', name: 'Tusker 500ml', category: 'Beer', price: 300, wholesalePrice: 200, qty: 24, unit: 'pcs', vatCategory: 'A' },
];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app() {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(INV), pos_tables: JSON.stringify(['Table 05']) }, wait: 1500 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); };");
  return b;
}

test('shots and doubles are offered first, even when their category is set to another station', async () => {
  const { w } = await app();
  w.eval("hospMakePours('JWB', 750, { shot: 350, double: 650 })");
  w.eval("hospConfig.categoryStations = Object.assign({}, hospConfig.categoryStations, { Whisky: 'kitchen' })");     // the owner's category setting would have dropped them before
  const names = J(w, 'barSellItems().map(it => it.name)');
  assert.ok(names.some((n) => /Shot 30ml/.test(n)), 'the shot is offered: ' + names.join(' | '));
  assert.ok(names.some((n) => /Double/.test(n)), 'the double is offered');
  assert.ok(names.indexOf(names.find((n) => /Shot/.test(n))) < names.indexOf('Tusker 500ml'), 'servings come before plain items');
});

test('a quantity can be a fraction: 0.5 of a shot, 1.5 of a beer; the total follows; never more than the bottle holds', async () => {
  const { w } = await app();
  w.eval("hospMakePours('JWB', 750, { shot: 350, double: 650 })");
  w.eval("barSellOpen(); barSellAdd('JWB-shot', ''); barSellAdd('TUS', '')");
  assert.equal(J(w, 'barSell.lines.map(l => l.qty)').join(), '1,1');
  w.eval('barSellSet(0, "0.5")');
  assert.equal(J(w, 'barSell.lines[0].qty'), 0.5);
  assert.equal(J(w, 'barSellTotal()'), 175 + 300, 'half a 350 shot + one beer');
  w.eval('barSellQty(1, 0.5)');
  assert.equal(J(w, 'barSell.lines[1].qty'), 1.5);
  assert.equal(J(w, 'barSellTotal()'), 175 + 450);
  const e = J(w, 'barSellEntries()');
  assert.equal(e[0].qty, 0.5); assert.equal(e[0].serving.ml, 30);
  // typing nonsense or 0 leaves the quantity alone; the input is on screen
  w.eval('barSellSet(0, "abc"); barSellSet(0, "0")');
  assert.equal(J(w, 'barSell.lines[0].qty'), 0.5);
  assert.ok(w.document.querySelector('#bar-sell .bs-qin'), 'the quantity box is shown');
  // more shots than the open + sealed bottles hold is refused (2 bottles = 1500 ml = 50 shots)
  w.eval('barSellSet(0, "60")');
  assert.equal(J(w, 'barSell.lines[0].qty'), 0.5, 'refused');
  assert.ok(J(w, 'window.__toasts').some((t) => /^ERR /.test(t)), 'told why');
  // minus from a half removes the line
  w.eval('barSellQty(0, -1)');
  assert.equal(J(w, 'barSell.lines.length'), 1);
});
