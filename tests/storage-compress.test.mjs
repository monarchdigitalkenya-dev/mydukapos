import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// The device-storage layer: big localStorage values are kept compressed in slices, transparently.
const rnd = (n) => { let s = ''; while (s.length < n) s += Math.random().toString(36).slice(2); return s.slice(0, n); };
// high-entropy text (does not compress), for quota tests
const hard = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(0x4e00 + Math.floor(Math.random() * 0x4000)); return s; };
const sales = (n, from = 0) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `s-${from + i}`, timestamp: new Date(1789890316820 + (from + i) * 60000).toISOString(), paymentMethod: 'cash', cashAmount: 366.66, mpesaAmount: 0, cardAmount: 0, customerName: null, customerPhone: null, deliveryDetails: null, items: [{ code: '00001', name: 'Widget', qty: 3, price: 100, unit: 'pcs', vatCategory: 'A', variantId: null }], totalDiscount: 0 })));
const rawKeys = (w) => JSON.parse(w.eval('JSON.stringify(Object.keys(Array.from({length: localStorage.length}, (_, i) => localStorage.key(i))).map(i => localStorage.key(+i)))'));
const stored = (w, k) => w.eval(`(function(){ var t = 0; for (var i = 0; i < localStorage.length; i++) { var key = localStorage.key(i); if (key === '${k}' || key.indexOf('${k}~s') === 0) t += __lsRawGet(key).length; } return t; })()`);

test('a big value round-trips exactly and is stored ~10x smaller; small values are untouched', async () => {
  const { w, errors, close } = await boot('index.html', { wait: 300 });
  const big = sales(2000);
  w.localStorage.setItem('pos_test_big', big);
  assert.equal(w.localStorage.getItem('pos_test_big'), big, 'exact round trip');
  const st = stored(w, 'pos_test_big');
  assert.ok(st < big.length / 5, `stored ${st} of ${big.length} chars (${(big.length / st).toFixed(1)}x)`);
  w.localStorage.setItem('pos_test_small', 'hello');
  assert.equal(w.eval("__lsRawGet('pos_test_small')"), 'hello', 'small values stay as they were');
  assert.ok(w.eval("__lsRawGet('pos_test_big')").startsWith('~lz1|'));
  const uni = 'Pässwörd ✓ 🔐 ' + rnd(20000) + ' 日本語';
  w.localStorage.setItem('pos_test_uni', uni);
  assert.equal(w.localStorage.getItem('pos_test_uni'), uni, 'unicode survives slicing + compression');
  assert.deepEqual(errors, []);
  close();
});

test('appending a sale recompresses only the last slice, not the whole history', async () => {
  const { w, close } = await boot('index.html', { wait: 300 });
  const base = JSON.parse(sales(3000));                    // ~ 40 slices
  w.localStorage.setItem('pos_test_log', JSON.stringify(base));
  const s0 = w.eval('JSON.stringify(__lsStats)');
  const more = base.concat(JSON.parse(sales(1, 3000)));
  w.localStorage.setItem('pos_test_log', JSON.stringify(more));
  const s1 = JSON.parse(w.eval('JSON.stringify(__lsStats)')), before = JSON.parse(s0);
  const recompressed = s1.slicesCompressed - before.slicesCompressed;
  assert.ok(recompressed <= 2, `recompressed ${recompressed} slice(s)`);
  assert.ok(s1.slicesSkipped - before.slicesSkipped >= 15, 'the rest were skipped (' + (s1.slicesSkipped - before.slicesSkipped) + ')');
  assert.equal(JSON.parse(w.localStorage.getItem('pos_test_log')).length, 3001);
  close();
});

test('shrinking to a small value, and removeItem, clean up every slice', async () => {
  const { w, close } = await boot('index.html', { wait: 300 });
  const count = (k) => w.eval(`(function(){ var n = 0; for (var i = 0; i < localStorage.length; i++) if (localStorage.key(i).indexOf('${k}') === 0) n++; return n; })()`);
  w.localStorage.setItem('pos_test_x', sales(1500));
  assert.ok(count('pos_test_x') > 3);
  w.localStorage.setItem('pos_test_x', '[]');
  assert.equal(count('pos_test_x'), 1, 'only the small value remains');
  assert.equal(w.localStorage.getItem('pos_test_x'), '[]');
  w.localStorage.setItem('pos_test_y', sales(1500));
  w.localStorage.removeItem('pos_test_y');
  assert.equal(count('pos_test_y'), 0);
  assert.equal(w.localStorage.getItem('pos_test_y'), null);
  close();
});

test('data saved before this update (plain big values) is still read, then compressed on the next save', async () => {
  const legacy = sales(1200);
  const { w, close } = await boot('index.html', { storage: { pos_test_legacy: legacy }, wait: 300 });
  assert.equal(w.localStorage.getItem('pos_test_legacy'), legacy);
  assert.equal(w.eval("__lsRawGet('pos_test_legacy')").length, legacy.length, 'still stored plain until written again');
  w.localStorage.setItem('pos_test_legacy', legacy);
  assert.ok(w.eval("__lsRawGet('pos_test_legacy')").startsWith('~lz1|'));
  assert.equal(w.localStorage.getItem('pos_test_legacy'), legacy);
  close();
});

test('a reload sees the same data (compressed slices survive a fresh page load)', async () => {
  const a = await boot('index.html', { wait: 300 });
  const big = sales(1500);
  a.w.localStorage.setItem('pos_test_reload', big);
  const snapshot = JSON.parse(a.w.eval("JSON.stringify(Object.fromEntries(Array.from({length: localStorage.length}, (_, i) => localStorage.key(i)).map(k => [k, __lsRawGet(k)])))"));
  a.close();
  const b = await boot('index.html', { storage: snapshot, wait: 300 });
  assert.equal(b.w.localStorage.getItem('pos_test_reload'), big);
  b.close();
});

test('storage full: the ":prev" safety copies are dropped and the save still succeeds', async () => {
  const { w, close } = await boot('index.html', { wait: 300 });
  // fill the ~5M-character quota with regenerable ':prev' data
  for (let i = 0; i < 4; i++) w.localStorage.setItem(`junk:prev~s${i}`, rnd(1200000));
  const big = rnd(700000);
  w.localStorage.setItem('pos_test_full', big);                        // would not fit next to the junk
  assert.equal(w.localStorage.getItem('pos_test_full'), big);
  assert.equal(w.localStorage.getItem('junk:prev~s0'), null, 'safety copies were sacrificed');
  close();
});

test('a save that cannot fit is rolled back — the last good value is still there', async () => {
  const { w, close } = await boot('index.html', { wait: 300 });
  const good = hard(300000);
  w.localStorage.setItem('pos_test_keep', good);
  for (let i = 0; i < 3; i++) w.localStorage.setItem(`important-${i}~s0`, hard(1400000));   // not ':prev' -> can't be freed
  let threw = false;
  try { w.localStorage.setItem('pos_test_keep', hard(900000)); } catch (e) { threw = true; }
  assert.ok(threw, 'the browser refused it');
  assert.equal(w.localStorage.getItem('pos_test_keep'), good, 'previous value intact');
  close();
});

test('a damaged slice reads as missing (so the app\'s ":prev" recovery runs) instead of returning corrupt data', async () => {
  const { w, close } = await boot('index.html', { wait: 300 });
  w.localStorage.setItem('pos_test_bad', sales(1500));
  w.eval("Storage.prototype.setItem.call(localStorage, 'pos_test_bad~s1', 'garbage')");   // simulate corruption (slice key -> raw write)
  w.eval('__lsCacheDrop = 1');
  // drop the in-memory cache the way another tab's change would
  w.dispatchEvent(new w.StorageEvent('storage', { key: 'pos_test_bad~s1' }));
  assert.equal(w.localStorage.getItem('pos_test_bad'), null);
  close();
});

test('every app boots with the storage layer, and the Settings meter shows REAL (compressed) usage', async () => {
  for (const app of ['index.html', 'water/index.html', 'hotel/index.html', 'owner/index.html']) {
    const { w, errors, close } = await boot(app, { wait: 300 });
    assert.equal(typeof w.eval('window.__lsRawGet'), 'function', app);
    assert.deepEqual(errors, [], app);
    close();
  }
  const { w, close } = await boot('index.html', { wait: 300 });
  w.localStorage.setItem('pos_test_meter', sales(2500));
  const logical = w.localStorage.getItem('pos_test_meter').length;
  const total = w.eval("(function(){ var t = 0; for (var i = 0; i < localStorage.length; i++) t += localStorage.key(i).length + __lsRawGet(localStorage.key(i)).length; return t; })()");
  assert.ok(total < logical / 3, `meter would read ${total} instead of ${logical}`);
  close();
});
