import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
// zip 227 — per-item low-stock threshold: Add Item field + variant rows use the item's own level.
test('T1: Add Item form saves its own low-stock level (minStock)', async () => {
  const { w, d, close } = await boot('index.html', { wait: 3000 });
  assert.ok(d.getElementById('sr-add-min'), 'field present');
  d.getElementById('inv-name').value = 'Widget';
  d.getElementById('inv-qty').value = '4';
  for (const id of ['inv-price', 'inv-cost', 'inv-wholesale']) { const e = d.getElementById(id); if (e) e.value = '10'; }
  d.getElementById('sr-add-min').value = '7';
  w.saveInventoryItem();
  const it = JSON.parse(w.eval("JSON.stringify(inventory.find(p => p.name === 'Widget') || null)"));
  assert.ok(it, 'item saved');
  assert.equal(it.minStock, 7);
  assert.equal(w.eval("stockRuleOf(inventory.find(p => p.name === 'Widget')).min"), 7);
  assert.equal(d.getElementById('sr-add-min').value, '');
  close();
});
