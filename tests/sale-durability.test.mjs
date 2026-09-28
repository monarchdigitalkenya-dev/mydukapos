import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { boot } from './helpers.mjs';
import { deviceStorage, sleep } from './e2e-harness.mjs';

// Zip 147 — "the sale completed and the receipt printed, but it is not in Daily Sales". A printed receipt must correspond to a sale
// that is STORED (on this device, in its journal, or on the server). Reproduced before the fix:
//   A. a tab that another tab had taken over (the "only one tab" guard) could still complete a sale — e.g. the M-Pesa confirmation that
//      arrived after the switch finishes the sale by itself. The guard silently drops that tab's saves and the journal skips it, yet the
//      receipt printed and said "✓ Sale saved" (the durability check answered "saved" for a sale it had never seen).
//   B. storage full AND no IndexedDB (blocked / private mode / broken): the sale was only in memory. Now the receipt still prints at
//      once (a queue never waits), and the sale is saved / sent again automatically until it is stored.
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 50, unit: 'pcs', vatCategory: 'A' }];
const BASE = { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' };
const PRINTER = "showToast = function (m) { (window.__toasts = window.__toasts || []).push(String(m)); }; window.confirm = () => true; printerMode = 'system'; autoPrintEnabled = true; window.__relayWaitMs = 50; window.print = () => { window.__prints = (window.__prints || 0) + 1; window.dispatchEvent(new window.Event('afterprint')); }; document.getElementById('login-screen').style.display = 'none'";
const FILL = `(function(){ var s=''; for (var i=0;i<11000;i++) s+=String.fromCharCode(0x4e00+Math.floor(Math.random()*20000));
  var n=0; [10000,1000,100,10,1].forEach(function(sz){ try { for(;;){ localStorage.setItem('pos_photo_'+n, s.slice(0,sz)); n++; } } catch(e) {} }); return n; })()`;

async function till(storage, extra = {}) {
  const t = await boot('index.html', { storage, wait: 900, ...extra });
  t.w.eval(PRINTER);
  t.sell = async () => {
    t.w.eval("addToCart('A'); currentPaymentMethod = 'cash'");
    t.d.getElementById('cash-tendered-input').value = '1000';
    await t.w.eval('checkoutCart()');
    await sleep(300);
  };
  t.ids = () => JSON.parse(t.w.eval('JSON.stringify(salesLog.map(s => s.id))'));
  t.prints = () => t.w.eval('window.__prints || 0');
  return t;
}

test('A: a tab another tab has taken over cannot complete a sale that is then lost (no receipt for an unsaved sale)', async () => {
  const idb = new IDBFactory();
  const t = await till(BASE, { indexedDB: idb });
  await t.w.eval('salesJournalReady');
  t.w.eval('window.__oneTabFreeze()');                     // another tab / window of the app was opened: this one is stopped
  await t.sell();                                           // ...and a sale is completed here anyway (e.g. an M-Pesa confirmation)
  const printed = t.prints();
  const st = deviceStorage(t.w); t.close();
  const t2 = await till(st, { indexedDB: idb });
  await t2.w.eval('salesJournalReady'); await sleep(200);
  const kept = t2.ids().length;
  t2.close();
  assert.ok(printed === 0 || kept === 1, `a receipt was printed (${printed}) for a sale that is gone after reopening (${kept} sales)`);
  assert.equal(printed, 0, 'the stopped tab does not complete (or print) the sale');
});

test('B: storage full and no journal: the receipt prints AT ONCE (never held back), the sale stays listed, and it is saved AUTOMATICALLY once there is room', async () => {
  const t = await till(BASE);                               // no IndexedDB at all
  await sleep(200);
  t.w.eval('window.__unsavedRetryMs = [200]');
  t.w.eval(FILL);
  await t.sell();
  assert.equal(t.w.eval("localStorage.getItem('pos_sales_log')"), null, 'the device could not save the sale list (this is the failure)');
  assert.equal(t.prints(), 1, 'the receipt printed at once — a queue never waits on storage');
  const id = t.ids()[0];
  assert.ok(id, 'the sale is in the sales list (and so in Daily Sales)');
  assert.match(t.d.getElementById('unsaved-sales-bar').textContent, /1 sale not stored yet[\s\S]*automatically/);
  assert.equal(t.d.getElementById('sale-not-saved-notice'), null, 'no blocking dialog');
  // room is made (old photos cleared) — nobody presses anything: the retry stores it
  t.w.eval("Object.keys(localStorage).filter(k => k.startsWith('pos_photo_')).forEach(k => localStorage.removeItem(k))");
  let saved = false;
  for (let i = 0; i < 100 && !saved; i++) { await sleep(100); saved = (t.w.eval("localStorage.getItem('pos_sales_log')") || '').includes(id); }
  assert.ok(saved, 'saved by itself');
  assert.equal(t.d.getElementById('unsaved-sales-bar'), null, 'and the bar is gone');
  t.close();
});

test('C: the normal case is unchanged — a stored sale prints once and is in Daily Sales after reopening', async () => {
  const idb = new IDBFactory();
  const t = await till(BASE, { indexedDB: idb });
  await t.w.eval('salesJournalReady');
  await t.sell();
  assert.equal(t.prints(), 1);
  const id = t.ids()[0];
  const st = deviceStorage(t.w); t.close();
  const t2 = await till(st, { indexedDB: idb });
  assert.deepEqual(t2.ids(), [id]);
  t2.close();
});

test('D: storage full and no journal, but the server answers: the receipt prints and the sale is stored on the server by itself', async () => {
  const { makeServer, openDevice } = await import('./e2e-harness.mjs');
  const s = makeServer();
  const t = await openDevice('index.html', s, BASE, 900);
  t.w.eval(PRINTER);
  await t.w.eval('pushNow()');
  t.w.eval(FILL);
  t.w.eval("addToCart('A'); currentPaymentMethod = 'cash'");
  t.d.getElementById('cash-tendered-input').value = '1000';
  await t.w.eval('checkoutCart()');
  const id = t.w.eval('salesLog[salesLog.length - 1].id');
  const ok = await (async () => { for (let i = 0; i < 200; i++) { if (t.w.eval('window.__prints || 0') > 0) return true; await sleep(100); } return false; })();
  assert.ok((s.serverState().salesLog || []).some((x) => x.id === id), 'the server holds the sale');
  assert.ok(ok, 'and the receipt printed once it was stored');
  t.close();
});
