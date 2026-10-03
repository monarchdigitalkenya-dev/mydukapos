import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage } from './e2e-harness.mjs';
import { until } from './helpers.mjs';

// PHASE 5 (zip 119): several tills at once. Receipt references must be unique across every till — online, offline, after a
// refresh — and new references never repeat one issued before the change.
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 500, unit: 'pcs', vatCategory: 'A' }];
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}");
const settled = (dev) => until(() => !dev.w.eval('window.__pushQueued') && !(dev.w.eval('window.__pushInFlight') > 0), 8000);
const checkout = async (dev) => {
  dev.w.eval("addToCart('A'); currentPaymentMethod = 'cash'");
  dev.w.document.getElementById('cash-tendered-input').value = '100000';
  await dev.w.eval('checkoutCart()');
  return dev.w.eval('salesLog[salesLog.length - 1].refNumber');
};

test('five tills: every till gets its own number from the server, and no two receipts ever share a reference', async () => {
  const s = makeServer();
  const first = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS), pos_receipt_ref_seq: '41' });   // 41 receipts issued before the change
  quiet(first.w);
  await first.w.eval('pushNow()'); await first.w.eval('pullState()');
  const tills = [first];
  for (let i = 0; i < 4; i++) {
    const st = deviceStorage(first.w);
    delete st.pos_device_id; delete st.pos_till_no; delete st.pos_till_ref_seq;          // a different physical device
    const t = await openDevice('index.html', s, st, 900); quiet(t.w);
    await t.w.eval('pushNow()');
    tills.push(t);
  }
  const nums = tills.map((t) => t.w.eval('tillNumber()'));
  assert.deepEqual([...nums].sort((a, b) => a - b), [1, 2, 3, 4, 5], 'each till has its own number');
  s.state.down = true;                                                                      // all five sell while offline
  const refs = [];
  for (let round = 0; round < 3; round++) for (const t of tills) refs.push(await checkout(t));
  s.state.down = false;
  for (const t of tills) await t.w.eval('flushThenPull()');
  assert.equal(new Set(refs).size, refs.length, 'all 15 references are different: ' + refs.join(' '));
  assert.ok(refs.every((r) => /^ref-\d{8}$/.test(r)), 'still plain digits (typed or scanned in Daily Sales)');
  assert.ok(refs.every((r) => Number(r.slice(4)) > 41), 'above every reference issued before');
  const serverRefs = s.serverState().salesLog.map((x) => x.refNumber);
  assert.equal(new Set(serverRefs).size, serverRefs.length, 'no duplicate reference on the server either');
  // a refresh does not reuse a number
  const again = await openDevice('index.html', s, deviceStorage(tills[2].w), 900); quiet(again.w);
  const r2 = await checkout(again);
  assert.ok(!refs.includes(r2));
  tills.forEach((t) => t.close()); again.close();
});

test('a brand-new device that has never reached the server still issues unique references (device code form)', async () => {
  const s = makeServer();
  s.state.down = true;
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(a.w);
  const b = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(b.w);
  const ra = await checkout(a), rb = await checkout(b);
  assert.match(ra, /^ref-D[A-Z0-9]+-\d+$/);
  assert.notEqual(ra, rb);
  a.close(); b.close();
});

// Zip 127 (the owner's request): the Audit shows only what went right — successful syncs and the conflicts the server resolved.
// Failed sends and retries stay in the technical sync journal (Settings ▸ Devices & Security ▸ Sync diagnostics).
test('every sale carries its till, device, cashier and shift; movements carry device/till and send count; the Audit shows successful syncs and conflicts, never send failures', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  a.w.eval("startAdminShiftIfNeeded()");
  const shiftId = a.w.eval("(staffShifts.find(x => !x.clockOut) || {}).id");
  const ref = await checkout(a);
  await settled(a);
  const sale = s.serverState().salesLog.find((x) => x.refNumber === ref);
  assert.equal(sale.ctx.till, 1); assert.equal(sale.ctx.device, a.w.eval('getOrCreateDeviceId()'));
  assert.ok(sale.ctx.cashier); assert.equal(sale.ctx.shiftId, shiftId);
  const mv = s.serverState().stockMovementLog.find((m) => m.reason === 'Sale');
  assert.equal(mv.dev, a.w.eval('getOrCreateDeviceId()')); assert.equal(mv.till, 1); assert.equal(mv.tries, undefined, 'zip 186: a send counter is never stamped INTO a movement (retries are counted apart)');
  // a failed send, then the retry, then a conflict the server resolved for this device
  s.state.down = true;
  await checkout(a); await settled(a);
  s.state.down = false;
  a.w.eval('window.__pushBackoffUntil = 0');
  await a.w.eval('pushNow()');
  const other = await openDevice('index.html', s, deviceStorage(a.w), 900); quiet(other.w);   // shares the device id: we only need its log
  s.state.down = true;
  a.w.eval("localStorage.setItem('pos_st_approval_kes', '1000000')");                      // (a large write-off; approval is tested elsewhere)
  a.w.eval("stockTakeSet('A','qty','5'); stockTakeApplyOne('A')");                          // an older count ...
  s.state.down = false;
  const t = Date.now() + 5000;
  await s.fetch('https://x/api/pos-sync', { method: 'POST', body: JSON.stringify({ updatedAt: Date.now(), stockMovementLog: [{ id: 'later', kind: 'count', code: 'A', counted: 9, before: 0, delta: 9, unit: 'qty', timestamp: new Date(t).toISOString() }] }) });
  await a.w.eval('flushThenPull()'); await a.w.eval('pullState()');                        // ... superseded by a later one
  await settled(a); await new Promise((r) => setTimeout(r, 700)); await a.w.eval('flushThenPull()'); await settled(a);   // zip 156: a pull that lands on unsent work is applied right after it is sent
  a.w.eval("document.getElementById('audit-module-select').value = 'Sync'; renderAuditTab()");
  const audit = a.d.getElementById('audit-tab').textContent;
  assert.match(audit, /Synced to the server/); assert.match(audit, /conflict resolved by the server/);
  assert.doesNotMatch(audit, /send failed|busy|refused|no answer/i, 'no failure noise in the business Audit');
  const diag = a.w.localStorage.getItem('pos_sync_journal_v1');
  assert.match(diag, /"kind":"failed"/); assert.match(diag, /"kind":"retry"/);            // still recorded for diagnostics
  a.close(); other.close();
});

test('PHASE 10: a report says how fresh it is, refreshes itself after a sync, and a Z Report cannot be finalized with unsent sales', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  a.w.eval("reportsGenerate('xreport')");
  assert.match(a.d.getElementById('reports-output').textContent, /Up to date with the server/);
  s.state.down = true;
  await checkout(a); await settled(a);                                                  // a sale that cannot be sent
  a.w.eval("reportsGenerate('xreport')");
  assert.match(a.d.getElementById('reports-output').textContent, /has changes the server has not received yet/);
  let toasts = [];
  a.w.showToast = (m) => { toasts.push(m); };
  await a.w.eval('requestFinalizeZReport()');
  assert.match(toasts.join(' '), /Not finalized/);
  assert.notEqual(a.d.getElementById('admin-pw-modal').style.display, 'flex', 'the password step is not even offered');
  s.state.down = false;
  a.w.eval('window.__pushBackoffUntil = 0');
  await a.w.eval('requestFinalizeZReport()');
  assert.equal(a.d.getElementById('admin-pw-modal').style.display, 'flex', 'once everything is on the server it can go ahead');
  a.close();
});

test('#8: X Report is checked against the server sale by sale, with a per-till breakdown; a Z Report needs the match', async () => {
  const s = makeServer();
  const a = await openDevice('index.html', s, { pos_inventory: JSON.stringify(ITEMS) }); quiet(a.w);
  await a.w.eval('pushNow()'); await a.w.eval('pullState()');
  const st = deviceStorage(a.w); delete st.pos_device_id; delete st.pos_till_no; delete st.pos_till_ref_seq;
  const b = await openDevice('index.html', s, st, 900); quiet(b.w); await b.w.eval('pushNow()');
  await checkout(a); await checkout(b); await checkout(b);
  await settled(a); await settled(b); await a.w.eval('pullState()');
  a.w.eval("reportsGenerate('xreport')");
  await until(() => /Server check/.test(a.d.getElementById('reports-output').textContent), 8000);
  const txt = a.d.getElementById('reports-output').textContent;
  assert.match(txt, /✓ Server check: the server holds the same 3 sales/);
  assert.match(txt, /Till 1/); assert.match(txt, /Till 2/);
  // this device loses one sale it should have: the check names it, and the Z Report is refused
  a.w.eval('salesLog.splice(0, 1)');
  const bounds = a.w.eval('JSON.stringify(todayBounds())');
  const r = await a.w.eval(`(function(){ const b = JSON.parse('${bounds}'); return serverDayCheck(new Date(b.from), new Date(b.to), ''); })()`);
  assert.equal(r.ok, false); assert.equal(r.missingHere.length, 1);
  await a.w.eval('pushNow()');                                                          // (the X Report's own audit event is sent)
  a.w.eval("window.flushThenPull = async () => {}");                                   // (keep the gap for this check)
  let toasts = []; a.w.showToast = (m) => toasts.push(m);
  await a.w.eval('requestFinalizeZReport()');
  assert.match(toasts.join(' '), /Not finalized: 1 sale/);
  a.close(); b.close();
});
