import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
import { deviceStorage } from './e2e-harness.mjs';

// zip 320 re-check: the hourly sample reset must never touch a NORMAL shop, in ANY app. Each app is opened as a real shop with unsent work, in the three
// situations closest to a demo, with the reset's own data PLANTED on the device (an expired hour and a baseline that would wipe the shop if it were
// used). Every browser call that could delete something is watched: localStorage / sessionStorage clear and removeItem, IndexedDB deleteDatabase.
const J = (w, e) => JSON.parse(w.eval(`JSON.stringify(${e})`));
const APPS = ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'hospital/index.html', 'water/index.html'];
const REAL = {
  pos_inventory: JSON.stringify([{ code: 'RICE', type: 'item', name: 'Pishori 2kg', price: 380, wholesalePrice: 300, qty: 17, unit: 'pcs', vatCategory: 'A' }]),
  pos_sales_log: JSON.stringify([{ id: 'REAL-UNSYNCED-1', refNumber: 'R-77', timestamp: new Date().toISOString(), paymentMethod: 'mpesa', mpesaAmount: 380, paid: true, items: [{ code: 'RICE', name: 'Pishori 2kg', qty: 1, price: 380 }] }]),
  pos_debts: JSON.stringify([{ id: 'RD-1', customerName: 'Otieno', amount: 1200, createdAt: new Date().toISOString(), payments: [] }]),
  pos_expenses: JSON.stringify([{ id: 'RX-1', timestamp: new Date().toISOString(), category: 'Rent', amount: 9000 }]),
  pos_customers: JSON.stringify([{ id: 'RC-1', name: 'Otieno', phone: '0722000000' }]),
  pos_business_name: 'Mama Mboga Stores', pos_dirty_seq: '42', pos_acked_seq: '40',
};
const WATCHED = Object.keys(REAL);
const planted = (host, id) => ({
  sd_confirmed: JSON.stringify({ host, id, at: 1 }),                                        // a stale / wrong confirmation
  sd_reset_meta: JSON.stringify({ host, deadline: 1, startedAt: 0, lastSeen: 0 }),          // the hour long over
  sd_baseline: JSON.stringify({ v: 1, host, at: 1, keys: { pos_inventory: '[]', pos_sales_log: '[]' } }),   // would wipe the shop if used
});
const SITUATIONS = [
  { name: 'its own address', url: 'https://mama-mboga.mydukapos.store/', id: 'k7m2pq9xzr', demo: false, plant: planted('mama-mboga.mydukapos.store', 'demo_retail') },
  { name: 'an address that starts with demo- (server: not a shared demo; a stale confirmation from another demo on the device)', url: 'https://demo-shop.mydukapos.store/', id: 'k7m2pq9xzr', demo: false, plant: planted('demo-shop.mydukapos.store', 'demo_retail') },
  { name: 'a shared address opened with ?c=demo_retail (server: shared demo)', url: 'https://mydukapos-3ao.pages.dev/?c=demo_retail', id: 'demo_retail', demo: true, plant: planted('mydukapos-3ao.pages.dev', 'demo_retail') },
];
const net = (id, isDemo) => async (url) => {
  if (/\/api\/license-status/.test(String(url))) return new Response(JSON.stringify({ valid: true, clientId: id, type: 'permanent', sharedDemo: isDemo }), { status: 200, headers: { 'content-type': 'application/json' } });
  throw new Error('offline');                                                               // offline for everything else: unsent work stays unsent
};
// every deleting call is recorded (and still performed, so nothing is hidden from the app)
function watch(w) {
  const log = w.__deletes = [];
  const P = w.Storage.prototype, rm = P.removeItem, clr = P.clear;
  P.removeItem = function (k) { log.push(['remove', this === w.sessionStorage ? 'session' : 'local', String(k)]); return rm.call(this, k); };
  P.clear = function () { log.push(['clear', this === w.sessionStorage ? 'session' : 'local']); return clr.call(this); };
  const idb = { deleteDatabase(n) { log.push(['idb-delete', String(n)]); return {}; }, databases() { log.push(['idb-list']); return Promise.resolve([{ name: 'pos_sales_journal' }]); }, open() { return { set onsuccess(f) {}, set onerror(f) {}, set onupgradeneeded(f) {} }; } };
  try { Object.defineProperty(w, 'indexedDB', { configurable: true, value: idb }); } catch (e) { w.indexedDB = idb; }
}
const values = (w) => J(w, `(function(){ const o = {}; ${JSON.stringify(WATCHED)}.forEach(k => o[k] = localStorage.getItem(k)); return o; })()`);
const destructive = (w) => J(w, 'window.__deletes').filter((d) => d[0] === 'clear' || d[0] === 'idb-delete' || d[0] === 'idb-list' || (d[0] === 'remove' && WATCHED.includes(d[2])));

for (const app of APPS) {
  for (const s of SITUATIONS) {
    test(`${app}, a normal shop on ${s.name}: never reset - unsent sales, stock, debts, expenses, customers and settings exactly as they were`, async (t) => {
      const opts = { url: s.url, storage: { ...REAL, ...s.plant }, fetch: net(s.id, s.demo), wait: 2500, beforeParse: watch };
      const dev = await boot(app, opts); t.after(() => { try { dev.close(); } catch (e) { /* closed */ } });
      dev.w.eval('window.__demoResetNoReload = true; window.confirm = () => true; window.alert = () => {}; try { showToast = function () {}; } catch (e) {}');
      // the things that run the reset on a demo: focus, showing the page, coming online, a tap, a key, an explicit check, time passing
      for (const ev of ['focus', 'pageshow', 'online']) dev.w.dispatchEvent(new dev.w.Event(ev));
      dev.d.dispatchEvent(new dev.w.Event('visibilitychange'));
      dev.d.body.dispatchEvent(new dev.w.MouseEvent('click', { bubbles: true }));
      dev.d.body.dispatchEvent(new dev.w.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      dev.w.eval("try { if (window.DemoReset) { DemoReset.check('test'); DemoReset.restoreNow(); } } catch (e) {}");
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(values(dev.w), REAL, 'every record unchanged');
      assert.deepEqual(destructive(dev.w), [], 'nothing was cleared or deleted');
      assert.equal(dev.d.getElementById('dr-block'), null, 'the page was never blocked');
      assert.equal(J(dev.w, "!!(window.DemoReset && window.DemoReset.eligible())"), false, 'not eligible for the reset');
      if (/demo-shop/.test(s.url)) assert.equal(J(dev.w, "localStorage.getItem('sd_confirmed')"), null, 'the server said "not a demo": the stale confirmation is dropped');
      // the next day: the same device opened again
      const st = deviceStorage(dev.w); dev.close();
      const again = await boot(app, { ...opts, storage: st }); t.after(() => { try { again.close(); } catch (e) { /* closed */ } });
      assert.deepEqual(values(again.w), REAL, 'unchanged after reopening');
      assert.deepEqual(destructive(again.w), [], 'nothing deleted on reopening either');
    });
  }
}
