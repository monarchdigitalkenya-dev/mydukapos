// B1-D: the Services engine store (src/shared/blocks/svc-store.html), loaded in node through vm (no DOM, milliseconds).
// Covers: svcCommit (the ONLY mutation path), job create / idempotency / status machine / cancel / update, immutability of serviceType across a business-type
// switch, assets (dedupe by plate / IMEI / serial) + history, customers (Kenyan phone dedupe), business type defaults (5.3), sync hooks, archive + size helpers.
// svc-templates is written by another agent: until it lands these tests run against a small stub of SERVICES_ARCHITECTURE.md 2.2 (same keys as the doc);
// the last test loads the REAL blocks when they exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers.mjs';
import { loadSvc, blockScripts, toPlain } from './svc-helpers.mjs';

const T0 = Date.UTC(2026, 8, 30, 9, 0, 0);   // 30 Sep 2026 12:00 Nairobi
const STUB = `
function __st(key, label, phase, next, o) { return Object.assign({ key: key, label: label, phase: phase, scope: 'job', terminal: phase >= 3, next: next }, o || {}); }
var SVC_TYPES = {
  phone_repair: { key: 'phone_repair', version: 1, prefix: 'PR', assetKind: 'phone', initialStatus: 'received', appointmentInitialStatus: 'received',
    statuses: [__st('received', 'Received', 0, ['diagnosing', 'awaiting_approval', 'in_progress', 'cancelled']), __st('diagnosing', 'Diagnosing', 1, ['awaiting_approval', 'in_progress', 'awaiting_parts', 'ready', 'cancelled']),
      __st('awaiting_approval', 'Awaiting approval', 1, ['in_progress', 'cancelled'], { requires: ['quote_approved'] }), __st('awaiting_parts', 'Awaiting parts', 1, ['in_progress', 'cancelled']),
      __st('in_progress', 'In progress', 1, ['ready', 'awaiting_parts', 'diagnosing', 'cancelled'], { stamp: 'startedAt' }), __st('ready', 'Ready', 2, ['completed', 'collected', 'in_progress', 'cancelled'], { notifyOn: 'ready', stamp: 'readyAt' }),
      __st('completed', 'Completed', 3, ['collected'], { stamp: 'completedAt' }), __st('collected', 'Collected', 3, [], { stamp: 'collectedAt' }), __st('cancelled', 'Cancelled', 4, [])] },
  car_wash: { key: 'car_wash', version: 1, prefix: 'CW', assetKind: 'vehicle', initialStatus: 'waiting',
    statuses: [__st('waiting', 'Waiting', 0, ['in_progress', 'cancelled']), __st('in_progress', 'In progress', 1, ['ready', 'cancelled'], { requires: ['assigned_staff'], stamp: 'startedAt' }), __st('ready', 'Ready', 2, ['completed', 'in_progress', 'cancelled'], { notifyOn: 'ready', stamp: 'readyAt' }),
      __st('completed', 'Completed', 3, [], { stamp: 'completedAt' }), __st('cancelled', 'Cancelled', 4, [])] },
  salon: { key: 'salon', version: 2, prefix: 'SL', assetKind: 'none', initialStatus: 'checked_in', appointmentInitialStatus: 'checked_in',
    statuses: [__st('booked', 'Booked', 0, ['checked_in', 'cancelled'], { scope: 'appt' }), __st('checked_in', 'Checked in', 0, ['in_progress', 'cancelled']), __st('in_progress', 'In progress', 1, ['completed', 'cancelled']), __st('completed', 'Completed', 3, []), __st('cancelled', 'Cancelled', 4, [])] },
  other: { key: 'other', version: 1, prefix: 'SV', assetKind: 'none', initialStatus: 'received',
    statuses: [__st('received', 'Received', 0, ['in_progress', 'cancelled']), __st('in_progress', 'In progress', 1, ['ready', 'cancelled']), __st('ready', 'Ready', 2, ['completed']), __st('completed', 'Completed', 3, []), __st('cancelled', 'Cancelled', 4, [])] }
};
function svcGetTemplate(k) { return SVC_TYPES[k] || SVC_TYPES.other; }
`;
export function makeStore(globals = {}, { stub = true } = {}) {
  const pushes = { n: 0 }, events = [];
  const win = { __svcNow: T0 };
  const ctx = loadSvc(['svc-core'], { window: win, queuePush: () => { pushes.n++; }, currentServer: null, ...globals });
  if (stub) ctx.__eval(STUB); else ['svc-templates'].forEach((n) => blockScripts(n).forEach((js) => vm.runInContext(js, ctx)));
  blockScripts('svc-store').forEach((js, i) => vm.runInContext(js, ctx, { filename: `svc-store.html#${i}` }));
  ctx.svcOn('*', (p, e) => events.push(e));
  const api = {
    ctx, pushes, events, win,
    ev: (code) => ctx.__eval(code),
    clock: (ms) => { win.__svcNow = ms; },
    tick: (ms = 1000) => { win.__svcNow += ms; },
    jobs: () => toPlain(ctx.__eval('svcJobs')),
    job: (id) => toPlain(ctx.__eval('svcJobs').find((j) => j.id === id)),
    ls: (k) => JSON.parse(ctx.localStorage.getItem(k) || 'null'),
  };
  return api;
}
const CW = (over = {}) => ({ customer: { name: 'John Kamau', phone: '0712 345 678' }, asset: { kind: 'vehicle', attrs: { plate: 'kda 123a', make: 'Toyota', model: 'Premio', type: 'sedan' } }, services: [{ name: 'Full Wash', price: 1500 }], ...over });

test('lists start empty, commits persist under the pos_svc_* keys, svcLoad round-trips and tolerates corrupt storage', () => {
  const s = makeStore();
  for (const n of ['svcJobs', 'svcAssets', 'svcCatalog', 'svcAppointments', 'svcConfig']) assert.deepEqual(toPlain(s.ev(n)), [], n);
  const r = s.ctx.svcJobCreate('car_wash', CW());
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(s.ls('pos_svc_jobs').length, 1, 'jobs saved under pos_svc_jobs');
  assert.equal(s.ls('pos_svc_assets').length, 1, 'asset saved under pos_svc_assets');
  s.ctx.svcConfigSet('cfg-quote', { perType: {} });
  assert.equal(s.ls('pos_svc_config').length, 1);
  // second device start-up from the same storage
  const s2 = makeStore();
  ['pos_svc_jobs', 'pos_svc_assets', 'pos_svc_config'].forEach((k) => s2.ctx.localStorage.setItem(k, s.ctx.localStorage.getItem(k)));
  s2.ctx.svcLoad();
  assert.equal(s2.jobs().length, 1);
  assert.equal(s2.ev('svcJobs')[0].no, r.job.no);
  // corrupt / non-array / records without id are dropped, never thrown
  s2.ctx.localStorage.setItem('pos_svc_jobs', '{not json'); s2.ctx.localStorage.setItem('pos_svc_assets', '{"a":1}'); s2.ctx.localStorage.setItem('pos_svc_config', '[1,null,{"x":1},{"id":"cfg-a","value":{}}]');
  assert.doesNotThrow(() => s2.ctx.svcLoad());
  assert.deepEqual([s2.jobs().length, toPlain(s2.ev('svcAssets')).length, toPlain(s2.ev('svcConfig')).length], [0, 0, 1]);
});

test('create -> status -> status history: immutables, job number, audit, stamps, closedAt, events, queuePush on every commit', () => {
  const s = makeStore();
  const before = s.pushes.n;
  const r = s.ctx.svcJobCreate('car_wash', CW({ staffIds: ['st-1'] }));
  assert.ok(r.ok);
  const j = toPlain(r.job);
  assert.match(j.id, /^sj-/); assert.match(j.no, /^CW-260930-T1-001$/);
  assert.equal(j.serviceType, 'car_wash'); assert.equal(j.templateVersion, 1);
  assert.equal(j.status, 'waiting'); assert.equal(j.phase, 0); assert.equal(j.closedAt, null);
  assert.equal(j.statusHistory.length, 1); assert.equal(j.statusHistory[0].s, 'waiting'); assert.equal(j.statusHistory[0].by, 'Owner');
  assert.equal(j.audit[0].act, 'created'); assert.equal(j.rev, 1); assert.equal(j.createdAt, T0);
  assert.equal(j.customer.id, 'cu-712345678'); assert.equal(j.customer.phoneKey, '712345678');
  assert.equal(j.assetId, 'sa-vehicle-KDA123A'); assert.equal(j.assetSnap.label, 'Toyota Premio KDA 123A');
  assert.equal(j.jobStaff.length, 1); assert.equal(j.jobStaff[0].staffId, 'st-1');
  assert.ok(s.pushes.n > before, 'queuePush called');
  assert.ok(s.events.includes('job:created'));

  s.tick(60000); const a = s.ctx.svcJobSetStatus(j.id, 'in_progress', { note: 'bay 2' });
  assert.ok(a.ok, JSON.stringify(a)); assert.equal(a.from, 'waiting'); assert.equal(a.to, 'in_progress');
  s.tick(60000); const b = s.ctx.svcJobSetStatus(j.id, 'ready');
  assert.equal(b.notifyOn, 'ready', 'the template says to offer the notification sheet');
  s.tick(60000); const c = s.ctx.svcJobSetStatus(j.id, 'completed');
  const f = s.job(j.id);
  assert.deepEqual(f.statusHistory.map((h) => h.s), ['waiting', 'in_progress', 'ready', 'completed'], 'append-only history');
  assert.deepEqual(f.statusHistory.map((h) => h.from), [undefined, 'waiting', 'in_progress', 'ready']);
  assert.equal(f.statusHistory[1].note, 'bay 2');
  assert.equal(f.status, 'completed'); assert.equal(f.phase, 3);
  assert.equal(f.startedAt, T0 + 60000); assert.equal(f.readyAt, T0 + 120000); assert.equal(f.completedAt, T0 + 180000); assert.equal(f.closedAt, T0 + 180000);
  assert.deepEqual(f.audit.map((x) => x.act), ['created', 'status', 'status', 'status']);
  assert.deepEqual([f.audit[1].from, f.audit[1].to], ['waiting', 'in_progress']);
  assert.equal(f.rev, 4); assert.ok(f.updatedAt > j.updatedAt);
  assert.ok(s.events.filter((e) => e === 'job:status').length === 3);
  assert.equal(c.ok, true);
});

test('duplicate tap: the same client-generated id (or idemKey) returns the job that exists; nothing is created twice', () => {
  const s = makeStore();
  const a = s.ctx.svcJobCreate('car_wash', { ...CW(), id: 'sj-draft-1' });
  const b = s.ctx.svcJobCreate('car_wash', { ...CW(), id: 'sj-draft-1' });
  assert.equal(b.duplicate, true); assert.equal(a.job.id, b.job.id);
  const c = s.ctx.svcJobCreate('car_wash', { ...CW(), idemKey: 'k-7' }); const d = s.ctx.svcJobCreate('car_wash', { ...CW(), idemKey: 'k-7' });
  assert.equal(d.duplicate, true); assert.equal(c.job.id, d.job.id);
  assert.equal(s.jobs().length, 2);
  assert.equal(toPlain(s.ev('customers')).length, 1, 'one customer');
  assert.equal(toPlain(s.ev('svcAssets')).length, 1, 'one vehicle');
  assert.equal(s.job('sj-draft-1').audit.length, 1, 'no second audit row');
  assert.notEqual(a.job.no, c.job.no, 'job numbers are unique');
  const e = s.ctx.svcCreateJob({ typeKey: 'car_wash', ...CW(), id: 'sj-draft-1' });          // the 8.3 contract name
  assert.equal(e.duplicate, true);
});

test('status rules: transitions come from the template, requires are checked, closed is never reopened, same status is a no-op', () => {
  const s = makeStore();
  const j = s.ctx.svcJobCreate('car_wash', CW()).job;
  assert.deepEqual(toPlain(s.ctx.svcAllowedNext(j)), ['in_progress', 'cancelled']);
  let r = s.ctx.svcJobSetStatus(j.id, 'ready');
  assert.deepEqual([r.ok, r.code], [false, 'transition'], 'waiting -> ready is not in next');
  r = s.ctx.svcJobSetStatus(j.id, 'in_progress');
  assert.deepEqual([r.ok, r.code, toPlain(r.missing)], [false, 'requires', ['assigned_staff']], 'in_progress needs a staff member');
  assert.equal(s.ctx.svcCanEnter(j, 'in_progress').ok, false);
  r = s.ctx.svcJobSetStatus(j.id, 'in_progress', { force: true });
  assert.equal(r.ok, false, 'force without a reason is refused');
  r = s.ctx.svcJobSetStatus(j.id, 'in_progress', { force: true, note: 'owner override' });
  assert.ok(r.ok, JSON.stringify(r));
  const h = s.job(j.id).statusHistory.length;
  r = s.ctx.svcJobSetStatus(j.id, 'in_progress'); assert.deepEqual([r.ok, r.noop], [true, true]); assert.equal(s.job(j.id).statusHistory.length, h, 'no history row for a no-op');
  assert.equal(s.ctx.svcJobSetStatus(j.id, 'nonsense').code, 'status');
  s.ctx.svcJobSetStatus(j.id, 'ready'); s.ctx.svcJobSetStatus(j.id, 'completed');
  r = s.ctx.svcJobSetStatus(j.id, 'in_progress', { force: true, note: 'reopen' });
  assert.deepEqual([r.ok, r.code], [false, 'closed'], 'a closed job is never reopened, even with force');
  r = s.ctx.svcJobSetStatus(j.id, 'completed', { id: 'sh-x' }); assert.equal(r.noop, true);
  // idempotent entry id (a retried tap carrying the same history id)
  const k = s.ctx.svcJobCreate('car_wash', CW({ customer: { name: 'B', phone: '0722000111' }, staffIds: ['st-1'] })).job;
  s.ctx.svcJobSetStatus(k.id, 'in_progress', { id: 'sh-retry' }); const n1 = s.job(k.id).statusHistory.length;
  r = s.ctx.svcJobSetStatus(k.id, 'ready', { id: 'sh-retry' }); assert.equal(r.duplicate, true); assert.equal(s.job(k.id).statusHistory.length, n1);
  assert.equal(s.ctx.svcAllowedNext(s.ctx.svcAllJobs({ includeLegacy: false }).find((x) => x.id === j.id)).length, 0, 'completed has no next');
});

test('permissions: a staff member without svc:status / svc:create / svc:cancel is refused; the owner (no session) is never refused', () => {
  const member = { id: 'st-9', name: 'Wanjiru', roles: ['svc:view', 'svc:edit'] };
  const s = makeStore({ currentServer: member });
  assert.equal(s.ctx.svcJobCreate('car_wash', CW()).code, 'perm');
  const owner = makeStore();
  const j = owner.ctx.svcJobCreate('car_wash', CW({ staffIds: ['st-1'] })).job;
  // same state seen by the restricted member
  const s2 = makeStore({ currentServer: member });
  s2.ctx.svcSyncApply({ svcJobs: toPlain(owner.ev('svcJobs')) });
  assert.equal(s2.ctx.svcJobSetStatus(j.id, 'in_progress').code, 'perm');
  assert.equal(s2.ctx.svcJobCancel(j.id, { reason: 'x' }).code, 'perm');
  assert.equal(s2.ctx.svcSetBusinessType('salon').code, 'perm');
  assert.equal(s2.ctx.svcJobUpdate(j.id, { notes: 'ok' }).ok, true, 'svc:edit is held');
});

test('cancel needs a reason, is refused on a closed job, stamps who/why, and never deletes', () => {
  const s = makeStore();
  const j = s.ctx.svcJobCreate('phone_repair', { customer: { name: 'Ann', phone: '0700111222' }, asset: { kind: 'phone', attrs: { brand: 'Samsung', model: 'A14', imei: '356789012345678' } } }).job;
  assert.equal(s.ctx.svcJobCancel(j.id, {}).code, 'reason');
  const r = s.ctx.svcJobCancel(j.id, { reason: 'customer changed mind' });
  assert.ok(r.ok, JSON.stringify(r));
  const f = s.job(j.id);
  assert.equal(f.status, 'cancelled'); assert.equal(f.phase, 4); assert.ok(f.closedAt); assert.equal(f.cancelReason, 'customer changed mind');
  assert.equal(f.audit[f.audit.length - 1].act, 'cancel'); assert.equal(f.audit[f.audit.length - 1].note, 'customer changed mind');
  assert.equal(s.jobs().length, 1, 'the job is still there');
  const k = s.ctx.svcJobCreate('phone_repair', { customer: { name: 'Bob', phone: '0700111333' } }).job;
  s.ctx.svcJobSetStatus(k.id, 'in_progress', { force: true, note: 'go' }); s.ctx.svcJobSetStatus(k.id, 'ready'); s.ctx.svcJobSetStatus(k.id, 'completed');
  assert.equal(s.ctx.svcJobCancel(k.id, { reason: 'late' }).code, 'closed');
});

test('delete = tombstone, only for a job with no money; views hide it', () => {
  const s = makeStore();
  const a = s.ctx.svcJobCreate('other', { customer: { name: 'A', phone: '0711000001' } }).job, b = s.ctx.svcJobCreate('other', { customer: { name: 'B', phone: '0711000002' } }).job;
  s.ctx.svcCommit((x) => { x.payments.push({ id: 'p1', at: T0, amount: 100, method: 'cash', kind: 'deposit' }); return x; }, { list: 'svcJobs', id: b.id, audit: { act: 'payment' } });
  assert.equal(s.ctx.svcJobDelete(a.id, {}).code, 'reason');
  assert.equal(s.ctx.svcJobDelete(b.id, { reason: 'x' }).code, 'hasmoney');
  assert.ok(s.ctx.svcJobDelete(a.id, { reason: 'test entry' }).ok);
  assert.equal(s.job(a.id)._deleted, true);
  assert.deepEqual(toPlain(s.ctx.svcAllJobs({ includeLegacy: false })).map((x) => x.id), [b.id]);
  assert.equal(s.ctx.svcCommit(() => ({}), { list: 'svcJobs', id: a.id }).code, 'deleted', 'a tombstone is not edited');
});

test('svcJobUpdate: immutable / derived keys refused, data merged, customer re-snapshotted, money arrays may only grow, legacy refused', () => {
  const s = makeStore({ serviceJobs: [{ id: 'JOB-ABC-XYZ', createdAt: '2026-09-01T08:00:00.000Z', clientName: 'Old', clientPhone: '0733000000', status: 'pending', components: [], laborFee: 0 }] });
  const j = s.ctx.svcJobCreate('car_wash', CW({ data: { veh_notes: 'scratch left' } })).job;
  for (const k of ['serviceType', 'templateVersion', 'no', 'id', 'createdAt', 'status', 'statusHistory', 'phase', 'closedAt', 'rev', 'audit']) {
    const r = s.ctx.svcJobUpdate(j.id, { [k]: 'x' });
    assert.deepEqual([r.ok, r.code], [false, 'immutable'], k);
  }
  let r = s.ctx.svcJobUpdate(j.id, { data: { cond_dents: 'rear door' }, notes: 'VIP', dueAt: '2026-09-30T15:00:00.000Z' }, { reason: 'added condition' });
  assert.ok(r.ok);
  const f = s.job(j.id);
  assert.deepEqual(f.data, { veh_notes: 'scratch left', cond_dents: 'rear door' }); assert.equal(f.notes, 'VIP'); assert.equal(f.dueAt, Date.parse('2026-09-30T15:00:00.000Z'));
  assert.equal(f.audit[f.audit.length - 1].act, 'edited'); assert.equal(f.audit[f.audit.length - 1].note, 'added condition');
  r = s.ctx.svcJobUpdate(j.id, { customer: { name: 'John K.', phone: '+254712345678' } });
  assert.ok(r.ok); assert.equal(s.job(j.id).customer.name, 'John K.'); assert.equal(s.job(j.id).customer.id, 'cu-712345678', 'same customer: +254 and 0 forms match');
  assert.equal(toPlain(s.ev('customers')).length, 1);
  // money arrays grow only
  s.ctx.svcCommit((x) => { x.charges.push({ id: 'c1', kind: 'additional', label: 'Heavy dirt', amount: 300, at: T0, approved: true, rev: 0 }); return x; }, { list: 'svcJobs', id: j.id, audit: { act: 'charge.add' } });
  r = s.ctx.svcJobUpdate(j.id, { charges: [] });
  assert.deepEqual([r.ok, r.code, r.field], [false, 'shrink', 'charges']);
  assert.equal(s.job(j.id).charges.length, 1);
  // legacy rows are refused with a promote hint
  r = s.ctx.svcJobUpdate('JOB-ABC-XYZ', { notes: 'x' }); assert.deepEqual([r.ok, r.code, r.action], [false, 'legacy', 'promote']);
  assert.deepEqual([s.ctx.svcJobSetStatus('JOB-ABC-XYZ', 'ready').code, s.ctx.svcJobCancel('JOB-ABC-XYZ', { reason: 'x' }).code], ['legacy', 'legacy']);
  assert.equal(s.ctx.svcJobUpdate('nope', {}).code, 'notfound');
});

test('svcCommit: stamps updatedAt / rev (strictly increasing even inside one millisecond), guards money arrays and immutables, trims rings, is transactional', () => {
  const s = makeStore();
  const j = s.ctx.svcJobCreate('car_wash', CW()).job;
  const c = (fn, o = {}) => s.ctx.svcCommit(fn, { list: 'svcJobs', id: j.id, ...o });
  const r1 = c((x) => { x.notes = 'a'; return x; }), r2 = c((x) => { x.notes = 'b'; return x; });
  assert.ok(r2.rec.updatedAt > r1.rec.updatedAt, 'same clock reading still orders commits'); assert.equal(r2.rec.rev, r1.rec.rev + 1);
  // append-only guard: shrink, removed id, immutable
  c((x) => { x.payments.push({ id: 'p1', amount: 500, at: T0 }, { id: 'p2', amount: 200, at: T0 }); return x; });
  assert.equal(c((x) => { x.payments.pop(); return x; }).code, 'shrink');
  assert.equal(c((x) => { x.payments = [x.payments[0], { id: 'p3', amount: 1, at: T0 }]; return x; }).code, 'shrink', 'same length but an id vanished');
  assert.equal(c((x) => { x.statusHistory = []; return x; }).code, 'shrink');
  assert.equal(c((x) => { x.serviceType = 'salon'; return x; }).code, 'immutable');
  assert.equal(c((x) => { x.templateVersion = 9; return x; }).code, 'immutable');
  assert.equal(s.job(j.id).payments.length, 2, 'refused writes changed nothing');
  // in-place element change with a higher rev is allowed (void)
  assert.ok(c((x) => { x.payments[0].voidedAt = T0 + 5; x.payments[0].rev = 1; return x; }).ok);
  // transactional: throw / abort leave the stored record alone
  const snap = JSON.stringify(s.job(j.id));
  assert.equal(c(() => { throw new Error('boom'); }).code, 'error');
  assert.equal(c((x) => { x.notes = 'never'; return false; }).code, 'aborted');
  assert.equal(JSON.stringify(s.job(j.id)), snap);
  assert.equal(s.ctx.svcCommit((x) => x, { list: 'svcJobs', id: 'missing' }).code, 'notfound');
  assert.equal(s.ctx.svcCommit((x) => x, { list: 'nope', id: 'x' }).code, 'list');
  // rings: audit 60, notify 12
  for (let i = 0; i < 70; i++) c((x) => { x.notify.push({ id: 'n' + i, at: T0 + i, channel: 'sms', event: 'ready' }); return x; }, { audit: { act: 'notify' } });
  const f = s.job(j.id);
  assert.equal(f.audit.length, 60); assert.equal(f.notify.length, 12); assert.equal(f.notify[11].id, 'n69');
  // record form (8.3 signature svcCommit(list, rec, opts))
  const cp = toPlain(s.ctx.svcStFindIn(s.ctx.__eval('svcJobs'), j.id)); cp.notes = 'via record form';
  const r = s.ctx.svcCommit('svcJobs', cp, { reason: 'rec form' });
  assert.ok(r.ok); assert.equal(s.job(j.id).notes, 'via record form'); assert.equal(s.job(j.id).audit.pop().note, 'rec form');
  // a legacy view can never be committed
  assert.equal(s.ctx.svcCommit('svcJobs', { id: 'JOB-1', _legacy: true }).code, 'legacy');
});

test('a job over 8 KB is trimmed (audit, notes) and reported, never refused', () => {
  const s = makeStore();
  const j = s.ctx.svcJobCreate('other', { customer: { name: 'Big', phone: '0711999888' } }).job;
  for (let i = 0; i < 25; i++) s.ctx.svcCommit((x) => { x.notes = 'n'.repeat(1800); x.audit.push({ id: 'x' + i, at: T0, by: 'o', act: 'edited', note: 'y'.repeat(200) }); return x; }, { list: 'svcJobs', id: j.id });
  const f = s.job(j.id);
  assert.ok(JSON.stringify(f).length <= 8192 + 300, 'trimmed near the cap: ' + JSON.stringify(f).length);
  assert.ok(f.audit.length <= 60);
  const st = toPlain(s.ctx.svcStoreStats());
  assert.equal(st.lists.svcJobs.count, 1); assert.ok(st.totalBytes > 0); assert.equal(st.jobCap, 8192);
  assert.equal(s.ctx.svcJobBytes(f) > 0, true);
});

test('customers: one record per phone however it is typed; existing customers are reused; the name is only filled when blank; no phone = walk-in', () => {
  const s = makeStore({ customers: [{ id: 'c-old', name: '', phone: '0712345678', tokens: 4, createdAt: 1 }, { id: 'c-2', name: 'Faith', phone: '254722111222', tokens: 0, createdAt: 2 }] });
  const a = s.ctx.svcEnsureCustomer({ name: 'Jane W', phone: '+254 712-345-678' });
  assert.equal(a.id, 'c-old', 'matched the existing customer by phone key'); assert.equal(a.name, 'Jane W');
  assert.equal(toPlain(s.ev('customers'))[0].name, 'Jane W', 'blank name filled');
  const b = s.ctx.svcEnsureCustomer({ name: 'Somebody Else', phone: '0712345678' });
  assert.equal(b.name, 'Somebody Else'); assert.equal(toPlain(s.ev('customers'))[0].name, 'Jane W', 'an existing name is never overwritten');
  assert.equal(s.ctx.svcEnsureCustomer({ name: 'F', phone: '722 111 222' }).id, 'c-2');
  const n = s.ctx.svcEnsureCustomer({ name: 'New', phone: '0799 000 111', email: 'n@x.co.ke' });
  assert.equal(n.id, 'cu-799000111'); assert.equal(n.email, 'n@x.co.ke');
  for (const v of ['+254799000111', '254799000111', '799000111', '0799-000-111']) assert.equal(s.ctx.svcEnsureCustomer({ name: 'New', phone: v }).id, 'cu-799000111', v);
  const all = toPlain(s.ev('customers')); assert.equal(all.length, 3); assert.equal(all[2].phone, '0799000111', 'stored in the national form staff type');
  assert.deepEqual(toPlain(s.ctx.svcEnsureCustomer({ name: 'Walk In', phone: '' })), { id: null, name: 'Walk In', phone: '', phoneKey: '' });
  assert.equal(toPlain(s.ev('customers')).length, 3, 'walk-in creates nothing');
  assert.ok(s.ctx.svcEnsureCustomer({ name: 'Y', phone: '0711222333', allowCreate: false }).id === null, 'allowCreate:false never writes');
  assert.ok(s.ctx.localStorage.getItem('pos_customers'), 'customers persisted');
  assert.equal(s.ctx.svcCustomerUpsert({ name: 'New', phone: '0799000111' }).id, 'cu-799000111');
});

test('assets: plate variants dedupe to ONE vehicle, IMEI / serial identify phones and equipment, owner change keeps ownerHistory, keyless items are not stored', () => {
  const s = makeStore();
  const mk = (plate, phone = '0712345678', name = 'John') => s.ctx.svcJobCreate('car_wash', CW({ customer: { name, phone }, asset: { kind: 'vehicle', attrs: { plate, make: 'Toyota', model: 'Premio' } } })).job;
  const j1 = mk('kda 123a'), j2 = mk('KDA-123A'), j3 = mk('KDA123A');
  assert.deepEqual([j1.assetId, j2.assetId, j3.assetId], ['sa-vehicle-KDA123A', 'sa-vehicle-KDA123A', 'sa-vehicle-KDA123A']);
  assert.equal(toPlain(s.ev('svcAssets')).length, 1);
  assert.equal(toPlain(s.ctx.svcAssetFind('vehicle', 'kda123a')).id, 'sa-vehicle-KDA123A');
  assert.equal(toPlain(s.ctx.svcAssetFind('KDA 123A')).id, 'sa-vehicle-KDA123A', 'one-argument free search');
  assert.equal(toPlain(s.ctx.svcFindAssetByKey('vehicle', 'KDA-123-A')).id, 'sa-vehicle-KDA123A');
  assert.equal(s.ctx.svcAssetFind('vehicle', 'KZZ999Z'), null);
  const a = toPlain(s.ev('svcAssets')[0]);
  assert.equal(a.ownerKey, '712345678'); assert.equal(a.ownerName, 'John'); assert.equal(a.label, 'Toyota Premio KDA 123A');
  // owner change
  s.tick(5000); mk('KDA 123A', '0733555777', 'Peter');
  const b = toPlain(s.ev('svcAssets')[0]);
  assert.equal(b.ownerKey, '733555777'); assert.equal(b.ownerHistory.length, 1); assert.equal(b.ownerHistory[0].key, '712345678');
  assert.match(b.ownerHistory[0].id, /^oh-/, 'ownerHistory elements carry an id so the server can union them');
  // attribute update (colour) keeps the same record
  s.ctx.svcUpsertAsset({ kind: 'vehicle', attrs: { plate: 'KDA 123A', color: 'silver' } });
  assert.equal(toPlain(s.ev('svcAssets')[0]).attrs.color, 'silver'); assert.equal(toPlain(s.ev('svcAssets')[0]).attrs.make, 'Toyota');
  // phones: IMEI, then IMEI2, then serial
  const p1 = s.ctx.svcJobCreate('phone_repair', { customer: { name: 'A', phone: '0700000001' }, asset: { kind: 'phone', attrs: { brand: 'Samsung', model: 'A14', imei: '356789012345678' } } }).job;
  const p2 = s.ctx.svcJobCreate('phone_repair', { customer: { name: 'A', phone: '0700000001' }, asset: { kind: 'phone', attrs: { brand: 'Samsung', model: 'A14', imei: '3567 8901 2345 678' } } }).job;
  assert.equal(p1.assetId, 'sa-phone-356789012345678'); assert.equal(p2.assetId, p1.assetId);
  const p3 = s.ctx.svcJobCreate('phone_repair', { customer: { name: 'A', phone: '0700000001' }, asset: { kind: 'phone', attrs: { brand: 'Tecno', model: 'Spark', serial: 'sn-ab-1234' } } }).job;
  assert.equal(p3.assetId, 'sa-phone-SNAB1234');
  assert.equal(toPlain(s.ctx.svcAssetFind('356789012345678')).kind, 'phone');
  const p4 = s.ctx.svcJobCreate('phone_repair', { customer: { name: 'B', phone: '0700000002' }, asset: { kind: 'phone', attrs: { brand: 'Itel', model: 'A60' } } }).job;
  assert.equal(p4.assetId, null, 'no IMEI / serial: nothing to dedupe on, not stored as an asset'); assert.equal(p4.assetSnap.label, 'Itel A60', 'but the job keeps the snapshot');
  assert.deepEqual(toPlain(s.ctx.svcUpsertAsset({ kind: 'garment', attrs: { item: 'Suit' } })), { ok: false, code: 'nokey' });
  assert.equal(toPlain(s.ev('svcAssets')).length, 3);
});

test('asset history: live visits + ring entries newest first, previous visits survive archiving of closed jobs, open jobs are never archived', () => {
  const s = makeStore();
  const mk = (svc, price) => { const r = s.ctx.svcJobCreate('car_wash', CW({ services: [{ name: svc, price }], staffIds: ['st-1'], data: { veh_odometer: 80000 } })); return r.job; };
  const j1 = mk('Premium Wash', 1200); s.tick(86400000);
  const j2 = mk('Interior Cleaning', 800); s.tick(86400000);
  const j3 = mk('Full Wash', 1500);
  [j1, j2].forEach((j) => { s.ctx.svcJobSetStatus(j.id, 'in_progress'); s.ctx.svcJobSetStatus(j.id, 'ready'); s.ctx.svcJobSetStatus(j.id, 'completed'); });
  s.ctx.svcCommit((x) => { x.payments.push({ id: 'pay-a', at: T0, amount: 1200, method: 'cash', kind: 'balance' }); return x; }, { list: 'svcJobs', id: j1.id, audit: { act: 'payment' } });
  s.ctx.svcCommit((x) => { x.payments.push({ id: 'pay-b', at: T0, amount: 800, method: 'mpesa', kind: 'balance' }); return x; }, { list: 'svcJobs', id: j2.id, audit: { act: 'payment' } });
  const aid = 'sa-vehicle-KDA123A';
  let h = toPlain(s.ctx.svcAssetHistory(aid));
  assert.deepEqual(h.map((v) => v.services), ['Full Wash', 'Interior Cleaning', 'Premium Wash'], 'newest first');
  assert.deepEqual(h.map((v) => v.total), [1500, 800, 1200]); assert.equal(h[0].odometer, 80000); assert.equal(h[0].status, 'waiting');
  assert.ok(h.every((v) => !v.archived));
  // 100 days later: the two closed + settled jobs are archivable, the open one is not
  s.clock(T0 + 100 * 86400000);
  const plan = toPlain(s.ctx.svcArchivePlan({ keepDays: 90 }));
  assert.deepEqual(plan.ids.sort(), [j1.id, j2.id].sort()); assert.ok(plan.bytes > 0);
  assert.equal(s.ctx.svcArchivePlan({ keepDays: 400 }).ids.length, 0, 'nothing is old enough');
  const moved = s.ctx.svcArchiveLocal(plan.ids, { keepDays: 90 });
  assert.equal(moved.moved, 2);
  assert.deepEqual(s.jobs().map((j) => j.id), [j3.id], 'only the open job is left in the hot list');
  h = toPlain(s.ctx.svcAssetHistory(aid));
  assert.deepEqual(h.map((v) => [v.services, v.archived]), [['Full Wash', false], ['Interior Cleaning', true], ['Premium Wash', true]], 'previous visits survive from the asset ring');
  assert.deepEqual(h.map((v) => v.total), [1500, 800, 1200]);
  assert.equal(h[1].paid, 800);
  assert.equal(s.ctx.svcArchiveLocal([j3.id], { keepDays: 0 }).moved, 0, 'an open job is never archived, even when asked');
  assert.equal(s.ls('pos_svc_jobs').length, 1, 'the archive is persisted');
  const sum = toPlain(s.ctx.svcAssetSummary(aid)); assert.equal(sum.visits.length, 3); assert.equal(sum.outstanding, 1500); assert.equal(sum.owner.name, 'John Kamau');
  // an unsettled closed job is kept (its balance must stay visible)
  const j4 = mk('Engine Wash', 600); ['in_progress', 'ready', 'completed'].forEach((k) => s.ctx.svcJobSetStatus(j4.id, k)); s.clock(T0 + 300 * 86400000);
  assert.equal(s.ctx.svcArchivePlan({ keepDays: 90 }).ids.includes(j4.id), false, 'owes money: not archived');
  assert.equal(s.ctx.svcArchivePlan({ keepDays: 90, requireSettled: false }).ids.includes(j4.id), true);
});

test('ring of the asset history holds 30 visits and drops the oldest', () => {
  const s = makeStore();
  for (let i = 0; i < 33; i++) { s.tick(60000); s.ctx.svcJobCreate('car_wash', CW({ services: [{ name: 'W' + i, price: 100 }] })); }
  const a = toPlain(s.ev('svcAssets')[0]);
  assert.equal(a.history.length, 30); assert.equal(a.jobCount, 33);
  assert.ok(!a.history.some((h) => h.services === 'W0'), 'oldest dropped'); assert.ok(a.history.some((h) => h.services === 'W32'));
  assert.equal(s.ctx.svcAssetHistory(a.id).length, 33, 'live jobs are merged in, so nothing shows as missing until they are archived');
});

test('business type: defaults for existing shops (5.3), classic mode until chosen, choose -> engine, unchanged is a no-op, bad type refused', () => {
  const fresh = makeStore();
  assert.equal(fresh.ctx.svcBusinessType(), 'other'); assert.equal(fresh.ctx.svcLegacyType(), 'other'); assert.equal(fresh.ctx.svcClassicMode(), true);
  const repair = makeStore({ serviceJobs: [{ id: 'JOB-1', createdAt: '2026-09-01T08:00:00.000Z', clientName: 'X', clientPhone: '0700', status: 'pending' }] });
  assert.equal(repair.ctx.svcBusinessType(), 'phone_repair'); assert.equal(repair.ctx.svcLegacyType(), 'phone_repair'); assert.equal(repair.ctx.svcClassicMode(), true);
  assert.equal(repair.ctx.svcGetBusinessType(), 'phone_repair');
  assert.deepEqual(repair.ctx.svcSetBusinessType('nope').code, 'type');
  assert.equal(repair.ctx.svcConfigGet('cfg-business'), null, 'nothing is written until the owner chooses');
  const r = repair.ctx.svcSetBusinessType('salon', { source: 'settings', alsoOffer: ['barber', 'salon', 'bogus'] });
  assert.ok(r.ok); assert.equal(r.previous, null); assert.equal(r.changed, true);
  const cfg = toPlain(repair.ctx.svcConfigGet('cfg-business'));
  assert.equal(cfg.businessType, 'salon'); assert.equal(cfg.chosen, true); assert.equal(cfg.source, 'settings'); assert.equal(cfg.uiMode, 'engine'); assert.equal(cfg.chosenBy, 'Owner');
  assert.deepEqual(cfg.enabledTypes, ['salon']);  // barber is not a type of the stub; real templates keep it (see integration test)
  assert.equal(cfg.legacyType, 'phone_repair', 'the legacy label is fixed at the first choice');
  assert.equal(repair.ctx.svcBusinessType(), 'salon'); assert.equal(repair.ctx.svcClassicMode(), false);
  const rec = toPlain(repair.ctx.svcConfigRecord('cfg-business'));
  assert.equal(rec.kind, 'business'); assert.match(rec.log[0].what, /business type: phone_repair -> salon/); assert.ok(rec.updatedAt > 0);
  assert.equal(repair.ctx.svcSetBusinessType('salon', { source: 'settings', alsoOffer: ['other'] }).unchanged, undefined, 'alsoOffer changed -> a real write');
  assert.deepEqual(toPlain(repair.ctx.svcConfigGet('cfg-business').enabledTypes), ['salon', 'other']);
  repair.ctx.svcSetBusinessType('salon', { source: 'settings' });
  assert.equal(repair.ctx.svcSetBusinessType('salon', { source: 'settings' }).unchanged, true, 'same again -> no-op');
  assert.equal(repair.ctx.svcBusinessConfig().country, 'KE');
  // per-device classic override
  repair.ctx.localStorage.setItem('pos_svc_ui', 'classic'); assert.equal(repair.ctx.svcClassicMode(), true);
  // sign-up choice rides the first push
  const su = makeStore(); su.win.__svcSignupType = 'car_wash';
  const n0 = su.pushes.n; assert.ok(su.ctx.svcApplySignupType().ok); assert.equal(su.ctx.svcBusinessType(), 'car_wash'); assert.equal(su.ctx.svcConfigGet('cfg-business').source, 'signup'); assert.ok(su.pushes.n > n0);
  assert.equal(su.ctx.svcApplySignupType().code, 'already', 'an existing choice is never overwritten');
  const none = makeStore(); assert.equal(none.ctx.svcApplySignupType().code, 'none'); none.win.__svcSignupType = 'wat'; assert.equal(none.ctx.svcApplySignupType().code, 'none');
});

test('switching business type never rewrites a job: serviceType / templateVersion immutable, All types history intact, new jobs use the new type', () => {
  const s = makeStore();
  s.ctx.svcSetBusinessType('phone_repair', { source: 'settings' });
  const mkP = (n) => s.ctx.svcJobCreate(undefined, { customer: { name: 'P' + n, phone: '07000000' + n }, asset: { kind: 'phone', attrs: { brand: 'Apple', model: 'iPhone 11', imei: '35678901234567' + n } }, data: { rep_problem: 'cracked screen' } }).job;
  const p1 = mkP(1), p2 = mkP(2);
  assert.equal(p1.serviceType, 'phone_repair', 'no type given = the shop type');
  const snap = JSON.stringify(s.jobs());
  const snapAssets = JSON.stringify(toPlain(s.ev('svcAssets')));
  s.tick(1000);
  assert.ok(s.ctx.svcSetBusinessType('car_wash', { source: 'settings' }).ok);
  assert.equal(JSON.stringify(s.jobs()), snap, 'switch 1: jobs byte-identical'); assert.equal(JSON.stringify(toPlain(s.ev('svcAssets'))), snapAssets, 'assets too');
  const w = s.ctx.svcJobCreate(undefined, CW()).job;
  assert.equal(w.serviceType, 'car_wash'); assert.equal(w.no.slice(0, 3), 'CW-');
  assert.ok(s.ctx.svcSetBusinessType('salon', { source: 'settings' }).ok);
  assert.ok(s.ctx.svcSetBusinessType('phone_repair', { source: 'settings' }).ok);
  const after = s.jobs();
  assert.equal(JSON.stringify(after.filter((j) => j.serviceType === 'phone_repair' && [p1.id, p2.id].includes(j.id))), JSON.stringify(s.jobs().filter((j) => [p1.id, p2.id].includes(j.id))));
  assert.deepEqual(JSON.parse(snap), after.filter((j) => [p1.id, p2.id].includes(j.id)), 'the old jobs are byte-for-byte what they were');
  assert.equal(after.find((j) => j.id === w.id).serviceType, 'car_wash', 'the car wash job is still a car wash job');
  // the serviceType cannot be changed by any API
  assert.equal(s.ctx.svcJobUpdate(w.id, { serviceType: 'salon' }).code, 'immutable');
  assert.equal(s.ctx.svcCommit((x) => { x.serviceType = 'salon'; return x; }, { list: 'svcJobs', id: w.id }).code, 'immutable');
  // views: current type + All types
  assert.deepEqual(toPlain(s.ctx.svcAllJobs({ types: ['car_wash'] })).map((j) => j.id), [w.id]);
  assert.equal(s.ctx.svcAllJobs({ includeLegacy: false }).length, 3);
  // and each job still renders with ITS OWN template
  assert.equal(s.ctx.svcStTemplate(after.find((j) => j.id === p1.id).serviceType).key, 'phone_repair');
  const cfgLog = toPlain(s.ctx.svcConfigRecord('cfg-business')).log;
  assert.equal(cfgLog.length, 4, 'every switch is logged'); assert.match(cfgLog[3].what, /salon -> phone_repair/);
});

test('svcAllJobs: types / status / since / text / phone filters, newest first, deleted hidden, limit', () => {
  const s = makeStore();
  const a = s.ctx.svcJobCreate('car_wash', CW()).job; s.tick(1000);
  const b = s.ctx.svcJobCreate('salon', { customer: { name: 'Mary Wanjiku', phone: '0788 111 222' } }).job; s.tick(1000);
  const c = s.ctx.svcJobCreate('other', { customer: { name: 'Zed', phone: '' } }).job;
  const ids = (o) => toPlain(s.ctx.svcAllJobs(o)).map((j) => j.id);
  assert.deepEqual(ids({}), [c.id, b.id, a.id]);
  assert.deepEqual(ids({ types: 'salon' }), [b.id]); assert.deepEqual(ids({ types: ['salon', 'other'] }), [c.id, b.id]);
  assert.deepEqual(ids({ status: 'waiting' }), [a.id]); assert.deepEqual(ids({ since: T0 + 1500 }), [c.id]);
  assert.deepEqual(ids({ q: 'mary' }), [b.id]); assert.deepEqual(ids({ q: '0788111222' }), [b.id]); assert.deepEqual(ids({ q: 'premio' }), [a.id]); assert.deepEqual(ids({ q: a.no.toLowerCase() }), [a.id]);
  assert.deepEqual(ids({ limit: 1 }), [c.id]);
  assert.equal(toPlain(s.ctx.svcGetJob(b.id)).id, b.id); assert.equal(s.ctx.svcGetJob('zzz'), null);
  assert.equal(toPlain(s.ctx.svcAllJobsView({ types: 'other' })).length, 1);
  const h = toPlain(s.ctx.svcCustomerHistory('+254 712 345 678'));
  assert.equal(h.jobs.length, 1); assert.equal(h.jobs[0].services, 'Full Wash'); assert.equal(h.totalBilled, 1500); assert.equal(h.outstanding, 1500); assert.equal(h.assets.length, 1);
});

test('sync hooks: collect sends only non-empty lists; apply replaces a list only when the pull carries it, heals derived fields, persists, emits', () => {
  const s = makeStore();
  assert.deepEqual(toPlain(s.ctx.svcSyncCollect()), {}, 'a shop with no engine data sends nothing new');
  const j = s.ctx.svcJobCreate('car_wash', CW()).job;
  const c = toPlain(s.ctx.svcSyncCollect());
  assert.deepEqual(Object.keys(c).sort(), ['svcAssets', 'svcJobs']); assert.equal(c.svcJobs[0].id, j.id);
  // apply: a pull without svc keys changes nothing (mixed releases, older servers)
  assert.equal(s.ctx.svcSyncApply({ inventory: [] }), false); assert.equal(s.jobs().length, 1);
  assert.equal(s.ctx.svcSyncApply({ svcJobs: 'nope' }), false);
  // apply: stale derived fields are re-derived; closed wins over a later "reopening" entry (union of two devices' histories)
  const srv = toPlain(s.jobs()[0]);
  srv.statusHistory.push({ id: 'h-a', s: 'in_progress', from: 'waiting', at: T0 + 10, p: 1, by: 'A', byId: 'a' }, { id: 'h-b', s: 'completed', from: 'ready', at: T0 + 20, p: 3, by: 'B', byId: 'b' }, { id: 'h-c', s: 'in_progress', from: 'waiting', at: T0 + 50, p: 1, by: 'C', byId: 'c' });
  srv.status = 'in_progress'; srv.phase = 1; srv.closedAt = null;
  s.events.length = 0;
  assert.equal(s.ctx.svcSyncApply({ svcJobs: [srv], svcConfig: [{ id: 'cfg-quote', kind: 'quote', value: { x: 1 }, updatedAt: 5 }] }), true);
  const f = s.job(j.id);
  assert.equal(f.status, 'completed'); assert.equal(f.phase, 3); assert.equal(f.closedAt, T0 + 20); assert.equal(f.completedAt, T0 + 20);
  assert.equal(toPlain(s.ev('svcAssets')).length, 1, 'svcAssets not in the pull: untouched');
  assert.equal(toPlain(s.ev('svcConfig')).length, 1); assert.equal(s.ls('pos_svc_config').length, 1, 'persisted');
  assert.ok(s.events.includes('render:home') && s.events.includes('config:changed'));
  assert.equal(s.ls('pos_svc_jobs')[0].status, 'completed');
  // a pull that carries [] for a list empties it (the server is authoritative once flushed)
  s.ctx.svcSyncApply({ svcJobs: [] }); assert.equal(s.jobs().length, 0);
  // heal one job
  s.ctx.svcSyncApply({ svcJobs: [srv] }); s.ctx.svcStFindIn(s.ev('svcJobs'), j.id).status = 'waiting'; assert.equal(s.ctx.svcHealJob(j.id), true); assert.equal(s.job(j.id).status, 'completed'); assert.equal(s.ctx.svcHealJob(j.id), false);
  assert.equal(s.ctx.svcHealJob('nope'), false);
});

test('config records: per-kind value + log ring, patch merges, unknown id refused', () => {
  const s = makeStore();
  assert.equal(s.ctx.svcConfigGet('cfg-notify'), null); assert.deepEqual(toPlain(s.ctx.svcConfigGet('cfg-notify', { d: 1 })), { d: 1 });
  assert.ok(s.ctx.svcConfigSet('cfg-notify', { autoSms: false, templates: { a: 'x' } }).ok);
  assert.ok(s.ctx.svcConfigPatch('cfg-notify', { autoSms: true }).ok);
  assert.deepEqual(toPlain(s.ctx.svcConfigGet('cfg-notify')), { autoSms: true, templates: { a: 'x' } });
  assert.ok(s.ctx.svcConfigSet('cfg-statuses-car_wash', { hidden: [] }).ok); assert.equal(toPlain(s.ctx.svcConfigRecord('cfg-statuses-car_wash')).type, 'car_wash');
  assert.equal(s.ctx.svcConfigSet('badid', {}).code, 'id');
  for (let i = 0; i < 40; i++) s.ctx.svcConfigPatch('cfg-notify', { n: i });
  assert.equal(toPlain(s.ctx.svcConfigRecord('cfg-notify')).log.length, 30);
  assert.equal(s.ctx.svcBizCfg(null).country, 'KE', 'svc-core reads config through svcConfigGet');
});

test('appointments view: legacy bookings are read-only shapes merged under engine appointments', () => {
  const s = makeStore({ bookings: [{ id: 'BK-1759-x', customerName: 'Ann', customerPhone: '0700111222', serviceCode: 'S1', staffId: 'st1', date: '2026-10-02', startTime: '10:00', endTime: '10:45', status: 'no-show', notes: 'late', createdAt: 1759000000000 }], inventory: [{ code: 'S1', name: 'Braids', type: 'service', price: 2500, durationMinutes: 45 }] });
  const v = toPlain(s.ctx.svcAllApptsView());
  assert.equal(v.length, 1); assert.equal(v[0].status, 'no_show'); assert.equal(v[0].services[0].name, 'Braids'); assert.equal(v[0].startAt, Date.parse('2026-10-02T10:00:00+03:00')); assert.equal(v[0].durationMin, 45); assert.equal(v[0]._legacy, true);
  assert.throws(() => { 'use strict'; s.ctx.svcAllApptsView()[0].status = 'x'; }, TypeError, 'frozen view');
  assert.equal(s.ctx.svcCommit('svcAppointments', s.ctx.svcAllApptsView()[0]).code, 'legacy');
});

// -------------------------------------------------------------------------------------------------------------------------------------------------
// static guard: lists are written only through svcCommit (and svcLoad / svcSyncApply / the archive + heal helpers of this block)
// -------------------------------------------------------------------------------------------------------------------------------------------------
test('static: no svc block writes a svc list outside the store\'s commit / load / sync-apply / archive functions', () => {
  const dir = path.join(ROOT, 'src/shared/blocks');
  const names = fs.readdirSync(dir).filter((f) => /^svc-.*\.html$/.test(f));
  const re = /\b(svcJobs|svcAssets|svcCatalog|svcAppointments|svcConfig)\s*(?:=(?!=)|\.(?:push|splice|pop|shift|unshift|sort|reverse|length\s*=)\b)/g;
  const ALLOWED = new Set(['svcStSetList', 'svcStCommitRec', 'svcArchiveLocal']);   // the only functions that touch the arrays; svcStSetList is what svcLoad / svcSyncApply call
  const bad = [];
  for (const f of names) {
    const scripts = blockScripts(f.replace(/\.html$/, ''));
    for (const code of scripts) {
      // split into top-level function bodies roughly by "\nfunction name("
      const parts = code.split(/\n(?=function\s+[A-Za-z_$][\w$]*\s*\()/);
      for (const part of parts) {
        const fn = (/^function\s+([A-Za-z_$][\w$]*)/.exec(part) || [])[1] || '(top level)';
        let m; re.lastIndex = 0;
        while ((m = re.exec(part))) {
          const line = part.slice(Math.max(0, part.lastIndexOf('\n', m.index)), part.indexOf('\n', m.index)).trim();
          if (/^(let|var|const)\s/.test(line) && fn === '(top level)') continue;      // the declarations themselves
          if (/^\/\*|^\/\//.test(line)) continue;
          if (f === 'svc-store.html' && ALLOWED.has(fn)) continue;
          if (/\.length\s*=/.test(line) === false && /^\s*(?:return|if|for|while)?/.test(line) && /\bsvc\w+\s*\.(?:filter|map|forEach|slice|concat)/.test(line)) continue;
          bad.push(`${f}:${fn}: ${line.slice(0, 90)}`);
        }
      }
    }
  }
  assert.deepEqual(bad, []);
});

// -------------------------------------------------------------------------------------------------------------------------------------------------
// integration with the REAL svc-core / svc-templates / svc-form blocks (skipped until the templates have landed)
// -------------------------------------------------------------------------------------------------------------------------------------------------
const realTemplates = blockScripts('svc-templates').join('').includes('SVC_TYPES');
test('integration with the real blocks: every template can create a job and walk initial -> closed; the type switch leaves old jobs alone', { skip: !realTemplates && 'svc-templates has not landed yet' }, () => {
  const win = { __svcNow: T0 };
  const ctx = loadSvc(['svc-core', 'svc-templates'], { window: win, queuePush() {}, currentServer: null });
  if (blockScripts('svc-form').join('').includes('svcValidate')) blockScripts('svc-form').forEach((js) => vm.runInContext(js, ctx));
  blockScripts('svc-store').forEach((js) => vm.runInContext(js, ctx));
  const order = toPlain(ctx.SVC_TYPE_ORDER);
  assert.equal(order.length, 10);
  const made = {};
  for (const t of order) {
    win.__svcNow += 1000;
    const r = ctx.svcJobCreate(t, { customer: { name: 'Jane Wanjiru', phone: '0712 345 678' }, services: [{ name: 'Svc', price: 500 }], staffIds: ['st-1'] });
    assert.ok(r.ok, t + ' ' + JSON.stringify(r));
    made[t] = r.job.id;
    assert.equal(r.job.serviceType, t); assert.equal(r.job.templateVersion, ctx.svcGetTemplate(t).version);
    assert.equal(r.job.status, ctx.svcGetTemplate(t).initialStatus, t + ' starts in the template initial status');
    // walk forward through the first allowed non-cancel move until closed
    let guard = 0, cur = ctx.svcGetJob(r.job.id);
    while (cur.phase < 3 && guard++ < 14) {
      const nx = toPlain(ctx.svcAllowedNext(cur)).filter((k) => ctx.svcStPhaseOf(t, k) < 4);
      const pick = nx.find((k) => ctx.svcStPhaseOf(t, k) > cur.phase) || nx[0];
      assert.ok(pick, `${t}: no way forward from ${cur.status}`);
      win.__svcNow += 1000;
      const m = ctx.svcJobSetStatus(cur.id, pick, { force: true, note: 'walk' });
      assert.ok(m.ok, `${t} ${cur.status}->${pick}: ${JSON.stringify(m)}`);
      cur = ctx.svcGetJob(cur.id);
    }
    assert.equal(cur.phase >= 3, true, t + ' reaches a closed status'); assert.ok(cur.closedAt);
  }
  const before = JSON.stringify(ctx.svcJobs);
  assert.ok(ctx.svcSetBusinessType('salon', { source: 'settings', alsoOffer: ['barber'] }).ok);
  assert.deepEqual(toPlain(ctx.svcConfigGet('cfg-business').enabledTypes), ['salon', 'barber']);
  assert.equal(JSON.stringify(ctx.svcJobs), before, 'switching to salon rewrote no job');
  assert.equal(ctx.svcAllowedNext(ctx.svcGetJob(made.car_wash)).length >= 0, true);
});
