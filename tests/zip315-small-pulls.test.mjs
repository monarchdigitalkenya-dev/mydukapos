import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLiveServer, openLiveDevice } from './live-sync-harness.mjs';
import { deviceStorage } from './e2e-harness.mjs';
import { until } from './helpers.mjs';
import { hasSqlite } from './do-fake.mjs';

// zip 315: a phone that stayed on "Syncing" for ever and never got the other tills' sales (nor sent its own). A shop in its own database answered a
// pull after ANY change with the whole shop including 120 days of every log - megabytes per pull, every time someone sold. A phone on mobile data
// could not finish it inside the time limit, retried, and never caught up. Pulls now carry a change cursor: 3 days of logs + every log record
// written since the device's last applied pull (any date). Real Shop app on two devices, real server code, real shop database.
const DAY = 86400000;
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 500, unit: 'pcs', vatCategory: 'A' }];
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}");
const settled = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0) && !dev.w.eval('window.__pullInFlight'), 15000);
const oldSale = (i, ageDays) => ({ id: `old-${i}`, refNumber: `OLD-${i}`, timestamp: new Date(Date.now() - ageDays * DAY).toISOString(), paymentMethod: 'cash', cashAmount: 100, paid: true, servedBy: 'Admin', items: [{ code: 'A', name: 'Alpha', qty: 1, price: 100 }], updatedAt: Date.now() - ageDays * DAY });

async function shop(t) {
  const s = await makeLiveServer();
  // 400 sales from the last 100 days already in the shop's database (a busy shop)
  const history = Array.from({ length: 400 }, (_, i) => oldSale(i, 5 + (i % 95)));
  await s.env.SHOP_STORE.get('C1').fetch('https://shop-store/push', { method: 'POST', body: JSON.stringify({ body: { businessName: 'Biz', inventory: ITEMS, salesLog: history }, serverNow: Date.now(), _shop: 'C1' }) });
  // measure every pull answer
  const pulls = [];
  const base = s.fetch;
  s.fetch = async (url, opts = {}) => {
    const res = await base(url, opts);
    if (/\/api\/pos-sync/.test(String(url)) && (opts.method || 'GET').toUpperCase() === 'GET') { const text = await res.clone().text(); pulls.push({ url: String(url), bytes: text.length }); }
    return res;
  };
  const a = await openLiveDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(a.w);
  await a.w.eval('pullState()'); await settled(a);
  const st = deviceStorage(a.w); delete st.pos_device_id; delete st.pos_till_no; delete st.pos_till_ref_seq;
  const b = await openLiveDevice('index.html', s, st, 900); quiet(b.w);           // IAN's phone
  await b.w.eval('pullState()'); await settled(b);
  t.after(() => { try { a.close(); } catch (e) {} try { b.close(); } catch (e) {} });
  return { s, a, b, pulls };
}
const sell = async (dev) => { dev.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); dev.w.document.getElementById('cash-tendered-input').value = '1000'; await dev.w.eval('checkoutCart()'); await settled(dev); return dev.w.eval('salesLog[salesLog.length - 1].refNumber'); };

test('after the first pull, a pull after a change is small - and still carries the new sale', { skip: !hasSqlite }, async (t) => {
  const { a, b, pulls } = await shop(t);
  assert.ok(Number(b.w.localStorage.getItem('pos_log_cursor')) > 0, 'the first (full) pull gave the phone its cursor');
  assert.equal(b.w.eval("salesLog.filter(s => /^OLD-/.test(s.refNumber)).length"), 400, 'the first pull is the full window, as before');
  const full = Math.max(...pulls.map((x) => x.bytes));
  pulls.length = 0;
  const ref = await sell(a);
  await until(() => b.w.eval(`salesLog.some(s => s.refNumber === '${ref}')`), 10000).catch(() => {});
  await b.w.eval('pullState()'); await settled(b);
  const withData = pulls.filter((x) => x.bytes > 200);
  assert.ok(withData.length >= 1, 'a pull brought the change: ' + JSON.stringify(pulls));
  assert.ok(withData.every((x) => /after=/.test(x.url)), 'every pull after the first carries the cursor: ' + JSON.stringify(withData.map((x) => x.url)));
  console.log('PULL SIZES full=' + full + ' after-change=' + withData.map((x) => x.bytes).join(','));
  assert.ok(withData.every((x) => x.bytes < full / 3), `the pulls after a sale are small: ${withData.map((x) => x.bytes)} bytes instead of ${full}`);
  assert.ok(b.w.eval(`salesLog.some(s => s.refNumber === '${ref}')`), "the till's new sale reached the phone");
  assert.equal(b.w.eval("salesLog.filter(s => /^OLD-/.test(s.refNumber)).length"), 400, 'nothing the phone already had was lost');
  assert.equal(b.w.eval("inventory.find(p => p.code === 'A').qty"), a.w.eval("inventory.find(p => p.code === 'A').qty"), 'same stock on both');
});

test('an OLD record changed on another device still arrives (voided 40-day-old sale), and stock is never counted twice', { skip: !hasSqlite }, async (t) => {
  const { s, a, b } = await shop(t);
  const qtyBefore = b.w.eval("inventory.find(p => p.code === 'A').qty");
  // the admin voids a 40-day-old sale (outside the 3-day window)
  a.w.eval("(function () { const x = salesLog.find(s => s.id === 'old-35') || salesLog.find(s => /^old-/.test(s.id) && (Date.now() - Date.parse(s.timestamp)) > 30 * 86400000); x.voided = true; x.voidReason = 'test'; x.updatedAt = Date.now(); window.__voidedId = x.id; safeSetItem('pos_sales_log', JSON.stringify(salesLog)); queuePush(); })()");
  await a.w.eval('pushNow()'); await settled(a);
  const id = a.w.eval('window.__voidedId');
  const onServer = (await s.dbState()).salesLog.find((x) => x.id === id);
  assert.equal(onServer.voided, true, 'the server has the void');
  await b.w.eval('pullState()'); await settled(b);
  assert.equal(b.w.eval(`salesLog.find(s => s.id === '${id}').voided`), true, 'the phone got the void although the sale is 40 days old');
  // stock: a sale on the phone, pushed, then several pulls - the quantity matches the server every time
  await sell(b);
  for (let i = 0; i < 3; i++) { await b.w.eval('pullState()'); await settled(b); }
  const server = (await s.dbState()).inventory.find((p) => p.code === 'A').qty;
  assert.equal(b.w.eval("inventory.find(p => p.code === 'A').qty"), server, 'phone = server');
  assert.equal(server, qtyBefore - 1, 'exactly one unit came off');
});

test('the database answer honours the cursor safely: a short window only with a cursor; a cursor newer than the database gets the full window', { skip: !hasSqlite }, async (t) => {
  const { s } = await makeLiveServer().then(async (srv) => {
    const hist = Array.from({ length: 30 }, (_, i) => oldSale(i, 10 + i));
    await srv.env.SHOP_STORE.get('C1').fetch('https://shop-store/push', { method: 'POST', body: JSON.stringify({ body: { businessName: 'Biz', inventory: ITEMS, salesLog: hist }, serverNow: Date.now(), _shop: 'C1' }) });
    return { s: srv };
  });
  const state = async (body) => JSON.parse(await (await s.env.SHOP_STORE.get('C1').fetch('https://shop-store/state', { method: 'POST', body: JSON.stringify(body) })).text());
  const full = await state({});
  assert.equal(full.salesLog.length, 30); assert.ok(full._seq > 0);
  assert.equal((await state({ hotDays: 3 })).salesLog.length, 30, 'a short window WITHOUT a cursor is not honoured (an old app could lose edits)');
  assert.equal((await state({ hotDays: 3, logsAfter: full._seq })).salesLog.length, 0, 'nothing changed since the cursor and nothing in the last 3 days');
  assert.equal((await state({ hotDays: 3, logsAfter: full._seq + 1000 })).salesLog.length, 30, 'a cursor from another (restored) database is not trusted');
  t.after(() => {});
});

test('a send that never gets ANY answer no longer jams the phone for good: its sale still reaches the server, the other till\'s sale reaches it, and it turns green', async (t) => {
  const { makeServer, openDevice, sleep } = await import('./e2e-harness.mjs');
  const s = makeServer();
  let hang = 0;                                                     // the next N pushes from the phone never answer (no reply, no error, never)
  const phoneFetch = (url, opts = {}) => (hang > 0 && /pos-sync/.test(String(url)) && (opts.method || 'GET').toUpperCase() === 'POST' ? (hang--, new Promise(() => {})) : s.fetch(url, opts));
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }, 900); quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  const st = deviceStorage(a.w); delete st.pos_device_id; delete st.pos_till_no; delete st.pos_till_ref_seq;
  const b = await openDevice('index.html', { ...s, fetch: phoneFetch }, st, 900); quiet(b.w);
  t.after(() => { try { a.close(); } catch (e) {} try { b.close(); } catch (e) {} });
  await b.w.eval('pullState()'); await sleep(1500);                // the phone is idle: the next send IS the sale's
  b.w.eval('window.__pushHardLimitMs = 1500; window.__pushTimeoutMs = 600000');   // (the request's own 40 s limit is "ignored" here, as on the phone)
  hang = 1;
  b.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); b.w.document.getElementById('cash-tendered-input').value = '1000';
  await b.w.eval('checkoutCart()');
  const ref = b.w.eval('salesLog[salesLog.length - 1].refNumber');
  // before the fix: nothing at all for ~2.5 minutes, then the sale went but the phone said "Syncing" for ever (in-flight count stuck at 1)
  await until(() => (s.serverState().salesLog || []).some((x) => x.refNumber === ref), 20000);
  await until(() => !(b.w.eval('window.__pushInFlight') > 0), 10000);
  assert.equal(b.w.eval('window.__pushHardStops'), 1, 'the jammed send was given up once');
  // the till sells; the phone gets it on its next pull and the dot is green
  a.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); a.w.document.getElementById('cash-tendered-input').value = '1000';
  await a.w.eval('checkoutCart()'); await a.w.eval('pushNow()');
  const refA = a.w.eval('salesLog[salesLog.length - 1].refNumber');
  await sleep(500); await b.w.eval('pullState()');
  await until(() => b.w.eval(`salesLog.some(x => x.refNumber === '${refA}')`), 20000);
  await until(() => b.w.eval('window.__syncStatus') === 'synced', 20000);
});
