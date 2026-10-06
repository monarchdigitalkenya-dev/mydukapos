import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
// zip 232 — Record a Past Sale: many items, decimal or whole quantities, totals rounded up to a whole shilling, a photo Capture List with times.
const INV = [
  { code: 'S2', name: 'Sugar 2kg', price: 300, wholesalePrice: 250, qty: 20, unit: 'pcs' },
  { code: 'MK', name: 'Fresh Milk', price: 60.3, wholesalePrice: 40, qty: 10, unit: 'ltr' },
  { code: 'BR', name: 'Bread White', price: 55, wholesalePrice: 40, qty: 12, unit: 'pcs' },
];
const sales = (w) => JSON.parse(w.eval('JSON.stringify(salesLog)'));
async function open() {
  const b = await boot('index.html', { wait: 2500, storage: { pos_inventory: JSON.stringify(INV) } });
  b.w.eval('openRecordPastSaleModal()');
  return b;
}
test('P1: many items, decimal + whole quantity, total rounded UP to whole shillings with a Rounding line', async () => {
  const { w, d, close } = await open();
  assert.ok(d.getElementById('ps-lines'), 'multi-line area injected');
  w.psTestAdd({ code: 'S2', qty: 2, price: 300 });
  w.psTestAdd({ code: 'MK', qty: 0.5, price: 60.3 });      // 30.15
  w.psTestRender();
  d.getElementById('past-sale-date-input').value = '2026-10-04'; d.getElementById('past-sale-time-input').value = '09:30';
  w.saveRecordPastSale();
  assert.equal(d.getElementById('past-sale-error').textContent, '');
  const s = sales(w).filter((x) => x.recordedLate);
  assert.equal(s.length, 1);
  assert.equal(s[0].items.length, 3);                       // 2 items + rounding
  const r = s[0].items[2]; assert.equal(r.name, 'Rounding'); assert.equal(r.price, 0.85);
  assert.equal(s[0].cashAmount, 631);                       // 600 + 30.15 = 630.15 -> 631
  assert.equal(s[0].items.reduce((t, l) => t + l.price * l.qty, 0).toFixed(2), '631.00');
  assert.equal(w.eval("inventory.find(p => p.code==='MK').qty"), 9.5);
  assert.equal(w.eval("inventory.find(p => p.code==='S2').qty"), 18);
  close();
});
test('P2: 100.3 and 100.6 both become 101; exactly 100 stays 100', async () => {
  const { w, close } = await open();
  assert.equal(w.psWholeUp(100.3), 101); assert.equal(w.psWholeUp(100.6), 101); assert.equal(w.psWholeUp(100), 100); assert.equal(w.psWholeUp(100.0000001), 100);
  close();
});
test('P3: lines with different times become separate sales; unmatched line blocks saving', async () => {
  const { w, d, close } = await open();
  w.psTestAdd({ code: 'BR', qty: 3, price: 55, time: '08:10' });
  w.psTestAdd({ code: 'S2', qty: 1, price: 300, time: '14:45' });
  w.psTestAdd({ code: '', written: 'zzzz thing', qty: 1, price: 10 });
  w.psTestRender();
  d.getElementById('past-sale-date-input').value = '2026-10-03'; d.getElementById('past-sale-time-input').value = '12:00';
  w.saveRecordPastSale();
  assert.match(d.getElementById('past-sale-error').textContent, /Line 3/);
  assert.equal(sales(w).filter((x) => x.recordedLate).length, 0, 'nothing recorded while a line is unmatched');
  w.psRemove(w.psTestState().lines[2].id);
  w.saveRecordPastSale();
  const s = sales(w).filter((x) => x.recordedLate);
  assert.equal(s.length, 2);
  assert.deepEqual(s.map((x) => new Date(x.timestamp).getHours() * 100 + new Date(x.timestamp).getMinutes()).sort((a, b) => a - b), [810, 1445]);
  close();
});
test('P4: matcher — misspellings, plural, code, size must agree, price breaks a tie', async () => {
  const { w, close } = await open();
  assert.equal(w.psMatch('sugar 2 kg', '', 300).item.code, 'S2');
  assert.equal(w.psMatch('Fresh milks', '', 0).item.code, 'MK');
  assert.equal(w.psMatch('whatever', 'br', 0).item.code, 'BR');
  assert.equal(w.psMatch('Bred white', '', 55).item.code, 'BR');
  assert.equal(w.psMatch('Sugar 1kg', '', 0).item, null, 'a different size is not matched silently');
  close();
});
test('P5: photo capture fills the lines with matches and times', async () => {
  const { w, d, close } = await boot('index.html', {
    wait: 2500, storage: { pos_inventory: JSON.stringify(INV) },
    fetch: async (url, init) => ({ ok: true, json: async () => ({ document_type: 'items', items: [
      { detected_name: 'Sugar 2kg', quantity: 2, retail_price: 300, sold_time: '09:05', sold_date: '', confidence_score: .9 },
      { detected_name: 'Bred', quantity: 1.5, retail_price: 0, line_total: 82.5, sold_time: '09:05', sold_date: '', confidence_score: .8 },
      { detected_name: 'Unknown gizmo', quantity: 1, retail_price: 20, sold_time: '', sold_date: '', confidence_score: .5 },
    ] }) }),
    Image: class { set src(v) { setTimeout(() => { this.naturalWidth = 100; this.naturalHeight = 100; this.onload && this.onload(); }, 0); } },
    getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,AAAA',
  });
  w.eval('openRecordPastSaleModal()');
  const file = new w.File(['x'], 'sales.jpg', { type: 'image/jpeg' });
  await w.psPhoto({ files: [file], value: '' });
  const ls = w.psTestState().lines;
  assert.equal(ls.length, 3);
  assert.equal(ls[0].code, 'S2'); assert.equal(ls[0].time, '09:05');
  assert.equal(ls[1].code, 'BR'); assert.equal(ls[1].qty, '1.5'); assert.equal(ls[1].price, '55');
  assert.equal(ls[2].code, '', 'unknown item must be chosen by the user');
  assert.ok(d.querySelector('.ps-row.bad'));
  close();
});
