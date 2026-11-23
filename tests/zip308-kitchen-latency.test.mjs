import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeLiveServer, openLiveDevice } from './live-sync-harness.mjs';
import { deviceStorage, sleep } from './e2e-harness.mjs';
import { hasSqlite } from './do-fake.mjs';
import { ROOT } from './helpers.mjs';

// zip 308: "an order is posted but takes time to show on the kitchen device". Measured with the REAL Hotel app on two devices (A = waiter,
// B = kitchen screen), the real server, shop database and live-sync room. Before: ~1.5-2.5 s normally, but ~28 s whenever the instant push was
// missed (the kitchen waited for its 30-second check). Now: the order is sent the moment it is posted, the board redraws the moment the data
// lands, and a kitchen / bar screen checks the live connection every 6 s (a cheap message), so a missed push costs seconds.
const INV = [{ code: 'F1', type: 'item', name: 'Pilau', price: 350, wholesalePrice: 100, qty: 50, unit: 'pcs', vatCategory: 'A', category: 'Food' }];
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}");

async function waiterAndKitchen(t) {
  const s = await makeLiveServer();
  const a = await openLiveDevice('hotel/index.html', s, { pos_inventory: JSON.stringify(INV) }, 1200); quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()'); await sleep(1500);
  const st = deviceStorage(a.w); delete st.pos_device_id; delete st.pos_till_no; delete st.pos_till_ref_seq;
  const b = await openLiveDevice('hotel/index.html', s, st, 1200); quiet(b.w);
  await b.w.eval('pushNow()'); await b.w.eval('pullState()'); await sleep(3000);
  t.after(() => { try { a.close(); } catch (e) {} try { b.close(); } catch (e) {} });
  for (const d of [a, b]) d.w.eval('window.__wsOpenedAt = Date.now() - 20000; window.__wsPongSeen = true; window.__wsLastRxAt = Date.now()');
  b.w.eval("kdsOpenFull('kitchen')");
  const post = (loc) => {
    a.w.eval(`tables = ['${loc}']; currentServer = { id: 's2', name: 'Mary' }`);
    a.w.eval(`svcDraft = { tabId: null, lines: [{ code: 'F1', qty: 1 }] }; document.getElementById('svc-new-location').innerHTML = '<option value="${loc}">${loc}</option>'; document.getElementById('svc-new-location').value = '${loc}';`);
    return a.w.eval('svcPostOrder()');
  };
  const onScreen = async (loc, ms) => {
    const T = Date.now();
    while (Date.now() - T < ms) {
      await sleep(50);
      b.w.eval('window.__wsLastRxAt = Date.now(); window.__wsPongSeen = true');      // the connection keeps answering pings
      if (b.w.eval("document.getElementById('kds-full').textContent.toUpperCase()").includes(loc.toUpperCase())) return Date.now() - T;
    }
    return Infinity;
  };
  return { s, a, b, post, onScreen };
}

test('a posted order is on the kitchen screen within a few seconds, and within ~10 s even when the instant push is missed', { skip: !hasSqlite, timeout: 120000 }, async (t) => {
  const { s, b, post, onScreen } = await waiterAndKitchen(t);
  assert.equal(b.w.eval('window.__liveAskMs'), 6000, 'a device showing the kitchen board checks every 6 s');
  for (const loc of ['Table 1', 'Table 2']) {
    assert.ok(post(loc), 'posted');
    const ms = await onScreen(loc, 10000);
    assert.ok(ms < 4000, `${loc} on the kitchen screen after ${ms} ms`);
    await sleep(3500);
  }
  await sleep(10000);                                     // let the "look again" checks after the last order finish
  s.room.flags.mute = true;                               // the instant push never reaches the kitchen
  assert.ok(post('Table 9'));
  const ms = await onScreen('Table 9', 20000);
  assert.ok(ms < 11000, `missed instant push: on the kitchen screen after ${ms} ms (was ~28 s)`);
});

test('the order is sent at once, and the board redraws as soon as new data is applied', { skip: !hasSqlite, timeout: 120000 }, async (t) => {
  const { a, post } = await waiterAndKitchen(t);
  a.w.eval("window.__pushCalls = 0; const __p = pushNow; pushNow = function () { window.__pushCalls++; return __p.apply(this, arguments); }");
  post('Table 4');
  await sleep(120);
  assert.ok(a.w.eval('window.__pushCalls') >= 1, 'pushNow ran within 120 ms (the normal save waits 300 ms)');
  const h = fs.readFileSync(path.join(ROOT, 'hotel/index.html'), 'utf8');
  assert.match(h, /renderSupplierDropdowns\(\);\n\s+try \{ if \(typeof kdsTick === 'function'\) kdsTick\(\); \}/, 'applyRemotePayload ends with a board redraw');
  assert.match(h, /window\.__liveAskMs = fullOn \|\| tabOn \? 6000 : 0/);
  const shared = fs.readFileSync(path.join(ROOT, 'src/shared/functions.js'), 'utf8');
  assert.match(shared, /window\.__pokeRetries = 3;/);
});

test('a screen that is not a kitchen / bar board keeps the 30-second check (no extra cost)', { skip: !hasSqlite, timeout: 120000 }, async (t) => {
  const { a } = await waiterAndKitchen(t);
  a.w.eval('kdsTick()');
  assert.equal(a.w.eval('window.__liveAskMs'), 0);
});
