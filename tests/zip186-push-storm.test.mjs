import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, until } from './helpers.mjs';
import { makeServer, openDevice, sleep } from './e2e-harness.mjs';
import { loadFunctionLibrary, regionText, REGION_RE } from '../tools/lib.mjs';

// zip 186 - INCIDENT: one stock movement was re-sent 1,391 times in ~9 minutes (no backoff, several senders), each resend wrote an audit row on the server
// and filled a 10 GB database. These tests pin the CLIENT side of the fix (src/shared/functions.js):
//   * a send counter never lives inside a record (stampLocalContext) - the record's data does not change when it is re-sent;
//   * exponential backoff with jitter, circuit breaker, single sender (leader lease), rate-limited post-push pull, tab that is not the working one never sends;
//   * retry cap -> "needs attention" list (never deleted, still sent when Retry is pressed); permanent refusals; 507 / storage_full pause; 2xx incl. duplicate = success.
const src = fs.readFileSync(new URL('../src/shared/functions.js', import.meta.url), 'utf8');
function grab(name) {
  const i = src.indexOf('//@fn ' + name + '\n');
  assert.ok(i >= 0, name + ' exists');
  const j = src.indexOf('\n//@fn ', i + 5);
  return src.slice(i, j < 0 ? undefined : j);
}
function load(names, extra = {}) {
  const store = {};
  const sandbox = {
    Math, Date, JSON, Object, Array, Set, Map, String, Number, Infinity, parseInt, isFinite,
    window: { __LOG_KEYS: undefined },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    location: { pathname: '/' },
    ...extra,
  };
  sandbox.__store = store;
  vm.createContext(sandbox);
  vm.runInContext(names.map(grab).join('\n'), sandbox);
  return sandbox;
}
const run = (ctx, code) => vm.runInContext(code, ctx);

// ---------- pure helpers ----------
test('backoff: 2 s, 4 s, 8 s ... capped at 5 minutes, jitter never above the cap, Retry-After is a floor', () => {
  const c = load(['pushBackoffMs']);
  const seq = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 40].map((n) => run(c, `pushBackoffMs(${n}, 0, 0)`));      // rnd 0 = no jitter
  assert.deepEqual(seq, [2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000, 300000]);
  for (let n = 1; n <= 15; n++) {
    const hi = run(c, `pushBackoffMs(${n}, 0, 1)`);
    assert.ok(hi <= 300000, 'cap holds with the largest jitter, n=' + n);
    assert.ok(hi >= run(c, `pushBackoffMs(${n}, 0, 0)`), 'jitter only adds');
    assert.ok(hi <= Math.round(run(c, `pushBackoffMs(${n}, 0, 0)`) * 1.25) + 1, 'jitter is at most 25%');
  }
  assert.equal(run(c, 'pushBackoffMs(1, 20000, 0)'), 20000, 'the server\'s Retry-After is a floor');
  assert.equal(run(c, 'pushBackoffMs(1, 999999, 0)'), 30000, 'but at most 30 s');
  assert.equal(run(c, 'pushBackoffMs(0, 0, 0)'), 2000); assert.equal(run(c, 'pushBackoffMs(NaN, 0, 0)'), 2000);
});

test('dead-letter transition: the 8th failure parks the record; parked records stay; immediate/permanent parks at once', () => {
  const c = load(['deadLetterStep']);
  const retries = {}, dead = {};
  const k = 'stockMovementLog|m1', other = 'salesLog|s1';
  for (let i = 1; i <= 7; i++) {
    const moved = Array.from(c.deadLetterStep(retries, dead, [k, other], 8, 1000 + i, 'busy'));
    assert.deepEqual(moved, [], 'not parked after ' + i);
  }
  assert.equal(retries[k].n, 7);
  const moved = Array.from(c.deadLetterStep(retries, dead, [k], 8, 2000, 'server answered 500'));
  assert.deepEqual(moved, [k]);
  assert.equal(dead[k].f, 'stockMovementLog'); assert.equal(dead[k].id, 'm1'); assert.equal(dead[k].perm, false); assert.equal(dead[k].why, 'server answered 500');
  assert.equal(dead[other], undefined, 'a record that failed fewer times is not parked');
  assert.deepEqual(Array.from(c.deadLetterStep(retries, dead, [k], 8, 3000, 'x')), [], 'a parked record is not moved twice');
  const m2 = Array.from(c.deadLetterStep(retries, dead, ['returns|r9'], 8, 4000, 'refused', { immediate: true, perm: true }));
  assert.deepEqual(m2, ['returns|r9']); assert.equal(dead['returns|r9'].perm, true);
  assert.equal(Object.keys(dead).length, 2, 'nothing is ever removed by the step');
});

test('circuit breaker: more than 30 starts in 60 s -> one per 15 s, and it recovers when the rate falls', () => {
  const c = load(['syncBreaker']);
  const starts = [];
  let t = 1_000_000;
  for (let i = 0; i < 30; i++) { assert.equal(c.syncBreaker(starts, t, null).allow, true); starts.push(t); t += 100; }
  const b31 = c.syncBreaker(starts, t, null);
  assert.equal(b31.allow, true, '30 starts are still fine (the limit is "more than 30")');
  starts.push(t); t += 100;
  const tripped = c.syncBreaker(starts, t, null);
  assert.equal(tripped.allow, false); assert.equal(tripped.tripped, true);
  assert.ok(tripped.waitMs > 14000 && tripped.waitMs <= 15000, 'waits about 15 s since the last start: ' + tripped.waitMs);
  assert.equal(c.syncBreaker(starts, t + 15000, null).allow, true, 'one per 15 s');
  assert.equal(c.syncBreaker(starts, t + 61000, null).tripped, false, 'a minute later the old starts have aged out');
  assert.equal(starts.length, 0, 'and were pruned');
});

test('leader election: the lease holder leads, others follow, a stale or missing lease is taken over (fail open)', () => {
  const c = load(['syncLeaderDecide']);
  const now = 5_000_000;
  assert.equal(c.syncLeaderDecide(null, 'A', now).leader, true, 'no lease: lead');
  assert.deepEqual(JSON.parse(JSON.stringify(c.syncLeaderDecide(null, 'A', now).lease)), { id: 'A', at: now });
  assert.equal(c.syncLeaderDecide({ id: 'A', at: now - 1000 }, 'A', now).leader, true, 'own lease');
  assert.equal(c.syncLeaderDecide({ id: 'B', at: now - 1000 }, 'A', now).leader, false, 'another tab renewed it a second ago: follow');
  assert.equal(c.syncLeaderDecide({ id: 'B', at: now - 19999 }, 'A', now).leader, false, 'still alive at 19.9 s');
  assert.equal(c.syncLeaderDecide({ id: 'B', at: now - 20000 }, 'A', now).leader, true, 'heartbeat older than 20 s: the leader is dead, take over');
  assert.equal(c.syncLeaderDecide({ id: 'B', at: now + 999999 }, 'A', now).leader, true, 'a lease dated in the future (clock change) is not trusted');
  assert.equal(c.syncLeaderDecide({ id: 'B', at: 'garbage' }, 'A', now).leader, true, 'unreadable lease');
  assert.equal(c.syncLeaderDecide('junk', 'A', now).leader, true);
});

test('post-push pull: at once when the push carried something new, otherwise at most one per 5 s, 10 s, 20 s ... (60 s)', () => {
  const c = load(['postPushPullOk']);
  const st = {};
  let t = 10_000;
  assert.equal(c.postPushPullOk(st, t, true), true, 'new movement: pull now');
  assert.equal(c.postPushPullOk(st, t + 400, false), false, 'a re-send 0.4 s later: no pull');
  assert.equal(c.postPushPullOk(st, t + 4999, false), false);
  assert.equal(c.postPushPullOk(st, t + 5000, false), true, '5 s later: one');
  assert.equal(c.postPushPullOk(st, t + 5000 + 9999, false), false, 'then the wait doubles');
  assert.equal(c.postPushPullOk(st, t + 5000 + 10000, false), true);
  let at = t + 15000; let last = 0;
  for (let i = 0; i < 8; i++) { at += 60000; assert.equal(c.postPushPullOk(st, at, false), true); last = at; }
  assert.equal(c.postPushPullOk(st, last + 59999, false), false, 'never faster than every 60 s once it has grown');
  assert.equal(c.postPushPullOk(st, last + 100, true), true, 'something new resets it');
  assert.equal(st.streak, 0);
});

test('stampLocalContext: stamps device / till ONCE and never touches a send counter inside the movement', () => {
  const c = load(['stampLocalContext'], { getOrCreateDeviceId: () => 'dev_x', tillNumber: () => 3 });
  const m = { id: 'm1', lg: 1, code: 'A', delta: -1 };
  const payload = { stockMovementLog: [m] };
  const snap = () => JSON.stringify(m);
  c.stampLocalContext(payload);
  const first = snap();
  assert.equal(m.dev, 'dev_x'); assert.equal(m.till, 3); assert.equal(m.tries, undefined, 'no counter in the record');
  for (let i = 0; i < 50; i++) c.stampLocalContext(payload);
  assert.equal(snap(), first, '50 more sends do not change the record by a single byte');
  const acked = { id: 'm2', lg: 1, _srv: { applied: true } };
  c.stampLocalContext({ stockMovementLog: [acked] });
  assert.equal(JSON.stringify(acked), JSON.stringify({ id: 'm2', lg: 1, _srv: { applied: true } }), 'an acknowledged movement is left alone');
});

function outcomeCtx(extra = {}) {
  const c = load(['pushNoteOutcome', 'deadLetterStep', 'syncStateLoad', 'syncStateSave', 'syncRetryMap', 'syncDeadMap', 'syncDeadKeys', 'syncPausedUntil', 'syncPause', 'syncAttentionBar', 'appStoreKey'],
    { syncJournal: () => {}, ...extra });
  return c;
}
const body = (...ids) => ({ stockMovementLog: ids.map((id) => ({ id, lg: 1 })), salesLog: [{ id: 's1' }] });

test('pushNoteOutcome: a refusal counts once per record, 2xx (even duplicate) clears and un-parks, the 8th refusal parks, nothing is ever deleted', () => {
  const c = outcomeCtx();
  const refused = { ok: false, status: 500, code: 'busy', data: { error: 'busy' } };
  for (let i = 0; i < 7; i++) run(c, `pushNoteOutcome(${JSON.stringify(body('m1'))}, ${JSON.stringify(refused)})`);
  assert.equal(JSON.parse(c.__store.pos_push_retry_v1)['stockMovementLog|m1'].n, 7);
  assert.equal(c.__store.pos_push_deadletter_v1, undefined);
  run(c, `pushNoteOutcome(${JSON.stringify(body('m1'))}, ${JSON.stringify(refused)})`);
  const dead = JSON.parse(c.__store.pos_push_deadletter_v1);
  assert.deepEqual(Object.keys(dead).sort(), ['salesLog|s1', 'stockMovementLog|m1'], 'the records of the failing push are parked, with the reason');
  // an answer that is not about the records is not counted
  const c2 = outcomeCtx();
  for (const status of [401, 403, 408, 413, 425, 429]) for (let i = 0; i < 9; i++) run(c2, `pushNoteOutcome(${JSON.stringify(body('m1'))}, { ok: false, status: ${status}, code: '', data: null })`);
  assert.equal(c2.__store.pos_push_deadletter_v1, undefined, 'licence / too large / rate limit are not the record\'s fault');
  run(c2, `pushNoteOutcome(${JSON.stringify(body('m1'))}, { ok: false, status: 0 })`);
  assert.equal(c2.__store.pos_push_retry_v1, undefined, '"no answer" (offline) never counts');
  // an inner busy retry of one cycle counts once
  const c3 = outcomeCtx();
  run(c3, 'window.__pushAttemptLast = false');
  run(c3, `pushNoteOutcome(${JSON.stringify(body('m1'))}, ${JSON.stringify(refused)})`);
  assert.equal(c3.__store.pos_push_retry_v1, undefined);
  // success (a 2xx, also { duplicate: true }) clears counts and takes the record off the list
  run(c, `pushNoteOutcome(${JSON.stringify(body('m1'))}, { ok: true })`);
  assert.deepEqual(JSON.parse(c.__store.pos_push_deadletter_v1), {}, 'accepted: no longer needs attention');
  assert.deepEqual(JSON.parse(c.__store.pos_push_retry_v1), {});
});

test('pushNoteOutcome: permanent refusal parks the named records at once; 507 / storage_full pauses for 5 minutes; success lifts the pause', () => {
  const c = outcomeCtx();
  run(c, `pushNoteOutcome(${JSON.stringify(body('m1', 'm2'))}, { ok: false, status: 422, code: 'bad', data: { ok: false, permanent: true, ids: ['m2'], error: 'bad record' } })`);
  const dead = JSON.parse(c.__store.pos_push_deadletter_v1);
  assert.deepEqual(Object.keys(dead), ['stockMovementLog|m2'], 'only the named record');
  assert.equal(dead['stockMovementLog|m2'].perm, true);
  const c2 = outcomeCtx();
  run(c2, `pushNoteOutcome(${JSON.stringify(body('m1'))}, { ok: false, status: 422, code: '', data: { ok: false, permanent: true } })`);
  assert.equal(Object.keys(JSON.parse(c2.__store.pos_push_deadletter_v1)).length, 2, 'no ids named: every log record of that push is parked (kept, Retry sends them again)');
  const c3 = outcomeCtx();
  const t0 = Date.now();
  run(c3, `pushNoteOutcome(${JSON.stringify(body('m1'))}, { ok: false, status: 507, code: 'storage_full', data: { code: 'storage_full' } })`);
  const until = run(c3, 'syncPausedUntil()');
  assert.ok(until >= t0 + 299000 && until <= Date.now() + 300000, 'paused for about 5 minutes');
  assert.equal(c3.__store.pos_push_retry_v1, undefined, 'storage full is not counted against the records');
  const c4 = outcomeCtx();
  run(c4, `pushNoteOutcome(${JSON.stringify(body('m1'))}, { ok: false, status: 400, code: 'storage_full', data: {} })`);
  assert.ok(run(c4, 'syncPausedUntil()') > 0, 'the code alone is enough');
  run(c3, `pushNoteOutcome(${JSON.stringify(body('m1'))}, { ok: true })`);
  assert.equal(run(c3, 'syncPausedUntil()'), 0, 'a push the server accepts lifts the pause');
});

// ---------- the real app talking to the real server code ----------
// The apps carry a generated copy of src/shared/functions.js. Build the same copy in memory so this test checks the CURRENT library whether or not
// `npm run sync` has run yet.
function syncedApp(app = 'index.html') {
  const html = fs.readFileSync(path.join(ROOT, app), 'utf8');
  const names = html.match(REGION_RE)[1].split(',').filter(Boolean);
  const out = html.replace(REGION_RE, () => regionText(names, loadFunctionLibrary()));
  const f = path.join(os.tmpdir(), `zip186-${process.pid}-${app.replace(/\W/g, '_')}`);
  fs.writeFileSync(f, out);
  return path.relative(ROOT, f);
}
const ITEMS = [{ code: '00001', type: 'item', name: 'Widget', price: 100, qty: 50, unit: 'pcs', vatCategory: 'A' }];
const MV = "stockMovementLog.push({ id: 'mv-storm-1', lg: 1, timestamp: new Date().toISOString(), code: '00001', name: 'Widget', delta: -1, type: 'removed', reason: 'Sale' }); inventory[0].qty = 49; queuePush()";
const posts = (s, from) => s.state.log.slice(from).filter((x) => x.startsWith('POST')).length;
const gets = (s, from) => s.state.log.slice(from).filter((x) => x.startsWith('GET')).length;
const mvLocal = (w) => JSON.parse(w.eval("JSON.stringify(stockMovementLog.find(m => m.id === 'mv-storm-1') || null)"));
async function device(s, extra) {
  const a = await openDevice(syncedApp(), s, { pos_inventory: JSON.stringify(ITEMS), ...extra });
  await a.w.eval('pushNow()'); await sleep(300);
  a.w.eval('showToast = function () {}; window.__pushBusyRetryMs = 5');
  return a;
}
// the server, with the answer of the POST replaceable: `s.override = () => Response` (null = the real server again). Installed BEFORE a device opens (it captures s.fetch).
function overridable(s) {
  const inner = s.fetch;
  s.sent = [];
  s.override = null;
  s.fetch = async (url, o = {}) => {
    if ((o.method || 'GET').toUpperCase() === 'POST' && String(url).includes('pos-sync') && s.override) {
      s.state.log.push('POST override');
      try { s.sent.push(JSON.parse(o.body)); } catch (e) { /* none */ }
      return s.override();
    }
    if ((o.method || 'GET').toUpperCase() === 'POST' && String(url).includes('pos-sync')) { try { s.sent.push(JSON.parse(o.body)); } catch (e) { /* none */ } }
    return inner(url, o);
  };
  return s;
}
const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

test('THE INCIDENT: "unsent work" stuck on + a movement the server never stamps: pushes slow down, the record never changes, nothing is lost', async () => {
  const s = overridable(makeServer({ d1: true }));
  const a = await device(s);
  a.w.eval('window.__sealing = true');                       // anything that keeps "unsent work" true: before the fix every pull deferred, pushed again and re-pulled, ~0.4 s apart
  const n0 = s.state.log.length;
  a.w.eval(MV);
  await sleep(7000);
  const p = posts(s, n0), g = gets(s, n0);
  assert.ok(p <= 12, 'POSTs in 7 s (was ~1,000 in jsdom, one per 0.4 s on a real line): ' + p);
  assert.ok(g <= 16, 'GETs: ' + g);
  const m = mvLocal(a.w);
  assert.ok(m, 'the movement is still on the device');
  assert.equal(m.tries, undefined, 'the record carries no counter and its data never changed');
  assert.equal(s.serverState().stockMovementLog.filter((x) => x.id === 'mv-storm-1').length, 1, 'the server holds it exactly once');
  a.close();
});

test('a server that always answers 500: requests stay bounded, backoff grows, the 8th failed cycle parks the movement - still on the device, still sent on Retry', async () => {
  const s = overridable(makeServer({ d1: true }));
  const a = await device(s);
  s.state.status = 500;
  const n0 = s.state.log.length;
  a.w.eval(MV);
  await sleep(6000);
  assert.ok(posts(s, n0) <= 5, 'POSTs in 6 s against a server that always fails: ' + posts(s, n0));
  const backoffUntil = a.w.eval('window.__pushBackoffUntil');
  assert.ok(backoffUntil > Date.now(), 'a backoff is running');
  // run cycles back to back (each waits out its backoff in a real session): count 8 failed cycles
  for (let i = 0; i < 10 && !(await a.w.eval("localStorage.getItem('pos_push_deadletter_v1')") || '').includes('mv-storm-1'); i++) {
    a.w.eval('window.__pushBackoffUntil = 0; window.__pushStarts = []');
    await a.w.eval('pushNow()');
  }
  const dead = JSON.parse(a.w.eval("localStorage.getItem('pos_push_deadletter_v1') || '{}'"));
  assert.ok(dead['stockMovementLog|mv-storm-1'], 'parked in the needs-attention list');
  assert.ok(mvLocal(a.w), 'and still stored locally - never deleted');
  assert.ok(JSON.parse(a.w.eval("localStorage.getItem('pos_stock_movement_log') || '[]'")).some((m) => m.id === 'mv-storm-1'), 'also in the saved list on this device');
  const bar = a.w.document.getElementById('sync-attention-bar');
  assert.ok(bar && /need attention/.test(bar.textContent) && /Retry/.test(bar.textContent), 'the badge says so: ' + (bar && bar.textContent));
  // parked: left out of the automatic pushes (a push that goes out now does not carry it)
  s.state.status = null;
  const sentBefore = s.serverState().stockMovementLog.some((m) => m.id === 'mv-storm-1');
  assert.equal(sentBefore, false);
  a.w.eval('window.__pushBackoffUntil = 0; window.__pushStarts = []; window.__pushFails = 0');
  await a.w.eval('pushNow()');
  assert.equal(s.serverState().stockMovementLog.some((m) => m.id === 'mv-storm-1'), false, 'automatic pushes leave a parked record out');
  // Retry: the server is healthy again -> it is sent, accepted, and leaves the list
  const btn = bar.querySelector('button');
  btn.click();
  assert.ok(await until(() => s.serverState().stockMovementLog.some((m) => m.id === 'mv-storm-1'), 20000), 'Retry sends the parked record');
  assert.ok(await until(() => !(a.w.eval("localStorage.getItem('pos_push_deadletter_v1') || '{}'") || '').includes('mv-storm-1'), 10000), 'accepted: off the list');
  assert.equal(a.w.document.getElementById('sync-attention-bar'), null, 'the badge is gone');
  assert.equal(s.serverState().stockMovementLog.filter((x) => x.id === 'mv-storm-1').length, 1, 'applied once');
  a.close();
});

test('507 / storage_full: sending pauses for 5 minutes, a cashier-friendly notice shows, data stays; Retry resumes', async () => {
  const s = overridable(makeServer({ d1: true }));
  const a = await device(s);
  s.override = () => json(507, { ok: false, code: 'storage_full', error: 'storage full' });
  const n0 = s.state.log.length;
  a.w.eval(MV);
  await until(() => a.w.eval('syncPausedUntil()') > 0, 15000);
  assert.ok(a.w.eval('syncPausedUntil()') > Date.now() + 200000, 'paused for minutes');
  const at = posts(s, n0);
  const bar = a.w.document.getElementById('sync-attention-bar');
  assert.ok(bar && /Server storage is full — your sales are safe on this device and will upload automatically/.test(bar.textContent), 'banner: ' + (bar && bar.textContent));
  for (let i = 0; i < 5; i++) { a.w.eval('queuePush()'); await sleep(400); }
  await a.w.eval('pushNow()');
  assert.equal(posts(s, n0), at, 'nothing more is sent while paused');
  assert.ok(mvLocal(a.w), 'the movement is safe on the device');
  // the server has room again (the override is removed) and the person taps Retry
  s.override = null;
  bar.querySelector('button').click();
  assert.ok(await until(() => s.serverState().stockMovementLog.some((m) => m.id === 'mv-storm-1'), 20000), 'sent after Retry');
  assert.equal(a.w.eval('syncPausedUntil()'), 0, 'the pause is lifted by the accepted push');
  a.close();
});

test('a permanent 4xx { ok:false, permanent:true, ids } parks only the named record; the rest of the push goes through next time', async () => {
  const s = overridable(makeServer({ d1: true }));
  const a = await device(s);
  s.override = () => json(422, { ok: false, permanent: true, ids: ['mv-storm-1'], error: 'bad movement' });
  a.w.eval(MV);
  assert.ok(await until(() => (a.w.eval("localStorage.getItem('pos_push_deadletter_v1') || ''") || '').includes('mv-storm-1'), 15000));
  assert.ok(mvLocal(a.w), 'kept on the device');
  s.override = null;
  const n0 = s.state.log.length;
  a.w.eval('window.__pushBackoffUntil = 0; window.__pushStarts = []; window.__pushFails = 0; window.__pushFailed = false');
  a.w.eval("customers.push({ id: 'c-keep', name: 'Amina', phone: '0700000000' }); queuePush()");
  assert.ok(await until(() => (s.serverState().customers || []).some((c) => c.id === 'c-keep'), 20000), 'other changes are not held hostage by the refused record');
  assert.equal(s.serverState().stockMovementLog.some((m) => m.id === 'mv-storm-1'), false, 'and the refused one is not re-sent by itself');
  a.close();
});

test('any 2xx is success, including { duplicate: true }: the movement is acknowledged and is not sent again by the next push', async () => {
  const s = overridable(makeServer({ d1: true }));
  const a = await device(s);
  s.override = () => json(200, { ok: true, duplicate: true, updatedAt: Date.now(), ledger: 1 });
  a.w.eval(MV);
  assert.ok(await until(() => (s.sent || []).some((b) => (b.stockMovementLog || []).some((m) => m.id === 'mv-storm-1')), 10000), 'sent once');
  await until(() => !a.w.eval('window.__pushInFlight') && !a.w.eval('window.__pushQueued'), 10000);
  const first = JSON.stringify(mvLocal(a.w));
  const before = (s.sent || []).length;
  for (let i = 0; i < 4; i++) { a.w.eval('window.__pushBackoffUntil = 0; window.__pushStarts = []'); await a.w.eval('pushNow()'); }
  const carrying = (s.sent || []).slice(before).filter((b) => (b.stockMovementLog || []).some((m) => m.id === 'mv-storm-1')).length;
  assert.equal(carrying, 0, 'acknowledged: later pushes do not carry it again');
  assert.equal(JSON.stringify(mvLocal(a.w)), first, 'and the record is byte for byte the same');
  assert.equal(a.w.eval('window.__pushFailed'), false);
  a.close();
});

test('one sender per device: a tab that is not the leader sends at most once per 15 s; a stale lease is taken over; a frozen tab never sends', async () => {
  const s = overridable(makeServer({ d1: true }));
  const a = await device(s);                                   // took the lease with its first push
  const lease = () => JSON.parse(a.w.eval("localStorage.getItem('pos_sync_leader_v1:/')"));
  assert.equal(lease().id, a.w.eval('window.__syncTabId'));
  // another tab renews the lease right now
  a.w.eval(`localStorage.setItem('pos_sync_leader_v1:/', JSON.stringify({ id: 'other-tab', at: Date.now() }))`);
  const n0 = s.state.log.length;
  for (let i = 0; i < 6; i++) { a.w.eval(`customers.push({ id: 'cf${i}', name: 'F${i}', phone: '07000000${i}' }); queuePush()`); await sleep(500); }
  await sleep(500);
  assert.ok(posts(s, n0) <= 2, 'a follower tab trickles (at most one push per 15 s): ' + posts(s, n0));
  assert.ok(a.w.eval('hasUnsyncedWork()'), 'and its work stays queued, not dropped');
  // the leader stops renewing (closed / frozen): after 20 s of silence this tab takes over
  a.w.eval(`localStorage.setItem('pos_sync_leader_v1:/', JSON.stringify({ id: 'other-tab', at: Date.now() - 25000 })); window.__syncNonLeaderAt = 0; window.__pushStarts = []`);
  await a.w.eval('pushNow()');
  assert.equal(lease().id, a.w.eval('window.__syncTabId'), 'a dead leader is replaced');
  // a tab the one-tab block froze never sends and never schedules retries
  a.w.eval('window.__tabInactive = true');
  const n1 = s.state.log.length;
  a.w.eval("customers.push({ id: 'cz', name: 'Z', phone: '0711111111' }); queuePush()");
  await sleep(1200);
  await a.w.eval('pushNow()');
  assert.equal(posts(s, n1), 0, 'a frozen tab sends nothing');
  a.w.eval('window.__tabInactive = false');
  a.close();
});
