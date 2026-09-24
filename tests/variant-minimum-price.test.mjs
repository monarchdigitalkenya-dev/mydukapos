import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// #6: a per-variant Minimum Price field (previously missing entirely), and
// a live-updating "total quantity across all variants" readout while
// filling in the Add Item form.
const APPS = ['index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html'];

for (const app of APPS) {
  test(`${app}: a variant's own Minimum Price is saved, an unset one inherits the shared default, and the live total quantity updates as rows are filled in`, async () => {
    const { w, d, errors, close } = await boot(app, { wait: 900 });
    w.eval("showToast = function () {};");

    d.getElementById('inv-name').value = 'Liverpool Jersey';
    d.getElementById('inv-price').value = '3000';
    d.getElementById('inv-min-price').value = '2500'; // shared default minimum for every variant
    d.getElementById('inv-has-variants').checked = true;
    w.eval('toggleVariantsBuilder()');

    // First variant row already exists (toggleVariantsBuilder seeds one).
    w.eval(`
      variantsDraft[0].name = 'XL';
      variantsDraft[0].qty = '5';
      variantsDraft[0].minimumPrice = '2800'; // this variant sets its own, higher minimum
    `);
    w.eval('addVariantRow()');
    w.eval(`
      variantsDraft[1].name = 'L';
      variantsDraft[1].qty = '8';
      // minimumPrice left blank on purpose — should inherit the shared 2500 above
    `);
    w.eval('renderVariantRows()');

    const totalText = d.getElementById('variant-total-qty-display').textContent;
    assert.match(totalText, /13/, 'the live total (5 + 8) is shown without saving');

    w.eval('saveInventoryItem()');
    const item = JSON.parse(w.eval("JSON.stringify(inventory.find(p => p.name === 'Liverpool Jersey'))"));
    assert.ok(item, 'the item was saved');
    assert.equal(item.qty, 13, 'the parent qty is the sum of its variants');
    const xl = item.variants.find((v) => v.name === 'XL');
    const l = item.variants.find((v) => v.name === 'L');
    assert.equal(xl.minimumPrice, 2800, "a variant's own minimum price is saved as typed");
    assert.equal(l.minimumPrice, 2500, 'a variant left blank inherits the shared default minimum');
    assert.deepEqual(errors, []);
    close();
  });
}
