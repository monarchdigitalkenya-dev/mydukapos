import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const apps = ['index.html', 'pharmacy/index.html', 'hospital/index.html', 'hotel/index.html', 'production/index.html', 'services/index.html'];
for (const a of apps) {
  const t = fs.readFileSync(new URL('../' + a, import.meta.url), 'utf8');
  test(`${a}: manual column mapping can point at the selling price`, () => {
    assert.ok(t.includes('id="col-map-price"'));
    assert.ok(t.includes('price: priceEl ? parseInt(priceEl.value, 10) : -1'));
    assert.ok(t.includes('price: mapping.price === undefined ? -1 : mapping.price'));
  });
  test(`${a}: commit warns once about new items without a Retail price`, () => {
    assert.ok(t.includes("target === 'inventory-direct' && !captureReviewState.priceWarned"));
    assert.ok(t.includes('would be saved with price 0'));
  });
}
