import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 332: the hospital Sales Counter picture grid shows services (consultation, lab) as well as drugs.
test('G1 hospital grid has a tile for a service item and for a drug', async () => {
  const inv = [
    { code: 'S1', type: 'service', name: 'General Consultation', category: 'Services', price: 500, qty: 0, unit: 'pcs' },
    { code: 'D1', type: 'item', name: 'Paracetamol 500mg', category: 'Drugs', price: 20, qty: 100, unit: 'pcs' },
  ];
  const { w, d, close } = await boot('hospital/index.html', { storage: { pos_inventory: JSON.stringify(inv) }, wait: 900 });
  try {
    w.eval("showItemImageGrid = true; renderItemImageGrid('')");
    const txt = d.getElementById('item-image-grid').textContent;
    assert.match(txt, /General Consultation/); assert.match(txt, /Paracetamol/);
  } finally { close(); }
});
