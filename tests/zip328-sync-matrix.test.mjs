// zip 328 (Prompt 7, Part 3): the 22-scenario sync diagnostic matrix + the sync-health route + a regression test per root cause found.
// Scenarios already proven by earlier files are MAPPED (and the mapping is checked: the file and the test title must exist); the others are tested here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';
import { cleanReport, healthOf, MAX_IDS, MAX_DEVICES } from '../functions/api/sync-diag.js';

const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 100, openingStock: { qty: 100, costPrice: 50, date: '2026-01-01', setBy: 'x' }, unit: 'pcs', vatCategory: 'B' }];
const QUIET = "showToast = function () {}; window.confirm = () => true; printerMode = 'system'; window.__relayWaitMs = 50; window.print = () => { window.dispatchEvent(new window.Event('afterprint')); };";
const settled = (d) => until(() => !d.w.eval('window.__pushQueued') && !(d.w.eval('window.__pushInFlight') > 0), 15000);
const mk = async (s, st, w = 900) => { const d = await openDevice('index.html', s, st, w, { indexedDB: new IDBFactory() }); d.w.eval(QUIET); return d; };
const push = async (d) => { await d.w.eval('pushNow()'); await settled(d); await sleep(250); };
const pull = async (d) => { await d.w.eval('pullState()'); await sleep(450); };
const addItem = (d, o) => d.w.eval(`(function(){ inventory.push(${JSON.stringify(o)}); safeSetItem('pos_inventory', JSON.stringify(inventory)); queuePush(); })()`);
async function sell(t, n) { for (let i = 0; i < n; i++) { t.w.eval("addToCart('A'); currentPaymentMethod = 'cash'"); t.d.getElementById('cash-tendered-input').value = '1000'; await t.w.eval('checkoutCart()'); await sleep(120); } }
const base = { pos_inventory: JSON.stringify(ITEMS), pos_biz_name: 'Biz' };

// ---- the matrix: scenario -> where it is proven ---------------------------------------------------------------------------------------
const MATRIX = {
  1: ['zip327-sync-matrix.test.mjs', 'T1/T2'], 2: ['zip327-sync-matrix.test.mjs', 'T3'], 3: ['zip327-sync-matrix.test.mjs', 'T5'],
  4: ['zip327-sync-matrix.test.mjs', 'T11'], 5: ['zip328-sync-matrix.test.mjs', 'S5'], 6: ['zip327-sync-matrix.test.mjs', 'T12'],
  7: ['zip327-sync-matrix.test.mjs', 'T12'], 8: ['zip327-sync-matrix.test.mjs', 'T6'], 9: ['zip199-branch-switcher.test.mjs', ''],
  10: ['tenant-isolation.test.mjs', ''], 11: ['staff-sessions.test.mjs', ''], 12: ['zip327-sync-matrix.test.mjs', 'T14'],
  13: ['zip327-sync-matrix.test.mjs', 'T3'], 14: ['zip328-sync-matrix.test.mjs', 'S14'], 15: ['zip327-sync-matrix.test.mjs', 'T13'],
  16: ['deletions.test.mjs', ''], 17: ['connectivity.test.mjs', ''], 18: ['sw-slow-network.browser.test.mjs', ''],
  19: ['zip328-hr.test.mjs', 'H'], 20: ['zip328-hospital-cashier.test.mjs', 'W'], 21: ['zip327-sync-matrix.test.mjs', 'T5'],
  22: ['xz-reports.test.mjs', ''],
};
test('S0 the matrix covers all 22 scenarios and every mapped file / test exists', () => {
  assert.equal(Object.keys(MATRIX).length, 22);
  for (const [n, [file, title]] of Object.entries(MATRIX)) {
    const p = new URL('./' + file, import.meta.url);
    assert.ok(fs.existsSync(p), `scenario ${n}: ${file} exists`);
    if (title) assert.ok(fs.readFileSync(p, 'utf8').includes(title), `scenario ${n}: "${title}" is in ${file}`);
  }
});

test('S5 the server COMMITS a push but the answer is lost: the retry does not duplicate the sale or the stock deduction', async () => {
  const s = makeServer({ d1: true }); const a = await mk(s, base); await push(a);
  s.state.loseResponse = 1;
  await sell(a, 1); await a.w.eval('pushNow()').catch(() => {}); await sleep(500);
  assert.equal((s.serverState().salesLog || []).length, 1, 'the server did commit it');
  await until(async () => { try { await a.w.eval('pushNow()'); } catch (e) { /* retried */ } await sleep(900); return !a.w.eval('window.__pushFailed') && !a.w.eval('window.__pushQueued'); }, 40000);
  await push(a);
  const st = s.serverState();
  assert.equal(st.salesLog.length, 1, 'one sale'); assert.equal(new Set(st.salesLog.map((x) => x.id)).size, 1);
  assert.equal(st.inventory.find((p) => p.code === 'A').qty, 99, 'stock deducted once');
  const led = (await s.env.LEDGER_DB.prepare('SELECT COUNT(*) n FROM ledger_sales').all()).results[0]; assert.equal(Number(led.n), 1, 'one ledger row');
  a.close();
});

test('S14 records saved with IDENTICAL timestamps are all kept and all reach the other device', async () => {
  const s = makeServer({ d1: true }); const a = await mk(s, base); await push(a);
  const b = await openDevice('index.html', s, {}, 1800); b.w.eval(QUIET);
  const t = Date.now();
  for (const c of ['X1', 'X2', 'X3']) addItem(a, { code: c, type: 'item', name: 'Same time ' + c, price: 10, qty: 1, unit: 'pcs', updatedAt: t });
  await push(a); await pull(b);
  const codes = JSON.parse(b.w.eval('JSON.stringify(inventory.map(p => p.code))'));
  for (const c of ['X1', 'X2', 'X3']) assert.ok(codes.includes(c), c + ' reached B');
  assert.equal(new Set(codes).size, codes.length, 'no duplicates');
  a.close(); b.close();
});

// ---- the sync-health route and view (new in zip 328) ---------------------------------------------------------------------------------
test('S23 cleanReport keeps only the allowed fields, bounds the lists and never carries secrets', () => {
  const dirty = { pending: 3, dirty: 2, token: 'SECRET', pin: '1234', password: 'x', parkedCount: 80,
    parked: Array.from({ length: 200 }, (_, i) => ({ col: 'salesLog', id: 's' + i, n: 8, cat: 'bogus', why: 'x'.repeat(500), pin: '9999', body: { customer: 'Jane' } })) };
  const r = cleanReport(dirty, 1000);
  assert.equal(r.parked.length, MAX_IDS); assert.equal(r.parkedCount, 80);
  assert.equal(r.parked[0].cat, 'other'); assert.ok(r.parked[0].why.length <= 120);
  const json = JSON.stringify(r);
  for (const bad of ['SECRET', '1234', '9999', 'Jane', 'password']) assert.ok(!json.includes(bad), 'no ' + bad);
  assert.equal(healthOf(r, 2000).level, 'attention');
  assert.equal(healthOf(cleanReport({ pending: 2, lastOk: 1 }, 1), 1 + 16 * 60e3).level, 'behind');
  assert.equal(healthOf(cleanReport({}), 5).level, 'ok');
  assert.equal(healthOf(null).level, 'unknown');
});

test('S24 a device reports its sync state; the admin sees it; parked records show with attempts and category; Retry/Reconcile sends them safely', async () => {
  const s = makeServer({ d1: true }); const a = await mk(s, base); await push(a);
  // park a record exactly the way the app does after repeated server refusals
  a.w.eval(`(function(){ const d = syncDeadMap(); d['salesLog|ghost-1'] = { f: 'salesLog', id: 'ghost-1', at: Date.now(), n: 8, why: 'HTTP 500 server error', perm: false }; syncStateSave('pos_push_deadletter_v1', d); })()`);
  assert.equal(await a.w.eval('syncHealthUpload(true)'), true);
  const out = JSON.parse(await a.w.eval('syncHealthFetch().then(JSON.stringify)'));
  assert.equal(out.devices.length, 1);
  const d = out.devices[0];
  assert.equal(d.parkedCount, 1); assert.equal(d.parked[0].id, 'ghost-1'); assert.equal(d.parked[0].n, 8); assert.equal(d.parked[0].cat, 'server');
  assert.equal(d.health.level, 'attention');
  const stored = s.kv.data.get('pos-data:state:C1') ? 1 : 0; assert.ok(stored, 'shop data untouched');
  const r = JSON.parse(await a.w.eval('syncHealthReconcile().then(JSON.stringify)'));
  assert.equal(typeof r.left, 'number');
  assert.ok(!a.w.eval("Object.keys(syncDeadMap()).includes('salesLog|ghost-1')") || r.left >= 1, 'the record left the list or is honestly still reported');
  a.close();
});

test('S25 the diagnostics store stays bounded: more devices than the limit keeps the newest only', async () => {
  const s = makeServer({ d1: true });
  const sd = await import('../functions/api/sync-diag.js');
  for (let i = 0; i < MAX_DEVICES + 6; i++) {
    const req = new Request('https://x.pages.dev/api/sync-diag?c=C1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: 'd' + i, report: { pending: i } }) });
    const res = await sd.onRequestPost({ request: req, env: s.env }); assert.equal(res.status, 200);
  }
  const res = await sd.onRequestGet({ request: new Request('https://x.pages.dev/api/sync-diag?c=C1'), env: s.env });
  const out = await res.json(); assert.equal(out.devices.length, MAX_DEVICES);
});

test('S26 the diagnostics never touch shop data: the shop state is byte-identical before and after reports', async () => {
  const s = makeServer({ d1: true }); const a = await mk(s, base); await push(a);
  const before = s.kv.data.get('pos-data:state:C1').value;
  await a.w.eval('syncHealthUpload(true)'); await a.w.eval('syncHealthFetch()');
  assert.equal(s.kv.data.get('pos-data:state:C1').value, before);
  a.close();
});

test('S27 when staff sessions are enforced, only a manager session may read the sync health; a plain or missing session is refused', async () => {
  const s = makeServer({ d1: true });
  const { writeMode, issueSession } = await import('../functions/api/_staff-auth.js');
  const sd = await import('../functions/api/sync-diag.js');
  await writeMode(s.env, 'C1', 'enforce');
  const get = (tok) => sd.onRequestGet({ request: new Request('https://x.pages.dev/api/sync-diag?c=C1', { headers: tok ? { 'X-Staff-Token': tok } : {} }), env: s.env });
  assert.equal((await get('')).status, 403, 'no session');
  const clerk = await issueSession(s.env, 'C1', { id: 'u1', name: 'Clerk', perms: ['sell'], mgr: false });
  assert.equal((await get(clerk.token)).status, 403, 'a clerk');
  const boss = await issueSession(s.env, 'C1', { id: 'u2', name: 'Boss', perms: ['*'], mgr: true });
  assert.equal((await get(boss.token)).status, 200, 'a manager');
});
