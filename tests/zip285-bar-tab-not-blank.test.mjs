// zip 285: the hotel's 🍺 Bar & Kegs tab was BLANK. Since zip 153 hospInvSetCat() moved every child of #bar-tab into Inventory's #inv-bar-slot a moment after
// the page loaded; zip 283 gave Bar & Kegs its own tab again but left that move in place, so the tab's own screen was empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const T = fs.readFileSync(new URL('../hotel/index.html', import.meta.url), 'utf8');

test('nothing moves the Bar & Kegs screen out of its tab any more', () => {
  assert.ok(!T.includes('bSlot.dataset.moved'), 'the move into the Inventory slot is gone');
  assert.ok(!/while \(barTab\.firstChild\) bSlot\.appendChild/.test(T));
  assert.match(T, /<div id="bar-tab" class="tab-content">/);
  assert.match(T, /<div id="bar-body"><\/div>/);
});

test('the Inventory "Bar & Kegs" chip opens the Bar & Kegs tab instead of hosting it', () => {
  const fn = T.slice(T.indexOf('function hospInvSetCat(c)'), T.indexOf('function hospInvSearch'));
  assert.match(fn, /if \(c === 'bar'\) \{/);
  assert.match(fn, /getElementById\('bar-tab-btn'\)/);
  assert.match(fn, /bb\.click\(\)/);
});
