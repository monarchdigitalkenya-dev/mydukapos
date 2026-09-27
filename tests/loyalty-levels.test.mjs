import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 141 — member levels on top of the loyalty spend brackets: the level comes from what the customer spent (from the sales
// themselves), multiplies the tokens a sale earns, is announced when reached, shown to the cashier, and reported.
const INV = [{ code: 'STK', type: 'item', name: 'Steak', category: 'Mains', price: 5000, wholesalePrice: 2000, qty: 100, unit: 'pcs', vatCategory: 'A' }];
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app() {
  const b = await boot('hotel/index.html', { storage: { pos_inventory: JSON.stringify(INV), pos_tables: JSON.stringify(['Table 05']), pos_loyalty_enabled: 'true', pos_loyalty_tiers: JSON.stringify([{ id: 't1', minSpend: 1000, maxSpend: null, tokens: 10 }]) }, wait: 1500 });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; queuePrintJob = function () { return Promise.resolve(); }; renderReceipt = function () {}");
  return b;
}
const sale = (w, phone, amount, daysAgo = 0) => w.eval(`salesLog.push({ id: 'x' + Math.random(), timestamp: new Date(Date.now() - ${daysAgo} * 86400000).toISOString(), customerPhone: '${phone}', items: [{ code: 'STK', name: 'Steak', qty: 1, price: ${amount} }] })`);

test('levels: worked out from spend in the period, multiply tokens, announced once, shown at settle; tab payments now earn tokens too', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("hospSetMemberLevels(HOSP_LEVEL_DEFAULTS.map(l => l.id === 'gold' ? { ...l, perks: 'free dessert' } : l))");
  assert.deepEqual(J(w, 'hospMemberLevels().map(l => l.id + ":" + l.minSpend + "x" + l.multiplier)'), ['silver:20000x1.5', 'gold:100000x2']);
  w.eval("registerOrUpdateCustomer('0712000000', 'Jane')");
  sale(w, '0712000000', 15000); sale(w, '0712000000', 90000, 400);        // the old one is outside the 365-day window
  assert.equal(J(w, "hospCustomerSpend('0712000000')"), 15000);
  assert.equal(J(w, "hospMemberLevel('0712000000')"), null);
  // a table order paid by Jane: 2 steaks = 10,000 → Silver; tokens 10 × 1.5 = 15
  await w.eval("routeOrderToTab('Table 05'); currentPaymentMethod = 'tab'; addToCart('STK'); addToCart('STK'); checkoutCart()");
  const tab = J(w, "findOpenTabByLabel('Table 05')");
  w.eval(`tabs.find(t => t.id === '${tab.id}').customerPhone = '0712000000'`);
  w.eval(`settleTabDirect('${tab.id}'); document.getElementById('tab-settle-cash-tendered-input').value = '10000'; confirmTabSettle()`);
  const jane = J(w, "customers.find(c => c.phone === '0712000000')");
  assert.equal(jane.tokens, 15, 'the tab payment earned tokens, at the Silver rate');
  assert.equal(jane.level, 'silver');
  assert.equal((w.eval('window.__toasts') || []).filter((t) => /Jane is now a 🥈 Silver member/.test(t)).length, 1);
  // the window: counting ever brings the old 90,000 in → Gold, with its perks shown at the next settle
  w.eval('hospSetMemberLevels(hospMemberLevels(), 0)');
  assert.equal(J(w, "hospMemberLevel('0712000000').id"), 'gold');
  await w.eval("routeOrderToTab('Table 05'); currentPaymentMethod = 'tab'; addToCart('STK'); checkoutCart()");
  const t2 = J(w, "findOpenTabByLabel('Table 05')");
  w.eval(`tabs.find(t => t.id === '${t2.id}').customerPhone = '0712000000'; settleTabDirect('${t2.id}')`);
  assert.match(d.getElementById('tab-settle-summary').textContent, /🥇 Gold member — free dessert/);
  w.eval(`document.getElementById('tab-settle-cash-tendered-input').value = '5000'; confirmTabSettle()`);
  assert.equal(J(w, "customers.find(c => c.phone === '0712000000').tokens"), 15 + 20, 'Gold: 10 × 2');
  // voided sales don't count toward a level
  w.eval("salesLog.forEach(s => { if (s.customerPhone === '0712000000') s.voided = true; })");
  assert.equal(J(w, "hospMemberLevel('0712000000')"), null);
  // reported
  w.eval("salesLog.forEach(s => { s.voided = false; })");
  const r = J(w, 'hospBuildReport({ from: Date.now() - 3600000, to: Date.now() + 60000 }).loyalty');
  assert.deepEqual(r.counts, [['🥈 Silver', 0], ['🥇 Gold', 1]]);
  assert.equal(r.top[0][0], 'Jane');
  // the settings screen
  w.eval('hospRenderMemberLevels()');
  assert.equal(d.querySelectorAll('#hosp-member-levels .lv-row').length, 2);
  b.close();
});
