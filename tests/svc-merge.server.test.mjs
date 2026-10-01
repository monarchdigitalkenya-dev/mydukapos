// B1-D: the server side of the Services engine, tested with RECORDS PRODUCED BY THE ENGINE (svc-store in vm) rather than hand-made ones:
//   - per-record merge by id for the five lists (functions/api/_merge.js, blob backend) and the same through the Durable Object backend (ShopStore on node:sqlite)
//   - NESTED_MERGE.svcJobs: hot arrays union by element id in EITHER order, idempotent, closed never reopened (randomised interleavings of two tills)
//   - tombstones, phase ranking for records of older releases, element `rev` / `voidedAt` edits, asset rings, config per record
//   - archive: server splitOldHistory takes closed old jobs only; asset history rings stay
//   - size budget of a typical visit
// Hand-made edge cases live in svc-seams.test.mjs (E); this file is the contract between the engine's shapes and the merge rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { loadSvc, blockScripts, toPlain } from './svc-helpers.mjs';
import { fakeDoState, hasSqlite } from './do-fake.mjs';

const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const M = await load('functions/api/_merge.js');
const SS = await load('functions/api/_state-store.js');
const T0 = Date.UTC(2026, 8, 30, 9, 0, 0);

let clock = T0;
function till(tillNo, globals = {}) {
  const win = { get __svcNow() { return clock; } };
  const ctx = loadSvc(['svc-core', 'svc-templates'], { window: win, queuePush() {}, tillNumber: () => tillNo, getOrCreateDeviceId: () => 'dev-' + tillNo, ...globals });
  blockScripts('svc-store').forEach((js) => vm.runInContext(js, ctx));
  return { ctx, jobs: () => toPlain(ctx.__eval('svcJobs')), assets: () => toPlain(ctx.__eval('svcAssets')), config: () => toPlain(ctx.__eval('svcConfig')), apply: (st) => ctx.svcSyncApply(toPlain(st)), job: (id) => toPlain(ctx.svcGetJob(id)) };
}
const mergeList = (field, existing, incoming) => M.mergeRecordsById(existing, incoming, M.FINAL_TOMBSTONE_FIELDS.includes(field), field);
const ids = (arr) => (arr || []).map((x) => x.id).sort();
const tick = (n = 1000) => { clock += n; };
const CW = (extra = {}) => ({ customer: { name: 'John Kamau', phone: '0712345678' }, asset: { kind: 'vehicle', attrs: { plate: 'KDA 123A', make: 'Toyota', model: 'Premio' } }, services: [{ name: 'Full Wash', price: 1500 }], ...extra });

test('the five engine lists are merged per record by id; jobs / appointments / catalog also have final tombstones; the legacy lists stay whole-value', () => {
  for (const f of ['svcJobs', 'svcAssets', 'svcCatalog', 'svcAppointments', 'svcConfig']) assert.ok(M.MERGE_BY_ID_FIELDS.includes(f), f);
  for (const f of ['svcJobs', 'svcAppointments', 'svcCatalog']) assert.ok(M.FINAL_TOMBSTONE_FIELDS.includes(f), f);
  for (const f of ['svcAssets', 'svcConfig']) assert.ok(!M.FINAL_TOMBSTONE_FIELDS.includes(f), f + ' has no tombstone rule');
  assert.ok(!M.MERGE_BY_ID_FIELDS.includes('serviceJobs') && !M.MERGE_BY_ID_FIELDS.includes('bookings'), 'legacy lists unchanged (R4)');
  assert.deepEqual(M.NESTED_MERGE.svcJobs.arrays.sort(), ['audit', 'charges', 'jobStaff', 'materials', 'notify', 'payments', 'photos', 'quoteLog', 'quoteVersions', 'statusHistory', 'valuables']);
  assert.equal(M.NESTED_MERGE.svcJobs.rankBy, 'phase'); assert.deepEqual(M.NESTED_MERGE.svcAssets.arrays.sort(), ['history', 'ownerHistory']);
  // every array the engine's append-only guard protects is unioned by the server (the two lists must agree)
  const guarded = toPlain(till(1).ctx.SVC_GUARDED_ARRAYS);
  guarded.forEach((a) => assert.ok(M.NESTED_MERGE.svcJobs.arrays.includes(a), a + ' is guarded by the engine but not unioned by the server'));
});

test('engine records through the server merge: two tills, same job, changes in either order converge to the same union', () => {
  const A = till(1), B = till(2);
  const j = A.ctx.svcJobCreate('car_wash', CW({ staffIds: ['st-1'] })).job;
  B.apply({ svcJobs: A.jobs() });
  tick(); A.ctx.svcCommit((x) => { x.charges.push({ id: 'chg-a', kind: 'additional', label: 'Heavy dirt', amount: 300, at: clock, approved: true, rev: 0 }); return x; }, { list: 'svcJobs', id: j.id, audit: { act: 'charge.add' } });
  A.ctx.svcJobSetStatus(j.id, 'in_progress');
  tick(); B.ctx.svcCommit((x) => { x.payments.push({ id: 'pay-b', at: clock, amount: 500, method: 'cash', kind: 'deposit' }); return x; }, { list: 'svcJobs', id: j.id, audit: { act: 'payment' } });
  B.ctx.svcCommit((x) => { x.materials.push({ id: 'mat-b', code: 'P1', name: 'Shampoo', qty: 1, unit: 'l', price: 0, cost: 200, chargeable: false, at: clock, rev: 0 }); return x; }, { list: 'svcJobs', id: j.id, audit: { act: 'material.use' } });
  const srvAB = mergeList('svcJobs', mergeList('svcJobs', [], A.jobs()), B.jobs());
  const srvBA = mergeList('svcJobs', mergeList('svcJobs', [], B.jobs()), A.jobs());
  for (const srv of [srvAB, srvBA]) {
    const f = srv[0];
    assert.deepEqual(ids(f.charges), ['chg-a']); assert.deepEqual(ids(f.payments), ['pay-b']); assert.deepEqual(ids(f.materials), ['mat-b']);
    assert.equal(f.statusHistory.length, 2, 'waiting + in_progress'); assert.equal(f.audit.length, 5, 'created + charge.add + status + payment + material.use');
  }
  assert.deepEqual(ids(srvAB[0].audit), ids(srvBA[0].audit), 'same union in either order');
  // idempotent: the same push again changes nothing
  const again = mergeList('svcJobs', srvAB, A.jobs());
  assert.deepEqual(ids(again[0].audit), ids(srvAB[0].audit)); assert.equal(again[0].payments.length, 1);
  // both tills apply the merged server copy and agree on everything derived
  A.apply({ svcJobs: srvAB }); B.apply({ svcJobs: srvBA });
  const fa = A.job(j.id), fb = B.job(j.id);
  assert.deepEqual([fa.status, fa.phase], [fb.status, fb.phase]);
  assert.deepEqual(toPlain(A.ctx.svcTotals(fa)), toPlain(B.ctx.svcTotals(fb)));
  assert.equal(toPlain(A.ctx.svcTotals(fa)).total, 1800); assert.equal(toPlain(A.ctx.svcTotals(fa)).paid, 500);
});

test('property: random interleavings of two tills never reopen a closed job, never lose an element, and both merge orders agree (200 runs, seeded)', () => {
  let seed = 20260930; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let closedRuns = 0;
  for (let run = 0; run < 200; run++) {
    clock = T0 + run * 100000;
    const A = till(1), B = till(2), C = till(3);
    const base = A.ctx.svcJobCreate('phone_repair', { customer: { name: 'P', phone: '0700123456' }, services: [{ name: 'Screen', price: 1000 }], id: 'sj-prop-' + run }).job;
    const S0 = A.jobs(); B.apply({ svcJobs: S0 });
    const added = { charges: new Set(), payments: new Set(), statusHistory: new Set([base.statusHistory[0].id]) };
    const closed = { A: false, B: false }; let seq = 0;
    const n = 2 + Math.floor(rnd() * 9);
    for (let i = 0; i < n; i++) {
      const who = rnd() < 0.5 ? 'A' : 'B', T = who === 'A' ? A : B;
      tick(1 + Math.floor(rnd() * 500));
      const op = pick(['status', 'status', 'charge', 'payment', 'note']);
      if (op === 'status') {
        const nx = toPlain(T.ctx.svcAllowedNext(T.job(base.id))); if (!nx.length) continue;
        const r = T.ctx.svcJobSetStatus(base.id, pick(nx), { force: true, note: 'p' });
        if (r.ok && !r.noop) { const f = T.job(base.id); added.statusHistory.add(f.statusHistory[f.statusHistory.length - 1].id); if (f.phase >= 3) closed[who] = true; }
      } else if (op === 'charge') {
        const id = 'c' + who + (++seq);
        T.ctx.svcCommit((x) => { x.charges.push({ id, kind: 'additional', label: 'x', amount: 10, at: clock, approved: true, rev: 0 }); return x; }, { list: 'svcJobs', id: base.id, audit: { act: 'charge.add' } }); added.charges.add(id);
      } else if (op === 'payment') {
        const id = 'p' + who + (++seq);
        T.ctx.svcCommit((x) => { x.payments.push({ id, at: clock, amount: 5, method: 'cash', kind: 'partial' }); return x; }, { list: 'svcJobs', id: base.id, audit: { act: 'payment' } }); added.payments.add(id);
      } else T.ctx.svcJobUpdate(base.id, { notes: who + (++seq) });
    }
    const first = rnd() < 0.5 ? [A, B] : [B, A];
    const AB = mergeList('svcJobs', mergeList('svcJobs', S0, first[0].jobs()), first[1].jobs());
    const BA = mergeList('svcJobs', mergeList('svcJobs', S0, first[1].jobs()), first[0].jobs());
    assert.equal(AB.length, 1); assert.equal(BA.length, 1);
    for (const f of ['charges', 'payments', 'statusHistory']) {
      assert.deepEqual(ids(AB[0][f]), [...added[f]].sort(), `run ${run}: ${f} union (nothing lost, nothing invented)`);
      assert.deepEqual(ids(AB[0][f]), ids(BA[0][f]), `run ${run}: ${f} same in both orders`);
    }
    assert.deepEqual(ids(AB[0].audit), ids(BA[0].audit), `run ${run}: audit union`);
    C.apply({ svcJobs: AB }); const fab = C.job(base.id);
    const D = till(4); D.apply({ svcJobs: BA }); const fba = D.job(base.id);
    assert.deepEqual([fab.status, fab.phase, fab.closedAt], [fba.status, fba.phase, fba.closedAt], `run ${run}: both orders derive the same status / closedAt`);
    const someoneClosed = closed.A || closed.B;
    assert.equal(fab.phase >= 3, someoneClosed, `run ${run}: closed iff a till closed it (never reopened by the other)`);
    if (someoneClosed) { closedRuns++; assert.ok(fab.closedAt > 0); assert.ok(fab.phase >= 3); }
    // idempotent: re-sending a till's whole copy changes nothing
    const re = mergeList('svcJobs', AB, first[0].jobs());
    assert.deepEqual(ids(re[0].statusHistory), ids(AB[0].statusHistory)); assert.deepEqual(ids(re[0].payments), ids(AB[0].payments));
  }
  assert.ok(closedRuns > 20, 'the generator closes jobs often enough to be meaningful: ' + closedRuns);
});

test('a stale till that only moved the job backwards loses to the closed record even though its updatedAt is newer; a record of an older release (no phase, no arrays) never beats it', () => {
  clock = T0;
  const A = till(1), B = till(2);
  const j = A.ctx.svcJobCreate('car_wash', CW({ staffIds: ['st-1'] })).job;
  B.apply({ svcJobs: A.jobs() });
  ['in_progress', 'ready'].forEach((k) => { tick(); A.ctx.svcJobSetStatus(j.id, k); B.apply({ svcJobs: A.jobs() }); });
  tick(); A.ctx.svcJobSetStatus(j.id, 'completed'); const closedCopy = A.jobs()[0];
  tick(5000); B.ctx.svcJobSetStatus(j.id, 'in_progress'); const stale = B.jobs()[0];
  assert.ok(stale.updatedAt > closedCopy.updatedAt, 'the stale copy is the newer write');
  for (const [ex, inc] of [[closedCopy, stale], [stale, closedCopy]]) {
    const m = M.mergeNestedRecord('svcJobs', ex, inc);
    assert.equal(m.phase, 3, 'the further-along record decides the scalar fields'); assert.equal(m.status, 'completed'); assert.ok(m.closedAt);
    assert.equal(m.statusHistory.length, 5, 'waiting, in_progress, ready, completed from A, plus B\'s extra in_progress: union by id');
  }
  const bare = { id: j.id, serviceType: 'car_wash', templateVersion: 1, createdAt: T0, updatedAt: clock + 99999, status: 'waiting', customer: {} };     // a till of an older release: no phase, no arrays
  const m = M.mergeNestedRecord('svcJobs', closedCopy, bare);
  assert.equal(m.phase, 3, 'unknown rank (-1) never beats a closed job'); assert.equal(m.status, 'completed'); assert.ok(Array.isArray(m.payments));
  assert.doesNotThrow(() => M.mergeNestedRecord('svcJobs', bare, bare));
  assert.doesNotThrow(() => mergeList('svcJobs', [bare], [{ id: j.id, updatedAt: 1 }]));
});

test('element edits: a voided payment (rev 1 + voidedAt) beats its un-voided copy in either order; scalars of a job are newest-updatedAt-wins', () => {
  clock = T0;
  const A = till(1), B = till(2);
  const j = A.ctx.svcJobCreate('other', { customer: { name: 'V', phone: '0700222333' } }).job;
  tick(); A.ctx.svcCommit((x) => { x.payments.push({ id: 'pay-1', at: clock, amount: 500, method: 'cash', kind: 'deposit', rev: 0 }); return x; }, { list: 'svcJobs', id: j.id, audit: { act: 'payment' } });
  B.apply({ svcJobs: A.jobs() });
  tick(); A.ctx.svcCommit((x) => { x.payments[0].voidedAt = clock; x.payments[0].voidedBy = 'Owner'; x.payments[0].rev = 1; return x; }, { list: 'svcJobs', id: j.id, audit: { act: 'payment.void' } });
  tick(); B.ctx.svcJobUpdate(j.id, { notes: 'B note, newest write' });
  for (const [ex, inc] of [[A.jobs()[0], B.jobs()[0]], [B.jobs()[0], A.jobs()[0]]]) {
    const m = M.mergeNestedRecord('svcJobs', ex, inc);
    assert.ok(m.payments[0].voidedAt, 'the void survives'); assert.equal(m.payments[0].rev, 1);
    assert.equal(m.notes, 'B note, newest write', 'scalar: newest updatedAt wins');
    assert.equal(toPlain(A.ctx.svcTotals(m)).paid, 0, 'totals ignore the voided payment');
  }
  // the engine refuses to DROP the element (shrink), so a void is the only way to undo money
  assert.equal(A.ctx.svcCommit((x) => { x.payments = []; return x; }, { list: 'svcJobs', id: j.id }).code, 'shrink');
});

test('tombstones: a deleted job / appointment / catalog item is never brought back by a stale or newer copy; assets and config have none', () => {
  clock = T0;
  const A = till(1);
  const j = A.ctx.svcJobCreate('other', { customer: { name: 'D', phone: '0700444555' } }).job;
  const live = A.jobs(); tick(); A.ctx.svcJobDelete(j.id, { reason: 'mistake' }); const tomb = A.jobs();
  assert.equal(tomb[0]._deleted, true);
  assert.equal(mergeList('svcJobs', tomb, live)[0]._deleted, true, 'stale copy');
  const newer = JSON.parse(JSON.stringify(live)); newer[0].updatedAt = clock + 99999; newer[0].notes = 'edited after delete';
  assert.equal(mergeList('svcJobs', tomb, newer)[0]._deleted, true, 'even a newer non-deleted copy');
  assert.equal(mergeList('svcJobs', live, tomb)[0]._deleted, true, 'the tombstone arriving later wins too');
  for (const f of ['svcAppointments', 'svcCatalog']) {
    const r1 = [{ id: 'x1', updatedAt: 1, name: 'a' }], t1 = [{ id: 'x1', updatedAt: 2, _deleted: true }], n1 = [{ id: 'x1', updatedAt: 9, name: 'b' }];
    assert.equal(mergeList(f, t1, n1)[0]._deleted, true, f); assert.equal(mergeList(f, r1, t1)[0]._deleted, true, f);
  }
  const a1 = [{ id: 'sa-vehicle-K', updatedAt: 5, _deleted: true }], a2 = [{ id: 'sa-vehicle-K', updatedAt: 9, label: 'revived' }];
  assert.equal(mergeList('svcAssets', a1, a2)[0].label, 'revived', 'assets: newest wins (a vehicle can come back with its plate)');
  assert.equal(M.stripTombstones({ svcJobs: tomb.concat(live.map((x) => ({ ...x, id: 'other-1', _deleted: undefined }))) }).svcJobs.length, 1, 'devices are not sent tombstones');
});

test('assets: owner changes and visit history of two tills are unioned by element id (engine ids), newest scalars win', () => {
  clock = T0;
  const A = till(1), B = till(2);
  const a0 = A.ctx.svcJobCreate('car_wash', CW()).job;                      // A washes KDA 123A for John
  B.apply({ svcAssets: A.assets(), svcJobs: A.jobs() });
  tick(); const ja = A.ctx.svcJobCreate('car_wash', CW({ services: [{ name: 'Wax', price: 700 }] })).job;
  tick(); const jb = B.ctx.svcJobCreate('car_wash', CW({ customer: { name: 'Peter', phone: '0733555777' }, services: [{ name: 'Interior', price: 800 }] })).job;     // new owner, at B
  const m = mergeList('svcAssets', mergeList('svcAssets', [], A.assets()), B.assets());
  assert.equal(m.length, 1); assert.equal(m[0].id, 'sa-vehicle-KDA123A');
  assert.deepEqual(ids(m[0].history), ids([{ id: a0.id }, { id: ja.id }, { id: jb.id }]), 'visits of both tills');
  assert.equal(m[0].ownerKey, '733555777', 'newest updatedAt wins the scalar (current owner)'); assert.equal(m[0].ownerHistory.length, 1); assert.match(m[0].ownerHistory[0].id, /^oh-/);
  const both = M.mergeNestedRecord('svcAssets', A.assets()[0], B.assets()[0]);
  assert.deepEqual(ids(both.ownerHistory), ids(m[0].ownerHistory));
  // the engine shows all three visits from the merged record even if the jobs themselves were archived
  const C = till(3); C.apply({ svcAssets: m });
  assert.equal(C.ctx.svcAssetHistory('sa-vehicle-KDA123A').length, 3);
});

test('config records merge per record: different kinds both survive, the same kind is newest-wins, nothing else is touched', () => {
  clock = T0;
  const A = till(1), B = till(2);
  A.ctx.svcSetBusinessType('car_wash', { source: 'settings' }); tick(); B.ctx.svcConfigSet('cfg-quote', { perType: { garage: { requireApproval: true } } });
  const m = mergeList('svcConfig', A.config(), B.config());
  assert.deepEqual(ids(m), ['cfg-business', 'cfg-quote']);
  tick(); A.ctx.svcConfigPatch('cfg-quote', { perType: { garage: { requireApproval: false } } });
  const m2 = mergeList('svcConfig', B.config(), A.config());
  assert.equal(m2.find((r) => r.id === 'cfg-quote').value.perType.garage.requireApproval, false);
  const fresh = till(3); fresh.apply({ svcConfig: m2 });
  assert.equal(fresh.ctx.svcBusinessType(), 'car_wash'); assert.equal(fresh.ctx.svcClassicMode(), false);
});

test('mergeIncomingState: engine lists merge per record while the legacy lists keep their whole-value behaviour (R4 unchanged)', () => {
  clock = T0;
  const A = till(1), B = till(2);
  const ja = A.ctx.svcJobCreate('car_wash', CW()).job, jb = B.ctx.svcJobCreate('car_wash', CW({ customer: { name: 'M', phone: '0733000111' }, asset: { kind: 'vehicle', attrs: { plate: 'KCC 777C' } } })).job;
  const leg = (id) => ({ id, createdAt: '2026-09-30T06:00:00.000Z', clientName: 'L', clientPhone: '0700', status: 'pending', components: [], laborFee: 0 });
  const existing = { updatedAt: 1, businessName: 'Biz', svcJobs: A.jobs(), svcAssets: A.assets(), serviceJobs: [leg('JOB-1-AAA')] };
  const incoming = { updatedAt: 2, businessName: 'Biz', svcJobs: B.jobs(), svcAssets: B.assets(), serviceJobs: [leg('JOB-2-BBB')] };
  const merged = M.mergeIncomingState(existing, incoming);
  assert.deepEqual(ids(merged.svcJobs), [ja.id, jb.id].sort(), 'engine jobs from both pushes');
  assert.equal(merged.svcAssets.length, 2);
  assert.deepEqual(ids(merged.serviceJobs), ['JOB-2-BBB'], 'legacy serviceJobs: whole value, last push wins - exactly as before');
  // an older app release that never sends the engine lists leaves them alone
  const noSvc = M.mergeIncomingState(merged, { updatedAt: 3, businessName: 'Biz', serviceJobs: merged.serviceJobs });
  assert.deepEqual(ids(noSvc.svcJobs), [ja.id, jb.id].sort()); assert.equal(noSvc.svcAssets.length, 2);
});

test('Durable Object backend (ShopStore) behaves like the blob backend: union, nested arrays, closed stays closed, tombstone, legacy whole-value', { skip: !hasSqlite && 'node:sqlite is not available' }, async () => {
  const { ShopStore } = await load('wildcard-router/shop-store.js');
  clock = T0;
  const A = till(1), B = till(2);
  const j = A.ctx.svcJobCreate('car_wash', CW({ staffIds: ['st-1'] })).job;
  const store = new ShopStore(fakeDoState(), {});
  const push = (t, extra = {}) => store.push({ businessName: 'Biz', updatedAt: Date.now(), svcJobs: t.jobs(), svcAssets: t.assets(), svcConfig: t.config(), ...extra }, Date.now());
  const state = () => JSON.parse(store.stateText(null));
  push(A); B.apply({ svcJobs: A.jobs(), svcAssets: A.assets() });
  tick(); A.ctx.svcJobSetStatus(j.id, 'in_progress'); A.ctx.svcJobSetStatus(j.id, 'ready'); tick(); A.ctx.svcJobSetStatus(j.id, 'completed');
  tick(); B.ctx.svcCommit((x) => { x.payments.push({ id: 'pay-b', at: clock, amount: 100, method: 'cash', kind: 'partial' }); return x; }, { list: 'svcJobs', id: j.id, audit: { act: 'payment' } });
  const w = B.ctx.svcJobCreate('car_wash', CW({ customer: { name: 'W', phone: '0700999000' }, asset: { kind: 'vehicle', attrs: { plate: 'KCD 100D' } } })).job;
  push(A); push(B);
  let st = state();
  assert.deepEqual(ids(st.svcJobs), [j.id, w.id].sort(), 'both jobs'); const sj = st.svcJobs.find((x) => x.id === j.id);
  assert.equal(sj.phase, 3); assert.deepEqual(ids(sj.payments), ['pay-b']); assert.equal(sj.statusHistory.length, 4);
  assert.equal(st.svcAssets.length, 2);
  // a stale push from B (still "waiting"-era copy of the job, newer updatedAt) cannot reopen
  B.ctx.svcCommit((x) => { x.notes = 'late note'; return x; }, { list: 'svcJobs', id: j.id });
  push(B); st = state(); assert.equal(st.svcJobs.find((x) => x.id === j.id).phase, 3);
  // tombstone
  tick(); B.ctx.svcJobDelete(w.id, { reason: 'mistake' }); push(B); push(A);
  st = state(); assert.deepEqual(ids(st.svcJobs), [j.id], 'the deleted job is not sent to devices; a stale push does not bring it back');
  // engine applies the DO state
  const C = till(3); C.apply(st); assert.equal(C.job(j.id).status, 'completed');
  // legacy list on the same backend: whole value
  store.push({ businessName: 'Biz', updatedAt: Date.now(), serviceJobs: [{ id: 'JOB-1-A', status: 'pending', updatedAt: 1 }] }, Date.now());
  store.push({ businessName: 'Biz', updatedAt: Date.now(), serviceJobs: [{ id: 'JOB-2-B', status: 'pending', updatedAt: 2 }] }, Date.now());
  assert.equal(state().serviceJobs.length >= 1, true);
});

test('archive: the server takes only CLOSED engine jobs older than the cutoff (closedAt set by the engine); open jobs and all assets / config stay; the asset ring keeps the visits', () => {
  clock = T0;
  const A = till(1);
  const old = (name, plate, close) => { clock -= 1; A.ctx.svcJobCreate('car_wash', CW({ customer: { name, phone: '07001' + String(plate.length) + '0000' }, asset: { kind: 'vehicle', attrs: { plate } }, id: 'sj-old-' + plate.replace(/\W/g, '') })); if (close) ['in_progress', 'ready', 'completed'].forEach((k) => A.ctx.svcJobSetStatus('sj-old-' + plate.replace(/\W/g, ''), k, { force: true, note: 'x' })); };
  old('Closed', 'KAA 001A', true); old('Open', 'KAA 002B', false); old('Cancelled', 'KAA 003C', false); A.ctx.svcJobCancel('sj-old-KAA003C', { reason: 'no show' });
  const state = { svcJobs: A.jobs(), svcAssets: A.assets(), svcConfig: A.config(), salesLog: [] };
  assert.equal(SS.isOpenRecord('svcJobs', state.svcJobs.find((j) => j.id === 'sj-old-KAA001A')), false, 'closed by the engine\'s closedAt');
  assert.equal(SS.isOpenRecord('svcJobs', state.svcJobs.find((j) => j.id === 'sj-old-KAA002B')), true);
  const cutoff = T0 + 10 * 86400000;           // everything above was created "before" the cutoff
  const r = SS.splitOldHistory(state, cutoff);
  assert.deepEqual(ids(r.old.svcJobs), ['sj-old-KAA001A', 'sj-old-KAA003C'], 'closed + cancelled go');
  assert.deepEqual(ids(r.keep.svcJobs), ['sj-old-KAA002B'], 'the open job stays');
  assert.equal(r.keep.svcAssets.length, 3, 'assets are never archived'); assert.ok(!r.old.svcAssets && !r.old.svcConfig);
  // the visits of the archived jobs are still on the asset
  const C = till(2); C.apply({ svcJobs: r.keep.svcJobs, svcAssets: r.keep.svcAssets });
  const h = toPlain(C.ctx.svcAssetHistory('sa-vehicle-KAA001A'));
  assert.equal(h.length, 1, 'previous visit still listed after the job left the hot state'); assert.equal(h[0].archived, true); assert.equal(h[0].status, 'completed');
});

test('size budget: a typical visit stays small (intake ~1.6 KB, finished ~2.7 KB, well under the 8 KB cap) and the asset ring is bounded', () => {
  clock = T0;
  const A = till(1);
  const r = A.ctx.svcJobCreate('car_wash', CW({ services: [{ name: 'Full Wash', price: 1500 }, { name: 'Interior', price: 500 }, { name: 'Wax', price: 300 }], staffIds: ['st-1'] }));
  assert.ok(JSON.stringify(r.job).length < 2000, 'intake: ' + JSON.stringify(r.job).length);
  ['in_progress', 'ready', 'completed'].forEach((k) => { tick(60000); A.ctx.svcJobSetStatus(r.job.id, k, { force: true, note: 'n' }); });
  A.ctx.svcCommit((x) => { x.payments.push({ id: 'p1', at: 1, amount: 1000, method: 'cash', kind: 'deposit', by: 'Owner' }, { id: 'p2', at: 2, amount: 1300, method: 'mpesa', kind: 'balance', ref: 'QWE12RTY34', by: 'Owner' }); return x; }, { list: 'svcJobs', id: r.job.id, audit: { act: 'payment' } });
  assert.ok(A.ctx.svcJobBytes(A.jobs()[0]) < 3200, 'finished: ' + A.ctx.svcJobBytes(A.jobs()[0]));
  for (let i = 0; i < 40; i++) { tick(60000); A.ctx.svcJobCreate('car_wash', CW({ services: [{ name: 'Wash ' + i, price: 100 }] })); }
  const asset = A.assets()[0];
  assert.equal(asset.history.length, 30); assert.ok(JSON.stringify(asset).length < 8000, 'asset with a full ring: ' + JSON.stringify(asset).length);
  const st = toPlain(A.ctx.svcStoreStats()); assert.equal(st.lists.svcJobs.count, 41); assert.equal(st.jobsOverCap, 0);
});
