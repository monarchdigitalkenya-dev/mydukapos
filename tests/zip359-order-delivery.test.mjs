import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

// zip 359 — an order posted from Service Orders is only reported as "with the kitchen / bar" once the server accepted it. When a send fails
// nothing is shown to the waiter: the sync keeps sending it, with a light, spaced nudge (no flood of server / KV writes), and the kitchen gets it
// as soon as the server takes it.
const INV = [
  { code: 'BRG', type: 'service', name: 'Beef Burger', category: 'Mains', price: 650, unit: 'pcs', vatCategory: 'A' },
  { code: 'TSK', type: 'item', name: 'Tusker Lager', category: 'Beer', price: 300, wholesalePrice: 180, qty: 48, unit: 'pcs', vatCategory: 'A' },
];
const STAFF = [{ id: 'w1', name: 'Wanjiru', roles: ['service-tab', 'tabs-tab', 'hosp-role:waiter'] }, { id: 'k1', name: 'Chef Kip', roles: ['kds-kitchen-tab', 'hosp-role:kitchen'] }];
const QUIET = "showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; window.alert = () => {}; window.print = () => {}; queuePrintJob = function () { return Promise.resolve(); }; kdsBeep = function () {}; Element.prototype.scrollIntoView = function () {};";

async function two() {
  const s = makeServer({ d1: true });
  const W = await openDevice('hotel/index.html', s, { pos_inventory: JSON.stringify(INV), pos_tables: JSON.stringify(['Table 05']), pos_staff: JSON.stringify(STAFF) }, 2500);
  const K = await openDevice('hotel/index.html', s, deviceStorage(W.w), 2500);
  for (const x of [W, K]) x.w.eval(QUIET);
  W.w.eval("currentServer = staff.find(s => s.id === 'w1')"); K.w.eval("currentServer = staff.find(s => s.id === 'k1')");
  K.w.eval(`document.querySelector('.tab-link[data-tab="kds-kitchen-tab"]').click()`);
  return { s, W, K };
}
function post(W) {
  W.w.eval(`document.querySelector('.tab-link[data-tab="service-tab"]').click()`);
  for (const n of ['Beef Burger', 'Tusker Lager']) [...W.d.querySelectorAll('#svc-menu .svc-menu-btn')].find((e) => e.textContent.includes(n)).click();
  W.d.getElementById('svc-new-location').value = 'Table 05';
  W.d.getElementById('svc-post-btn').click();
}
const kitchen = (K) => JSON.parse(K.w.eval(`JSON.stringify((function(){ const c = kdsBoardModel('kitchen').cols; return [].concat(c.new, c.prep, c.ready).flatMap(x => x.lines.map(l => l.name)); })())`));
const toasts = (W) => JSON.parse(W.w.eval('JSON.stringify(window.__toasts || [])'));

test('Service Orders: "sent" first, "✅ Kitchen / bar have it" only after the server accepted; the kitchen board shows it', { timeout: 120000 }, async () => {
  const { W, K } = await two();
  post(W);
  assert.match(toasts(W).join(' | '), /sent — waiting for the kitchen \/ bar/);
  assert.doesNotMatch(toasts(W).join(' | '), /✅ Kitchen/, 'not claimed before the server answered');
  for (let i = 0; i < 30 && !toasts(W).some((t) => /✅ Kitchen \/ bar have Table 05/.test(t)); i++) await sleep(500);
  assert.ok(toasts(W).some((t) => /✅ Kitchen \/ bar have Table 05's order/.test(t)), JSON.stringify(toasts(W)));
  for (let i = 0; i < 30 && !kitchen(K).length; i++) await sleep(1000);
  assert.deepEqual(kitchen(K), ['Beef Burger']);
  W.close(); K.close();
});

test('the server refuses for a while: no message to the waiter, few sends (no flood), and the kitchen gets the order once the server takes it', { timeout: 180000 }, async () => {
  const { s, W, K } = await two();
  s.state.status = 503;                                                       // the server refuses every send
  const before = s.state.log.filter((l) => l.startsWith('POST')).length;
  post(W);
  await sleep(30000);
  const sends = s.state.log.filter((l) => l.startsWith('POST')).length - before;
  assert.ok(sends >= 1, 'it kept trying');
  assert.ok(sends <= 12, `no flood of sends while failing (${sends} in 30 s)`);
  assert.ok(!toasts(W).some((t) => /^ERR|NOT reached|failed|error/i.test(t)), 'no failure message: ' + JSON.stringify(toasts(W)));
  assert.ok(!W.d.getElementById('hosp-undelivered'), 'no red bar');
  assert.equal(kitchen(K).length, 0, 'the kitchen cannot have it yet');
  s.state.status = 0;                                                         // the server is back
  for (let i = 0; i < 90 && !kitchen(K).length; i++) await sleep(1000);
  assert.deepEqual(kitchen(K), ['Beef Burger'], 'delivered without anyone doing anything');
  for (let i = 0; i < 20 && !toasts(W).some((t) => /✅ Kitchen/.test(t)); i++) await sleep(500);
  assert.ok(toasts(W).some((t) => /✅ Kitchen \/ bar have Table 05's order/.test(t)));
  W.close(); K.close();
});
