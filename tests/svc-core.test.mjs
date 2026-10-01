// svc-core (B1-A): pure helpers of the Services engine. Loaded through tests/svc-helpers.mjs loadSvc (vm, no DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSvc, toPlain } from './svc-helpers.mjs';

const svc = (globals) => loadSvc(['svc-core', 'svc-templates'], globals);
const S = svc();

test('svcNormPhone: Kenyan forms normalise to the same number and key', () => {
  ['0712345678', '0712 345 678', '+254712345678', '254712345678', '712345678', '+254 712-345-678', '(0712) 345.678', '00254712345678', '2540712345678'].forEach((raw) => {
    const r = toPlain(S.svcNormPhone(raw));
    assert.equal(r.ok, true, raw);
    assert.equal(r.e164, '+254712345678', raw);
    assert.equal(r.national, '0712345678', raw);
    assert.equal(r.key, '712345678', raw);
    assert.equal(r.level, 'ok', raw);
  });
  const p01 = toPlain(S.svcNormPhone('0110 123 456'));
  assert.equal(p01.ok, true); assert.equal(p01.e164, '+254110123456');
  assert.equal(toPlain(S.svcNormPhone('254110123456')).national, '0110123456');
});
test('svcNormPhone: landline and foreign numbers are accepted with a warning, garbage is an error', () => {
  const l = toPlain(S.svcNormPhone('020 2345678'));
  assert.equal(l.ok, true); assert.equal(l.level, 'warn'); assert.equal(l.e164, '+254202345678');
  const f = toPlain(S.svcNormPhone('+44 7911 123456'));
  assert.equal(f.ok, true); assert.equal(f.level, 'warn'); assert.equal(f.e164, '+447911123456');
  ['abc', '12345', '0812345678', '07123', ''].forEach((bad) => { const r = toPlain(S.svcNormPhone(bad)); assert.equal(r.ok, false, bad); assert.equal(r.level, 'error', bad); });
});
test('svcNormPhone: non-ke rule / other dial code is configurable and never blocks', () => {
  const ug = toPlain(S.svcNormPhone('0772 123456', { dialCode: '256', phoneRule: 'generic', country: 'UG' }));
  assert.equal(ug.ok, true); assert.equal(ug.e164, '+256772123456'); assert.equal(ug.level, 'warn');
  assert.equal(toPlain(S.svcNormPhone('+256 772 123456', { dialCode: '256', phoneRule: 'generic' })).e164, '+256772123456');
  assert.equal(toPlain(S.svcNormPhone('12', { dialCode: '256', phoneRule: 'generic' })).ok, false);
});
test('svcPhoneKey: last 9 digits, or empty', () => {
  assert.equal(S.svcPhoneKey('+254 712 345 678'), '712345678');
  assert.equal(S.svcPhoneKey('0712345678'), '712345678');
  assert.equal(S.svcPhoneKey('12'), '');
  assert.equal(S.svcPhoneKey(null), '');
});

test('svcNormPlate / svcCheckPlate: Kenyan patterns', () => {
  const cases = { 'kda123a': 'KDA 123A', 'KDA-123A': 'KDA 123A', ' kaa  001a ': 'KAA 001A', 'KMCA123A': 'KMCA 123A', 'km ca 123 a': 'KMCA 123A', 'GK 123A': 'GK 123A', 'gk1234': 'GK 1234', '12CD34': '12 CD 34', 'UN 123': 'UN 123' };
  Object.keys(cases).forEach((raw) => { assert.equal(S.svcNormPlate(raw), cases[raw], raw); assert.equal(S.svcCheckPlate(raw).ok, true, raw); assert.equal(S.svcCheckPlate(raw).level, 'ok', raw); });
  assert.equal(S.svcCheckPlate('KMCA 123A').kind, 'motorcycle');
  assert.equal(S.svcCheckPlate('KDA 123A').kind, 'standard');
  assert.equal(S.svcPlateKey('kda-123 a'), 'KDA123A');
});
test('svcCheckPlate: never rejects a real plate (generic fallback warns, only junk is an error)', () => {
  ['ZZ 9999', 'KBZ 123', 'ABC1234', 'T 123 ABC', 'K1234', '5ZZ77'].forEach((p) => { const r = toPlain(S.svcCheckPlate(p)); assert.equal(r.ok, true, p); assert.ok(['ok', 'warn'].includes(r.level), p); });
  assert.equal(S.svcCheckPlate('ZZ 9999').level, 'warn');
  assert.equal(S.svcCheckPlate('').ok, false);
  assert.equal(S.svcCheckPlate('AB').ok, false);
  assert.equal(S.svcCheckPlate('ABCDEFGHIJK').ok, false);
});

test('svcValidImei: length + Luhn (Luhn failure is a warning, not an error)', () => {
  const good = toPlain(S.svcValidImei('490154203237518'));
  assert.deepEqual([good.ok, good.luhn, good.level], [true, true, 'ok']);
  assert.equal(S.svcValidImei('49-015420-323751-8').digits, '490154203237518');
  assert.equal(S.svcValidImei('356938035643809').luhn, true);
  const badSum = toPlain(S.svcValidImei('490154203237519'));
  assert.deepEqual([badSum.ok, badSum.luhn, badSum.level], [true, false, 'warn']);
  const short = toPlain(S.svcValidImei('12345'));
  assert.deepEqual([short.ok, short.level], [false, 'warn']);
  assert.equal(S.svcValidImei('').ok, false);
  assert.equal(S.svcValidImei('49015420323751X').ok, false);
});

test('svcBuiltinValidate: empty is ok, required checks are the form\'s job, levels follow the doc', () => {
  assert.equal(S.svcBuiltinValidate('phone', '').ok, true);
  assert.equal(S.svcBuiltinValidate('phone', 'abc', { required: true }).level, 'error');
  assert.equal(S.svcBuiltinValidate('phoneOptional', 'abc').level, 'warn');
  assert.equal(S.svcBuiltinValidate('plate', 'ZZ 9999').level, 'warn');
  assert.equal(S.svcBuiltinValidate('plate', 'KDA 123A').level, 'ok');
  assert.equal(S.svcBuiltinValidate('imei', '490154203237519').level, 'warn');
  assert.equal(S.svcBuiltinValidate('year', '1800').ok, false);
  assert.equal(S.svcBuiltinValidate('year', '2015').ok, true);
  assert.equal(S.svcBuiltinValidate('money', '-5').ok, false);
  assert.equal(S.svcBuiltinValidate('money', '1,500').ok, true);
  assert.equal(S.svcBuiltinValidate('odometer', '82300').ok, true);
  assert.equal(S.svcBuiltinValidate('email', 'a@b').ok, false);
  assert.equal(S.svcBuiltinValidate('email', 'jane@example.co.ke').ok, true);
});

test('svcNextJobNo: PFX-yymmdd-T<till>-<seq3>, strictly increasing, collision-free across tills and cleared storage', () => {
  const now = Date.UTC(2025, 8, 30, 9, 0, 0);       // 30 Sep 2025 (Kenya day 2025-09-30)
  const t3 = svc({ tillNumber: () => 3 });
  const a = t3.svcNextJobNo('car_wash', { now }), b = t3.svcNextJobNo('car_wash', { now }), c = t3.svcNextJobNo('garage', { now });
  assert.equal(a, 'CW-250930-T3-001'); assert.equal(b, 'CW-250930-T3-002'); assert.equal(c, 'GR-250930-T3-003');
  const t4 = svc({ tillNumber: () => 4 });
  assert.equal(t4.svcNextJobNo('car_wash', { now }), 'CW-250930-T4-001');
  // cleared storage: the scan of existing jobs keeps the sequence going
  const fresh = svc({ tillNumber: () => 3 });
  assert.equal(fresh.svcNextJobNo('car_wash', { now, jobs: [{ no: 'CW-250930-T3-007' }, { no: 'PR-250930-T3-012' }, { no: 'CW-250929-T3-099' }] }), 'CW-250930-T3-013');
  // next day restarts
  assert.equal(t3.svcNextJobNo('car_wash', { now: now + 86400000 }), 'CW-251001-T3-001');
  // unknown type falls back to SV; till-less device uses D<3>
  const d = svc({ tillNumber: () => 0, getOrCreateDeviceId: () => 'dev-abc-9f3' });
  assert.equal(d.svcNextJobNo('nope', { now }), 'SV-250930-D9F3-001');
});
test('svcNextJobNo: 1000 numbers from two tills are unique and the Kenya day is used around midnight', () => {
  const now = Date.UTC(2025, 8, 30, 21, 30, 0);     // 00:30 on 1 Oct in Kenya
  const a = svc({ tillNumber: () => 1 }), b = svc({ tillNumber: () => 2 });
  const seen = new Set();
  for (let i = 0; i < 500; i++) { seen.add(a.svcNextJobNo('salon', { now })); seen.add(b.svcNextJobNo('salon', { now })); }
  assert.equal(seen.size, 1000);
  assert.ok([...seen][0].startsWith('SL-251001-T'));
});

test('svcId: prefixed, url-safe, <= 40 chars, unique', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(S.svcId('sj-'));
  assert.equal(ids.size, 200);
  ids.forEach((id) => { assert.match(id, /^[A-Za-z0-9_-]{4,40}$/); assert.ok(id.startsWith('sj-')); });
  assert.ok(S.svcId('averyveryverylongprefix-').length <= 40);
  const bare = loadSvc(['svc-core'], { genSaleId: undefined });
  assert.match(bare.svcId('x-'), /^x-[A-Za-z0-9_-]+$/);
});
test('svcNow honours the test override and svcFormatMoney uses KSh by default', () => {
  assert.equal(typeof S.svcNow(), 'number');
  const o = loadSvc(['svc-core'], { window: { __svcNow: 1234567 } });
  assert.equal(o.svcNow(), 1234567);
  assert.equal(S.svcFormatMoney(1500), 'KSh 1,500');
  assert.equal(S.svcFormatMoney(1234567.5), 'KSh 1,234,567.50');
  assert.equal(S.svcFormatMoney(0), 'KSh 0');
  assert.equal(S.svcFormatMoney(50, { currencyLabel: 'USh' }), 'USh 50');
  assert.deepEqual(toPlain(S.SVC_KE_DEFAULTS), { country: 'KE', currency: 'KES', currencyLabel: 'KSh', dialCode: '254', phoneRule: 'ke', plateRule: 'ke' });
});

test('svcTotals: master prompt vector 1500 + 500 + 300 = 2300', () => {
  const job = { jobServices: [{ id: 'a', name: 'Premium Wash', qty: 1, price: 1500, source: 'base' }, { id: 'b', name: 'Interior Cleaning', qty: 1, price: 500, source: 'base' }],
    charges: [{ id: 'c', kind: 'additional', label: 'Heavy dirt', amount: 300 }], payments: [] };
  const t = toPlain(S.svcTotals(job));
  assert.equal(t.servicesTotal, 2000); assert.equal(t.additional, 300); assert.equal(t.subtotal, 2300); assert.equal(t.total, 2300);
  assert.equal(t.paid, 0); assert.equal(t.balance, 2300); assert.equal(t.paymentStatus, 'unpaid');
  assert.equal(t.lines.length, 3);
  assert.deepEqual(t.lines.map((l) => l.amount), [1500, 500, 300]);
});
test('svcTotals: labour, chargeable materials, discount, voids, reversals, payments, statuses', () => {
  const job = {
    jobServices: [{ name: 'Screen', qty: 1, price: 3500 }, { name: 'gone', qty: 1, price: 999, removedAt: 1 }],
    materials: [{ name: 'Screen part', qty: 1, cost: 1800, price: 2500, chargeable: true }, { name: 'Glue', qty: 2, cost: 50, price: 0, chargeable: false }, { name: 'Undone', qty: 1, cost: 10, price: 500, chargeable: true, reversedAt: 5 }],
    charges: [{ kind: 'labour', amount: 500 }, { kind: 'discount', amount: 200 }, { kind: 'additional', amount: 300, voidedAt: 9 }, { kind: 'fee', amount: 100 }, { kind: 'additional', amount: 400, approved: false }],
    discount: { amount: 100, reason: 'loyal' },
    payments: [{ amount: 2000, method: 'cash' }, { amount: 999, voidedAt: 3 }]
  };
  const t = toPlain(S.svcTotals(job));
  assert.equal(t.servicesTotal, 3500); assert.equal(t.materialsTotal, 2500); assert.equal(t.labour, 500); assert.equal(t.additional, 100); assert.equal(t.discount, 300);
  assert.equal(t.subtotal, 6300); assert.equal(t.total, 6300); assert.equal(t.paid, 2000); assert.equal(t.balance, 4300); assert.equal(t.paymentStatus, 'partial');
  assert.equal(t.materialCost, 1900); assert.equal(t.rejectedCharges, 400); assert.equal(t.margin, 4400);
  assert.equal(t.charges, 600); assert.equal(t.services, 3500); assert.equal(t.materials, 2500);
  const paid = toPlain(S.svcTotals({ ...job, payments: [{ amount: 6300 }] }));
  assert.deepEqual([paid.balance, paid.paymentStatus], [0, 'paid']);
  const over = toPlain(S.svcTotals({ ...job, payments: [{ amount: 7000 }] }));
  assert.deepEqual([over.balance, over.paymentStatus], [0, 'overpaid']);
  assert.equal(toPlain(S.svcTotals({ ...job, payments: [{ amount: 5000 }, { amount: -700, kind: 'refund' }] })).paid, 4300);
});
test('svcTotals: empty / malformed jobs never throw; discount cannot push the total below zero', () => {
  ['', null, undefined, {}, { jobServices: 'x', charges: null }].forEach((j) => { const t = toPlain(S.svcTotals(j)); assert.equal(t.total, 0); assert.equal(t.balance, 0); });
  assert.equal(S.svcTotals({ jobServices: [{ price: 100 }], charges: [{ kind: 'discount', amount: 500 }] }).total, 0);
  assert.equal(S.svcTotals({ jobServices: [{ price: 0.1 }, { price: 0.2 }] }).total, 0.3);
});
test('svcTotals: exclusive tax only when configured; inclusive / none adds nothing', () => {
  const job = { jobServices: [{ price: 1000 }] };
  assert.equal(S.svcTotals(job).tax, 0);
  assert.equal(S.svcTotals(job, { cfg: { taxMode: 'inclusive', taxRate: 0.16 } }).total, 1000);
  const ex = toPlain(S.svcTotals(job, { cfg: { taxMode: 'exclusive', taxRate: 0.16 } }));
  assert.deepEqual([ex.tax, ex.total], [160, 1160]);
  assert.equal(S.svcTotals(job, { taxMode: 'exclusive', taxRate: 16 }).tax, 160);
});
test('svcTotals: approved quote amount follows the newest act; legacy agreed price and bill payments are honoured', () => {
  const base = { quoteVersions: [{ v: 1, total: 4000 }, { v: 2, total: 4500 }], quoteLog: [{ act: 'draft', v: 1 }, { act: 'approve', v: 1 }] };
  assert.equal(S.svcTotals(base).approvedAmount, 4000);
  assert.equal(S.svcTotals({ ...base, quoteLog: base.quoteLog.concat([{ act: 'revise', v: 2 }]) }).approvedAmount, null);
  assert.equal(S.svcTotals({ ...base, quoteLog: base.quoteLog.concat([{ act: 'revise', v: 2 }, { act: 'approve', v: 2 }]) }).approvedAmount, 4500);
  assert.equal(S.svcTotals({}).approvedAmount, null);
  // legacy row: labour + components = 800 but the agreed final price is 1000 (SERVICE-ADJUSTMENT)
  const leg = { _legacy: true, charges: [{ kind: 'labour', amount: 300 }], materials: [{ qty: 1, price: 500, chargeable: true }], finalAmount: 1000 };
  assert.equal(S.svcTotals(leg).total, 1000);
  assert.equal(S.svcTotals({ _legacy: true, quoteAmount: 1200 }).total, 1200);
  // paid from a Bill when the job has no payment rows
  const bills = [{ id: 'b1', amountPaid: 400 }];
  const t = toPlain(S.svcTotals({ _legacy: true, billId: 'b1', finalAmount: 1000 }, { bills }));
  assert.deepEqual([t.total, t.paid, t.balance, t.paymentStatus], [1000, 400, 600, 'partial']);
  assert.equal(S.svcTotals({ _legacy: true, saleId: 's1', finalAmount: 1000 }).paymentStatus, 'paid');
});

test('svcCan: owner, manager, explicit svc:* and implicit legacy grants', () => {
  assert.equal(S.svcCan('svc:approve', null), true);
  assert.equal(S.svcCan('svc:create', { roles: [], isManager: true }), true);
  const legacy = { roles: ['services-counter-tab'] };
  assert.equal(S.svcCan('svc:create', legacy), true);
  assert.equal(S.svcCan('create', legacy), true);
  ['svc:approve', 'svc:manageServices', 'svc:manageConfig'].forEach((p) => assert.equal(S.svcCan(p, legacy), false, p));
  assert.equal(S.svcCan('svc:view', { roles: ['client-registry-tab'] }), true);
  assert.equal(S.svcCan('svc:view', { roles: ['sales-tab'] }), false);
  const explicit = { roles: ['services-counter-tab', 'svc:view', 'svc:status'] };     // any svc:* switches to explicit mode: rights can only narrow
  assert.equal(S.svcCan('svc:view', explicit), true);
  assert.equal(S.svcCan('svc:create', explicit), false);
  assert.equal(S.svcCan('svc:manageConfig', { roles: ['sales-tab'], adminPermissions: ['settings-section-services'] }), true);
  assert.equal(S.SVC_PERMS.length, 16);
});
test('svcCan / svcActor read the signed-in staff member (currentServer) and default to the owner', () => {
  const owner = svc();
  assert.equal(owner.svcCan('svc:manageConfig'), true);
  assert.deepEqual(toPlain(owner.svcActor()), { id: 'owner', name: 'Owner' });
  const staff = svc({ currentServer: { id: 's7', name: 'Peter', roles: ['services-counter-tab'] } });
  assert.deepEqual(toPlain(staff.svcActor()), { id: 's7', name: 'Peter' });
  assert.equal(staff.svcCan('svc:create'), true);
  assert.equal(staff.svcCan('svc:approve'), false);
  assert.equal(staff.svcCan('svc:approve', null), true);
});

test('svcOn / svcEmit: delivery order, unsubscribe, error isolation, wildcard', () => {
  const s = svc(); const seen = [];
  const off = s.svcOn('job:created', (p) => seen.push('a' + p.n));
  s.svcOn('job:created', () => { throw new Error('boom'); });
  s.svcOn('job:created', (p) => seen.push('c' + p.n));
  s.svcOn('*', (p, evt) => seen.push('*' + evt));
  const origErr = console.error; console.error = () => {};
  try { assert.equal(s.svcEmit('job:created', { n: 1 }), 3); } finally { console.error = origErr; }
  off();
  assert.equal(s.svcEmit('job:created', { n: 2 }), 2);                                  // throwing handler not counted: c + wildcard
  assert.deepEqual(seen, ['a1', 'c1', '*job:created', 'c2', '*job:created']);
  assert.equal(svc().svcEmit('nobody:listens'), 0);
  assert.equal(s.svcEmit('nobody:listens'), 1);                // only the wildcard listens
  assert.ok(s.SVC_EVENTS.includes('render:home') && s.SVC_EVENTS.length === 9);
});

test('svcFirstName / svcSlug / svcRound2 helpers', () => {
  assert.equal(S.svcFirstName('  John Kamau '), 'John');
  assert.equal(S.svcSlug('Fuel Level!'), 'fuel_level');
  assert.equal(S.svcRound2(1.005), 1.01);
  assert.equal(S.svcRound2('12.345'), 12.35);
  assert.equal(S.svcDayKey(Date.UTC(2025, 8, 30, 21, 30)), '2025-10-01');
});
