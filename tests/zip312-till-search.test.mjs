import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 312: the Sales Counter search. With many similar names ("Normal grey ... socks", out of stock) the old list stopped at the first 20 in
// stock-list order, so "socks" never showed the H&F socks. Now: every word counts, in stock first, best matches first, up to 60, and a note when
// there are more.
const sizes = ['S', 'M', 'L', 'XL'];
function stock() {
  const inv = [];
  for (const c of ['green', 'maroon', 'navy', 'red', 'blue', 'black', 'brown', 'pink']) for (const z of sizes) inv.push({ code: `NORMALGREY${c}-${z}`, name: `Normal grey ${c} white socks (${z})`, qty: 0, price: 150, unit: 'pcs', type: 'item' });
  for (const z of sizes) inv.push({ code: `GREYBLACKH3F-${z}`, name: `Grey Black H&F socks (${z})`, qty: z === 'L' ? 5 : 0, price: 200, unit: 'pcs', type: 'item' });
  for (const z of sizes) inv.push({ code: `BLACKPLAIN-${z}`, name: `Black Plain H&F socks — ${z}`, qty: 9, price: 200, unit: 'pcs', type: 'item' });
  return inv;
}
for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'hospital/index.html', 'services/index.html', 'production/index.html']) {
  test(`${app}: "socks" lists the H&F socks too; words in any order; in stock first; a note when there are more`, async () => {
    const { w, d, close } = await boot(app, { wait: 600 });
    try {
      w.eval('inventory = ' + JSON.stringify(stock()) + ';');
      w.eval("liveSearch('socks')");
      const rows = () => [...d.querySelectorAll('#search-results .search-item')].map((x) => x.textContent.replace(/\s+/g, ' ').trim());
      let r = rows();
      assert.ok(r.some((t) => /Grey Black H&F socks \(L\)/.test(t)), 'H&F socks found by "socks": ' + r.slice(0, 5).join(' | '));
      assert.ok(r.filter((t) => /H&F/.test(t)).length >= 8, 'all the H&F socks are listed');
      assert.match(r[0], /H&F/, 'items in stock come first');
      w.eval("liveSearch('socks h&f')"); r = rows();
      assert.ok(r.length >= 8 && r.every((t) => /H&F|Showing/.test(t)), 'words in any order: ' + r.join(' | '));
      w.eval("liveSearch('h&f')"); assert.ok(rows().some((t) => /Grey Black H&F socks \(S\)/.test(t)));
      // more than 60 matches: the note says so
      w.eval("inventory = inventory.concat(Array.from({ length: 40 }, (_, i) => ({ code: 'X' + i, name: 'Extra socks ' + i, qty: 1, price: 1, unit: 'pcs', type: 'item' })));");
      w.eval("liveSearch('socks')"); r = rows();
      assert.ok(r.some((t) => /Showing 60 of 80 items/.test(t)), r[r.length - 1]);
    } finally { close(); }
  });
}
