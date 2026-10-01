// B1-D: two real tills (services/index.html in jsdom) against the REAL pos-sync function over a fake KV (tests/e2e-harness.mjs).
// The Services engine lists are merged per record by the server; hot arrays inside a job are unioned by element id; closed jobs are never reopened;
// tombstones win over stale copies; an offline-created job survives a pull; legacy lists still behave as before. (SERVICES_ARCHITECTURE.md 3.4, 3.5, 3.10)
// One jsdom boot is ~2 s and 3 MB of heap: every device is closed at the end of its test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';

const APP = 'services/index.html';
const J = (dev, code) => JSON.parse(dev.w.eval(`JSON.stringify(${code})`));
const quiet = (dev) => { dev.w.eval("showToast = function () {}; window.confirm = function () { return true; }"); return dev; };
const settle = async (dev) => { await dev.w.eval('flushThenPull()'); };
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(50); } return false; };
const jobs = (dev) => J(dev, 'svcAllJobs({ includeLegacy: false, includeDeleted: true })');
const live = (dev) => J(dev, 'svcAllJobs({ includeLegacy: false })');
const get = (dev, id) => J(dev, `svcGetJob(${JSON.stringify(id)})`);
const newDevice = async (s, storage = {}) => quiet(await openDevice(APP, s, storage, 2500));
const create = (dev, o = {}) => J(dev, `(function () { var r = svcJobCreate('car_wash', ${JSON.stringify({ customer: { name: 'John Kamau', phone: '0712345678' }, asset: { kind: 'vehicle', attrs: { plate: 'KDA 123A', make: 'Toyota', model: 'Premio' } }, services: [{ name: 'Full Wash', price: 1500 }], ...o })}); return { ok: r.ok, id: r.job && r.job.id, code: r.code }; })()`);
const mutate = (dev, id, body, audit = 'edited') => J(dev, `(function () { var r = svcCommit(function (j) { ${body}; return j; }, { list: 'svcJobs', id: ${JSON.stringify(id)}, audit: { act: ${JSON.stringify(audit)} } }); return { ok: r.ok, code: r.code }; })()`);
const PAY = (id, amount) => `j.payments.push({ id: '${id}', at: Date.now(), amount: ${amount}, method: 'cash', kind: 'deposit', rev: 0 })`;
const CHG = (id, amount) => `j.charges.push({ id: '${id}', kind: 'additional', label: 'Heavy dirt', amount: ${amount}, reason: 'mud', at: Date.now(), approved: true, rev: 0 })`;

test('the page carries the engine: real templates + store are loaded', async () => {
  const s = makeServer(); const a = await newDevice(s);
  try {
    assert.equal(a.w.eval("typeof svcJobCreate + typeof svcSyncCollect + typeof svcSyncApply + typeof SVC_TYPES"), 'functionfunctionfunctionobject');
    assert.equal(a.w.eval('svcClassicMode()'), true);
  } finally { a.close(); }
});

test('two tills create jobs at the same moment: both jobs, both customers and the shared vehicle survive on both tills and on the server', { timeout: 180000 }, async () => {
  const s = makeServer();
  const a = await newDevice(s), b = await newDevice(s);
  try {
    const ja = create(a, { customer: { name: 'John Kamau', phone: '0712345678' } });
    const jb = create(b, { customer: { name: 'Mary Njeri', phone: '0733000111' }, services: [{ name: 'Interior', price: 800 }] });
    assert.ok(ja.ok && jb.ok); assert.notEqual(ja.id, jb.id);
    const noA = get(a, ja.id).no, noB = get(b, jb.id).no;
    assert.match(noA, /^CW-\d{6}-[TD]\w+-\d{3}$/); assert.notEqual(noA, noB, 'job numbers differ across tills (device segment)');
    await a.w.eval('pushNow()'); await b.w.eval('pushNow()');
    await settle(a); await settle(b);
    for (const d of [a, b]) {
      assert.deepEqual(live(d).map((j) => j.id).sort(), [ja.id, jb.id].sort(), 'both jobs on both tills');
      assert.equal(J(d, 'svcAssets.length'), 1, 'same plate = one vehicle record (deterministic id) on both');
      assert.equal(J(d, "svcAssets[0].id"), 'sa-vehicle-KDA123A');
    }
    const st = s.serverState();
    assert.equal(st.svcJobs.length, 2); assert.equal(st.svcAssets.length, 1);
    assert.deepEqual(st.customers.map((c) => c.id).sort(), ['cu-712345678', 'cu-733000111'], 'customers merged by id');
    // the vehicle's history ring has both visits (unioned by job id)
    const hist = J(a, 'svcAssets[0].history').map((h) => h.id).sort();
    assert.deepEqual(hist, [ja.id, jb.id].sort());
  } finally { a.close(); b.close(); }
});

test('two tills add to the SAME job at once: charges, payments and status entries of both survive (nested append-only union), in every order', { timeout: 180000 }, async () => {
  const s = makeServer();
  const a = await newDevice(s);
  const j = create(a); await a.w.eval('pushNow()');
  const b = await newDevice(s); await settle(b);
  assert.equal(get(b, j.id).id, j.id, 'B has the job');
  try {
    // A: a charge + moves to in_progress.  B (not synced yet): a payment + a note + a different charge
    assert.ok(mutate(a, j.id, CHG('chg-a', 300), 'charge.add').ok);
    assert.ok(J(a, `svcJobSetStatus(${JSON.stringify(j.id)}, 'in_progress', { force: true, note: 'A starts' }).ok`));
    assert.ok(mutate(b, j.id, PAY('pay-b', 500), 'payment').ok);
    assert.ok(mutate(b, j.id, CHG('chg-b', 100) + "; j.notes = 'customer waiting'", 'charge.add').ok);
    await b.w.eval('pushNow()'); await a.w.eval('pushNow()');        // B's copy first, then A's (A's updatedAt is older for the scalar fields)
    await settle(a); await settle(b);
    for (const d of [a, b]) {
      const f = get(d, j.id);
      assert.deepEqual(f.charges.map((c) => c.id).sort(), ['chg-a', 'chg-b'], 'both charges');
      assert.deepEqual(f.payments.map((p) => p.id), ['pay-b']);
      assert.ok(f.statusHistory.some((h) => h.s === 'in_progress' && h.note === 'A starts'), 'A\'s status entry');
      assert.equal(f.status, 'in_progress', 'derived status follows the union');
      assert.ok(f.audit.some((x) => x.act === 'charge.add') && f.audit.some((x) => x.act === 'payment'), 'audit rows of both');
      const t = J(d, `svcTotals(svcGetJob(${JSON.stringify(j.id)}))`);
      assert.deepEqual([t.total, t.paid, t.balance], [1500 + 300 + 100, 500, 1400], 'money recomputed from the merged arrays');
    }
    assert.deepEqual(get(a, j.id).statusHistory.map((h) => h.id).sort(), get(b, j.id).statusHistory.map((h) => h.id).sort(), 'identical history on both');
    // the other order (A first, then B) on a second round
    assert.ok(mutate(a, j.id, PAY('pay-a2', 200), 'payment').ok); assert.ok(mutate(b, j.id, CHG('chg-b2', 50), 'charge.add').ok);
    await a.w.eval('pushNow()'); await b.w.eval('pushNow()'); await settle(a); await settle(b);
    for (const d of [a, b]) { const f = get(d, j.id); assert.deepEqual(f.payments.map((p) => p.id).sort(), ['pay-a2', 'pay-b']); assert.deepEqual(f.charges.map((c) => c.id).sort(), ['chg-a', 'chg-b', 'chg-b2']); }
    assert.equal(s.serverState().svcJobs[0].payments.length, 2);
  } finally { a.close(); b.close(); }
});

test('a closed job is never reopened: a stale till that moves it backwards loses, on the server and on every till', { timeout: 180000 }, async () => {
  const s = makeServer();
  const a = await newDevice(s);
  const j = create(a);
  assert.ok(J(a, `svcJobSetStatus(${JSON.stringify(j.id)}, 'in_progress', { force: true, note: 'go' }).ok`)); assert.ok(J(a, `svcJobSetStatus(${JSON.stringify(j.id)}, 'ready').ok`));
  await a.w.eval('pushNow()');
  const b = await newDevice(s); await settle(b);
  assert.equal(get(b, j.id).status, 'ready');
  try {
    assert.ok(J(a, `svcJobSetStatus(${JSON.stringify(j.id)}, 'completed').ok`)); assert.equal(get(a, j.id).phase, 3);
    await a.w.eval('pushNow()');
    await sleep(25);
    // B never saw the completion: it sends the job back to work LATER than A closed it (newer updatedAt, newer status entry)
    assert.ok(J(b, `svcJobSetStatus(${JSON.stringify(j.id)}, 'in_progress').ok`), 'allowed on B: its copy is only "ready"');
    assert.equal(get(b, j.id).status, 'in_progress');
    await b.w.eval('pushNow()');
    const srv = s.serverState().svcJobs.find((x) => x.id === j.id);
    assert.equal(srv.phase, 3, 'server: the further-along (closed) record decides'); assert.equal(srv.status, 'completed');
    assert.ok(srv.statusHistory.some((h) => h.s === 'in_progress' && h.by), 'B\'s entry is kept in the history (nothing is lost)');
    await settle(a); await settle(b);
    for (const d of [a, b]) { const f = get(d, j.id); assert.deepEqual([f.status, f.phase], ['completed', 3], 'closed on every till'); assert.ok(f.closedAt); assert.ok(f.completedAt); }
    assert.equal(get(a, j.id).closedAt, get(b, j.id).closedAt, 'closedAt converges');
    // and a till cannot even try once it has pulled
    assert.equal(J(b, `svcJobSetStatus(${JSON.stringify(j.id)}, 'in_progress', { force: true, note: 'x' }).code`), 'closed');
  } finally { a.close(); b.close(); }
});

test('tombstones: a deleted job stays deleted on every till, a stale till cannot bring it back, a refresh and a brand-new device never see it', { timeout: 240000 }, async () => {
  const s = makeServer();
  const a = await newDevice(s);
  const keep = create(a, { customer: { name: 'Keep', phone: '0700000001' }, asset: { kind: 'vehicle', attrs: { plate: 'KCA 001A' } } }), gone = create(a, { customer: { name: 'Gone', phone: '0700000002' }, asset: { kind: 'vehicle', attrs: { plate: 'KCA 002B' } } });
  await a.w.eval('pushNow()');
  const b = await newDevice(s); await settle(b);
  const stale = await newDevice(s, deviceStorage(b.w)); await settle(stale);
  assert.equal(live(b).length, 2);
  try {
    assert.ok(J(a, `svcJobDelete(${JSON.stringify(gone.id)}, { reason: 'entered by mistake' }).ok`));
    await a.w.eval('pushNow()');
    assert.ok(await until(() => /"_deleted":true/.test(JSON.stringify(s.serverState().svcJobs))), 'the server holds the tombstone');
    await settle(b);
    assert.deepEqual(live(b).map((x) => x.id), [keep.id], 'gone on the other till');
    // the stale till edits the deleted job (its newer updatedAt must not resurrect it) and pushes
    assert.ok(mutate(stale, gone.id, "j.notes = 'edited after delete'").ok);
    await stale.w.eval('pushNow()');
    assert.match(JSON.stringify(s.serverState().svcJobs), /"_deleted":true/, 'still deleted on the server');
    const pulled = await (await s.fetch('https://shop.mydukapos.store/api/pos-sync')).json();
    assert.deepEqual(pulled.svcJobs.map((x) => x.id), [keep.id], 'devices are never sent the tombstone');
    await settle(a); await settle(stale);
    assert.deepEqual(live(a).map((x) => x.id), [keep.id]); assert.deepEqual(live(stale).map((x) => x.id), [keep.id], 'the stale till is cleaned by its pull');
    const a2 = await newDevice(s, deviceStorage(a.w)); await settle(a2);
    assert.deepEqual(live(a2).map((x) => x.id), [keep.id], 'gone after a refresh');
    const fresh = await newDevice(s); await settle(fresh);
    assert.deepEqual(live(fresh).map((x) => x.id), [keep.id], 'a brand-new device never sees it');
    a2.close(); fresh.close();
  } finally { a.close(); b.close(); stale.close(); }
});

test('offline first: a job created while the server is unreachable survives a pull of a server copy that lacks it, and reaches the server afterwards', { timeout: 180000 }, async () => {
  const s = makeServer();
  const a = await newDevice(s), b = await newDevice(s);
  try {
    s.state.down = true;
    const mine = create(a, { customer: { name: 'Offline', phone: '0700000008' }, asset: { kind: 'vehicle', attrs: { plate: 'KCB 008Y' } } });
    assert.ok(mine.ok);
    assert.ok(J(a, `svcJobSetStatus(${JSON.stringify(mine.id)}, 'in_progress', { force: true, note: 'offline work' }).ok`));
    assert.equal(live(a).length, 1, 'works offline');
    const raw = a.w.localStorage.getItem('pos_svc_jobs'); assert.ok(raw && raw.includes(mine.id), 'persisted locally');
    s.state.down = false;
    const other = create(b, { customer: { name: 'Other', phone: '0700000009' }, asset: { kind: 'vehicle', attrs: { plate: 'KCB 009Z' } } });
    await b.w.eval('pushNow()');
    assert.equal(s.serverState().svcJobs.length, 1, 'the server copy has the other till\'s job only');
    await a.w.eval('pullState()');            // a plain pull (no explicit flush): the app flushes unsynced work before applying a server copy
    assert.ok(live(a).some((x) => x.id === mine.id), 'my job survived the pull');
    await settle(a);
    assert.deepEqual(live(a).map((x) => x.id).sort(), [mine.id, other.id].sort(), 'and I got the other till\'s');
    assert.ok(await until(() => s.serverState().svcJobs && s.serverState().svcJobs.length === 2), 'reached the server');
    assert.equal(s.serverState().svcJobs.find((x) => x.id === mine.id).status, 'in_progress');
    const a2 = await newDevice(s, deviceStorage(a.w)); await settle(a2);
    assert.deepEqual(live(a2).map((x) => x.id).sort(), [mine.id, other.id].sort(), 'a refresh loses nothing'); a2.close();
  } finally { s.state.down = false; a.close(); b.close(); }
});

test('the legacy lists keep syncing as before (whole value) next to the engine lists, and the engine never touches them', { timeout: 180000 }, async () => {
  const s = makeServer();
  const a = await newDevice(s);
  try {
    a.w.eval("serviceJobs.push({ id: 'JOB-T1-AAA', createdAt: new Date().toISOString(), clientName: 'Legacy Ann', clientPhone: '0711000111', idNumber: '', itemDetails: 'Nokia 3310', servicesRequired: [], serviceNotes: '', quoteAmount: 0, promisedPickup: '', status: 'pending', components: [], laborFee: 0, finalAmount: null, saleId: null }); safeSetItem('pos_service_jobs', JSON.stringify(serviceJobs)); queuePush();");
    const j = create(a);
    await a.w.eval('pushNow()');
    const st = s.serverState();
    assert.deepEqual(st.serviceJobs.map((x) => x.id), ['JOB-T1-AAA']); assert.deepEqual(st.svcJobs.map((x) => x.id), [j.id]);
    const b = await newDevice(s); await settle(b);
    try {
      assert.equal(J(b, 'serviceJobs.length'), 1); assert.equal(J(b, "svcAllJobs().length"), 2, 'merged view on the new till: 1 engine + 1 legacy');
      assert.equal(J(b, 'svcAllJobs().filter(function (x) { return x._legacy; }).length'), 1);
      // the old screen on B changes the legacy row; A gets it (whole-value sync of the legacy list, unchanged behaviour)
      b.w.eval("setJobStatusQuick('JOB-T1-AAA', 'ready')"); await b.w.eval('pushNow()'); await settle(a);
      assert.equal(J(a, "svcGetJob('JOB-T1-AAA').status"), 'ready'); assert.equal(J(a, "serviceJobs[0].status"), 'ready');
      assert.equal(J(a, 'svcAllJobs({includeLegacy:false}).length'), 1, 'engine list unaffected by the legacy change');
    } finally { b.close(); }
  } finally { a.close(); }
});

test('svcConfig merges per record: two admins editing different kinds at once keep both; the business type chosen on one till reaches the other (engine mode, config:changed fired)', { timeout: 180000 }, async () => {
  const s = makeServer();
  const a = await newDevice(s), b = await newDevice(s);
  try {
    b.w.eval("window.__cfgEvents = 0; svcOn('config:changed', function () { window.__cfgEvents++; })");
    assert.equal(b.w.eval('svcClassicMode()'), true);
    assert.ok(J(a, "svcSetBusinessType('car_wash', { source: 'settings' }).ok"));
    assert.ok(J(a, "svcConfigSet('cfg-notify', { autoSms: false, templates: { 'car_wash.ready.wa': 'Hello {first_name}' } }).ok"));
    assert.ok(J(b, "svcConfigSet('cfg-quote', { perType: { garage: { requireApproval: true } } }).ok"));
    await a.w.eval('pushNow()'); await b.w.eval('pushNow()'); await settle(a); await settle(b);
    for (const d of [a, b]) {
      assert.deepEqual(J(d, 'svcConfig.map(function (r) { return r.id; }).filter(function (i) { return i !== "cfg-seed"; }).sort()'), ['cfg-business', 'cfg-notify', 'cfg-quote'], 'all three records on both tills');
      assert.equal(J(d, 'svcBusinessType()'), 'car_wash'); assert.equal(J(d, 'svcClassicMode()'), false);
    }
    assert.ok(b.w.eval('window.__cfgEvents') >= 1, 'the open screens are told the config changed');
    assert.equal(J(b, "svcConfigGet('cfg-business').chosen"), true); assert.equal(J(b, "svcConfigGet('cfg-quote').perType.garage.requireApproval"), true);
    // newest record wins when the SAME kind is edited on both
    await sleep(20);
    assert.ok(J(a, "svcConfigPatch('cfg-notify', { autoSms: true }).ok")); await sleep(20);
    assert.ok(J(b, "svcConfigPatch('cfg-notify', { autoSms: false, extra: 1 }).ok"));
    await a.w.eval('pushNow()'); await b.w.eval('pushNow()'); await settle(a); await settle(b);
    assert.equal(J(a, "svcConfigGet('cfg-notify').extra"), 1); assert.equal(J(b, "svcConfigGet('cfg-notify').extra"), 1);
  } finally { a.close(); b.close(); }
});

test('the vehicle asset keeps ownerHistory and visit history of both tills (unioned by element id); a refresh and a new device see the same data', { timeout: 180000 }, async () => {
  const s = makeServer();
  const a = await newDevice(s), b = await newDevice(s);
  try {
    const j1 = create(a, { customer: { name: 'John', phone: '0712345678' } });
    const j2 = create(b, { customer: { name: 'Peter', phone: '0733555777' }, services: [{ name: 'Interior', price: 800 }] });     // same plate, other owner, at the same time
    await a.w.eval('pushNow()'); await b.w.eval('pushNow()'); await settle(a); await settle(b);
    for (const d of [a, b]) {
      assert.equal(J(d, 'svcAssets.length'), 1);
      assert.deepEqual(J(d, 'svcAssets[0].history').map((h) => h.id).sort(), [j1.id, j2.id].sort(), 'visit ring unioned');
    }
    const fresh = await newDevice(s); await settle(fresh);
    try {
      assert.equal(J(fresh, 'svcAllJobs().length'), 2);
      assert.equal(J(fresh, "svcAssetHistory('sa-vehicle-KDA123A').length"), 2);
      assert.deepEqual(J(fresh, "svcAssetHistory('sa-vehicle-KDA123A').map(function (v) { return v.services; }).sort()"), ['Full Wash', 'Interior']);
    } finally { fresh.close(); }
  } finally { a.close(); b.close(); }
});

test('switch safety across tills: a till that changes the business type does not rewrite any job on any other till', { timeout: 180000 }, async () => {
  const s = makeServer();
  const a = await newDevice(s);
  try {
    const p = J(a, `(function () { var r = svcJobCreate('phone_repair', { customer: { name: 'P', phone: '0700123456' }, asset: { kind: 'phone', attrs: { brand: 'Apple', model: 'iPhone 11', imei: '356789012345678' } } }); return { id: r.job.id }; })()`);
    await a.w.eval('pushNow()');
    const b = await newDevice(s); await settle(b);
    try {
      const before = JSON.stringify(jobs(b));
      assert.ok(J(a, "svcSetBusinessType('salon', { source: 'settings' }).ok")); await a.w.eval('pushNow()'); await settle(b);
      assert.equal(J(b, 'svcBusinessType()'), 'salon');
      assert.equal(JSON.stringify(jobs(b)), before, 'the phone-repair job on B is byte-identical');
      assert.equal(get(b, p.id).serviceType, 'phone_repair');
      const w = create(b, {}); assert.ok(w.ok);
      const nw = J(b, `svcJobCreate(undefined, { customer: { name: 'New', phone: '0700987654' } }).job.serviceType`); assert.equal(nw, 'salon');
    } finally { b.close(); }
  } finally { a.close(); }
});
