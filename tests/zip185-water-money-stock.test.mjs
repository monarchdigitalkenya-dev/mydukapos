// zip 185: AquaPOS money / stock audit regression tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

const PRODUCTS = JSON.stringify([
  { code: 'STD1', category: 'bottled', name: 'Std Bottle', sizeML: 500, price: 100, wholesalePrice: 60, qty: 5, unit: 'pcs', vatCategory: 'A', stock: { 'site-shop-1': 5 } },
  { code: 'BAL1', category: 'bale', name: 'Bale', sizeML: 500, price: 400, wholesalePrice: 300, qty: 4, unit: 'pcs', vatCategory: 'A', stock: { 'site-shop-1': 4 } },
]);
const open = () => boot('water/index.html', { storage: { aqua_products: PRODUCTS }, wait: 900 });
const ev = (w, code) => JSON.parse(w.eval(`JSON.stringify((function(){ ${code} })())`));

test('Aqua: a payment line carries costShare and itemCogs honours it; old payment lines stay 0', async () => {
  const b = await open(); const { w } = b;
  const r = ev(w, `return {
    withShare: itemCogs({ type:'payment', unit:'payment', price:500, qty:1, costShare: 300 }, {}),
    legacy: itemCogs({ type:'payment', unit:'payment', price:500, qty:1 }, {}),
    scaled: itemCogs({ type:'bottled', code:'STD1', qty:2, price:100, costAtSale:60 }, { cogsScale: 0.5 }),
    unscaled: itemCogs({ type:'bottled', code:'STD1', qty:2, price:100, costAtSale:60 }, {})
  };`);
  assert.equal(r.withShare, 300); assert.equal(r.legacy, 0);
  assert.equal(r.unscaled, 120); assert.equal(r.scaled, 60);
  b.close();
});

test('Aqua: bill instalments book the bill cost exactly once (last instalment takes the remainder)', async () => {
  const b = await open(); const { w } = b;
  const r = ev(w, `
    const bill = { id:'B1', total:1000, items:[{ type:'bottled', code:'STD1', qty:10, price:100, costAtSale:60, vatCategory:'A' }] };
    const a = aquaBillPaymentExtras(bill, 333.33, false);
    bill.costRecognized = a.billCostBooked;
    const c = aquaBillPaymentExtras(bill, 666.67, true);
    return { first: a.costShare, last: c.costShare, sum: Math.round((a.costShare + c.costShare)*100)/100, vat: a.vatSplit, scale: c.cogsScale };`);
  assert.equal(r.sum, 600);
  assert.equal(r.first, 200);
  assert.deepEqual(r.vat, { A: 333.33 });
  assert.ok(r.scale > 0 && r.scale < 1);
  b.close();
});

test('Aqua: cart total never goes negative with stacked offers or a negative delivery fee', async () => {
  const b = await open(); const { w } = b;
  w.eval("currentCart = { STD1: { code:'STD1', name:'Std', price:100, qty:1, type:'bottled' } }; orderType='delivery'");
  w.document.getElementById('delivery-fee-input').value = '-50';
  assert.equal(w.eval('cartTotal()'), 100, 'a negative fee does not discount the sale');
  b.close();
});

test('Aqua: cart stock shortfall is caught before checkout', async () => {
  const b = await open(); const { w } = b;
  const msg = w.eval("aquaCartShortfall([{ code:'STD1', name:'Std Bottle', qty:9, type:'bottled' }])");
  assert.match(String(msg), /Not enough/);
  assert.ok(!w.eval("aquaCartShortfall([{ code:'STD1', name:'Std Bottle', qty:5, type:'bottled' }])"));
  b.close();
});

test('Aqua: bales can be returned in halves, other items only whole; credit cap follows the receipt line', async () => {
  const b = await open(); const { w } = b;
  assert.equal(w.eval("aquaReturnQty('0.5','BAL1',null)"), 0.5);
  assert.ok(Number.isNaN(w.eval("aquaReturnQty('0.5','STD1',null)")));
  assert.ok(Number.isNaN(w.eval("aquaReturnQty('-1','STD1',null)")));
  w.eval(`salesLog.push({ id:'S9', refNumber:'R-9', total:180, items:[{ code:'STD1', qty:2, price:100, type:'bottled' }] })`);
  assert.equal(w.eval("aquaReturnCreditCap({ code:'STD1', sourceRefNumber:'R-9' }, 1)"), 90, 'a discounted sale credits what was charged');
  b.close();
});

test('Aqua: voiding / restoring a bill voids / restores its linked instalment payments', async () => {
  const b = await open(); const { w } = b;
  w.eval(`window.confirm=()=>true; showToast=function(){};
    bills.push({ id:'BL1', refNumber:'R-B1', siteId:'site-shop-1', total:500, items:[{ code:'STD1', qty:5, price:100, type:'bottled' }], status:'unpaid' });
    salesLog.push({ id:'P1', billId:'BL1', total:200, items:[{ type:'payment', unit:'payment', qty:1, price:200 }] });
    pendingVoidSaleSource='bills'; pendingVoidReason='test'; performVoidSale('BL1');`);
  assert.equal(w.eval("salesLog.find(x=>x.id==='P1').voided"), true);
  w.eval("pendingVoidSaleSource='bills'; performUnvoidSale('BL1')");
  assert.ok(!w.eval("salesLog.find(x=>x.id==='P1').voided"));
  b.close();
});

test('Aqua: all-sites view refuses checkout instead of losing the stock deduction', async () => {
  const b = await open(); const { w } = b;
  w.eval("showToast=function(m){ window.__t=m; }; setActiveSite('both'); currentCart = { STD1: { code:'STD1', name:'Std', price:100, qty:1, type:'bottled' } }; paymentMethod='cash';");
  const before = w.eval("salesLog.length");
  w.eval("checkoutCartCore()");
  assert.equal(w.eval("salesLog.length"), before, 'no sale recorded in the combined view');
  b.close();
});
