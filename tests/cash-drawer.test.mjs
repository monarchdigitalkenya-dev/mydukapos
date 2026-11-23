import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { makeServer, openDevice, deviceStorage } from './e2e-harness.mjs';
import { until } from './helpers.mjs';
import { ROOT } from './helpers.mjs';

// Cash float & reconciliation (Part 1 of the cash/inventory upgrade): one session per cashier point, shared by every staff account on it.
const ON = JSON.stringify([{ id: 'cfg', enabled: true, updatedAt: 1 }]);
const ITEMS = [{ code: 'A', type: 'item', name: 'Alpha', price: 1000, wholesalePrice: 500, qty: 500, unit: 'pcs', vatCategory: 'A' }];
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}");
const boot = async (extra = {}, server = makeServer()) => {
  const dev = await openDevice('index.html', server, { pos_inventory: JSON.stringify(ITEMS), pos_cash_config: ON, ...extra }, 900);
  quiet(dev.w); return dev;
};
const E = (w, code) => JSON.parse(w.eval(`JSON.stringify(${code})`));

test('denominations: 2x1000 + 3x500 + 2x200 + 1x100 = 4000; blanks/zero fine; negatives and junk rejected', async () => {
  const { w } = await boot();
  const ok = E(w, "cashCountFromDenoms({1000:2,500:'3',200:2,100:1,50:'',20:0}, [1000,500,200,100,50,20])");
  assert.equal(ok.total, 4000); assert.ok(ok.ok);
  assert.equal(E(w, "cashCountFromDenoms({500:-1}, [500])").ok, false);
  assert.equal(E(w, "cashCountFromDenoms({500:'x'}, [500])").ok, false);
  assert.equal(E(w, "cashCountFromDenoms({500:1.5}, [500])").ok, false);
  assert.equal(E(w, "cashCountFromDenoms({77:1}, [500])").ok, false, 'a denomination not in use');
});

test('shared terminal: Staff A opens with 5000; Staff B logs in and sees the SAME session - no recount, one opening record', async () => {
  const { w } = await boot();
  const pt = E(w, "cashDrawerInternals.resolve().point");
  const a = E(w, `cashOpenSession(cashSessions, ${JSON.stringify(pt)}, { settings: cashDrawerInternals.settings(), counts: {1000:5}, confirmed: true, by: 'Alice', byId: 'a', deviceId: 'd1', now: 1000 })`);
  assert.ok(a.ok && a.created); assert.equal(a.session.opening.total, 5000); assert.equal(a.session.opening.by, 'Alice');
  w.eval(`cashSessions.push(${JSON.stringify(a.session)})`);
  const b = E(w, `cashOpenSession(cashSessions, ${JSON.stringify(pt)}, { settings: cashDrawerInternals.settings(), counts: {1000:1}, confirmed: true, by: 'Bob', byId: 'b', deviceId: 'd1', now: 2000 })`);
  assert.ok(b.ok); assert.equal(b.created, false, 'Bob does not open a second session');
  assert.equal(b.session.opening.by, 'Alice', 'the original opener stays in the record');
  assert.equal(b.session.opening.total, 5000, 'and the count is not overwritten');
  assert.equal(w.eval('cashSessions.length'), 1);
});

test('independent tills: separate balances; closing Till 1 does not close Till 2; consolidated total counts each once', async () => {
  const { w } = await boot();
  w.eval("cashPoints.push({id:'t1',name:'Till 1',active:true,deviceIds:[],updatedAt:1},{id:'t2',name:'Till 2',active:true,deviceIds:[],updatedAt:1})");
  const open = (id, name, n, by) => { const r = E(w, `cashOpenSession(cashSessions, cashPoints.find(p=>p.id==='${id}'), {settings: cashDrawerInternals.settings(), counts:{1000:${n}}, confirmed:true, by:'${by}', now: 1000})`); w.eval(`cashSessions.push(${JSON.stringify(r.session)})`); return r.session; };
  const s1 = open('t1', 'Till 1', 5, 'A'), s2 = open('t2', 'Till 2', 3, 'B');
  w.eval(`salesLog.push({id:'x1',timestamp:new Date(2000).toISOString(),paid:true,cashAmount:700,mpesaAmount:0,cashSessionId:'${s1.id}'},{id:'x2',timestamp:new Date(2000).toISOString(),paid:true,cashAmount:300,mpesaAmount:0,cashSessionId:'${s2.id}'})`);
  const sum = (s) => E(w, `cashSessionSummary(cashSessions.find(x=>x.id==='${s.id}'), salesLog, cashMovements, {})`);
  assert.equal(sum(s1).expected, 5700); assert.equal(sum(s2).expected, 3300);
  const c = E(w, `cashCloseSession(cashSessions[0], cashSessionSummary(cashSessions[0], salesLog, cashMovements, {}), {settings: cashDrawerInternals.settings(), counts:{1000:5,500:1,200:1}, confirmed:true, by:'A', now:3000})`);
  assert.ok(c.ok); w.eval(`cashSessions[0].closing = ${JSON.stringify(c.closing)}; cashSessions[0].status='closed'`);
  assert.equal(w.eval("cashSessions[1].status"), 'open', 'Till 2 is untouched');
  assert.equal(sum(s1).expected + sum(s2).expected, 9000, 'consolidated = 5700 + 3300, no double count');
});

test('mixed payment: KES 1000 sale = 600 cash + 400 M-Pesa adds exactly 600 to expected cash; voids and unpaid bills add nothing', async () => {
  const { w } = await boot();
  const pt = E(w, "cashDrawerInternals.resolve().point");
  const r = E(w, `cashOpenSession(cashSessions, ${JSON.stringify(pt)}, {settings: cashDrawerInternals.settings(), counts:{1000:5}, confirmed:true, by:'A', now:1000})`);
  w.eval(`cashSessions.push(${JSON.stringify(r.session)})`);
  const sid = r.session.id;
  w.eval(`salesLog.push({id:'m1',timestamp:new Date(2000).toISOString(),paid:true,cashAmount:600,mpesaAmount:400,cardAmount:0,cashSessionId:'${sid}'},
    {id:'m2',timestamp:new Date(2100).toISOString(),paid:true,voided:true,cashAmount:900,cashSessionId:'${sid}'},
    {id:'m3',timestamp:new Date(2200).toISOString(),paid:false,cashAmount:0,cashSessionId:'${sid}'})`);
  const sm = E(w, `cashSessionSummary(cashSessions[0], salesLog, cashMovements, {})`);
  assert.equal(sm.cashSales, 600); assert.equal(sm.expected, 5600); assert.equal(sm.nonCash.mpesa, 400);
});

test('movements: refunds/payouts/safe/bank reduce expected, cash-in raises it; a retried movement id is recorded once; voided ones ignored', async () => {
  const { w } = await boot();
  const pt = E(w, "cashDrawerInternals.resolve().point");
  const r = E(w, `cashOpenSession(cashSessions, ${JSON.stringify(pt)}, {settings: cashDrawerInternals.settings(), counts:{1000:10}, confirmed:true, by:'A', now:1000})`);
  w.eval(`cashSessions.push(${JSON.stringify(r.session)})`);
  const mv = (id, dir, cat, amt, reason = 'why') => { const m = E(w, `cashMakeMovement(cashMovements, cashSessions[0], {opId:'${id}', direction:'${dir}', category:'${cat}', amount:${amt}, reason:'${reason}', by:'A', now:2000})`); if (m.ok && m.created) w.eval(`cashMovements.push(${JSON.stringify(m.movement)})`); return m; };
  assert.ok(mv('a', 'in', 'cash_added', 1000).created);
  assert.ok(mv('b', 'out', 'refund', 300).created);
  assert.ok(mv('c', 'out', 'petty_cash', 200).created);
  assert.ok(mv('d', 'out', 'safe_transfer', 2000).created);
  assert.ok(mv('e', 'out', 'bank_deposit', 500).created);
  assert.equal(mv('b', 'out', 'refund', 300).created, false, 'the retry is not a second refund');
  assert.equal(mv('f', 'out', 'refund', 0).ok, false, 'amount above 0');
  assert.equal(mv('g', 'out', 'cash_added', 5).ok, false, 'category must match direction');
  assert.equal(mv('h', 'out', 'petty_cash', 5, '  ').ok, false, 'a reason is required');
  w.eval("cashMovements.find(m=>m.id==='c').voided = true");
  const sm = E(w, `cashSessionSummary(cashSessions[0], salesLog, cashMovements, {})`);
  assert.equal(sm.expected, 10000 + 1000 - 300 - 2000 - 500);
});

test('variance: expected 10000, counted 9800 = -200 kept as is; reason required; above the threshold it waits for a manager', async () => {
  const { w } = await boot();
  const pt = E(w, "cashDrawerInternals.resolve().point");
  const r = E(w, `cashOpenSession(cashSessions, ${JSON.stringify(pt)}, {settings: cashDrawerInternals.settings(), counts:{1000:10}, confirmed:true, by:'A', now:1000})`);
  w.eval(`cashSessions.push(${JSON.stringify(r.session)})`);
  const st = JSON.stringify({ ...E(w, 'cashDrawerInternals.settings()'), approvalThreshold: 100 });
  const sm = E(w, `cashSessionSummary(cashSessions[0], salesLog, cashMovements, {})`);
  const noReason = E(w, `cashCloseSession(cashSessions[0], ${JSON.stringify(sm)}, {settings:${st}, counts:{1000:9,500:1,200:1,100:1}, confirmed:true, by:'A'})`);
  assert.equal(noReason.ok, false); assert.equal(noReason.needsReason, true); assert.equal(noReason.variance, -200);
  const noConfirm = E(w, `cashCloseSession(cashSessions[0], ${JSON.stringify(sm)}, {settings:${st}, counts:{1000:10}, by:'A'})`);
  assert.equal(noConfirm.ok, false, 'needs the confirmation');
  const ok = E(w, `cashCloseSession(cashSessions[0], ${JSON.stringify(sm)}, {settings:${st}, counts:{1000:9,500:1,200:1,100:1}, confirmed:true, reason:'change given wrongly', by:'A'})`);
  assert.ok(ok.ok); assert.equal(ok.closing.variance, -200); assert.equal(ok.closing.expected, 10000, 'expected is never adjusted to match');
  assert.equal(ok.closing.counted, 9800); assert.equal(ok.closing.approval.status, 'pending');
  const bal = E(w, `cashCloseSession(cashSessions[0], ${JSON.stringify(sm)}, {settings:${st}, counts:{1000:10}, confirmed:true, by:'A'})`);
  assert.equal(bal.closing.variance, 0); assert.equal(bal.closing.approval.status, 'not-required');
  // approval: only a manager; a rejection needs a reason
  const sess = { status: 'closed', closing: ok.closing };
  assert.equal(E(w, `cashDecideApproval(${JSON.stringify(sess)}, {isManager:false, approve:true})`).ok, false);
  assert.equal(E(w, `cashDecideApproval(${JSON.stringify(sess)}, {isManager:true, approve:false})`).ok, false);
  assert.equal(E(w, `cashDecideApproval(${JSON.stringify(sess)}, {isManager:true, approve:true, by:'M'})`).approval.status, 'approved');
});

test('optional counts are recorded as skipped, never as reconciled', async () => {
  const { w } = await boot();
  const pt = E(w, "cashDrawerInternals.resolve().point");
  const s = JSON.stringify({ ...E(w, 'cashDrawerInternals.settings()'), openingCount: false, closingCount: false });
  assert.equal(E(w, `cashOpenSession([], ${JSON.stringify(pt)}, {settings:${JSON.stringify(E(w, 'cashDrawerInternals.settings()'))}, skip:true})`).ok, false, 'required count cannot be skipped');
  const o = E(w, `cashOpenSession([], ${JSON.stringify(pt)}, {settings:${s}, skip:true, by:'A'})`);
  assert.equal(o.session.opening.status, 'skipped');
  const c = E(w, `cashCloseSession(${JSON.stringify(o.session)}, {expected: 0}, {settings:${s}, skip:true})`);
  assert.equal(c.closing.status, 'skipped'); assert.equal(c.closing.variance, null);
});

test('device assignment: one point -> ok; device on two points or several unassigned points -> ambiguous (never mixes drawers)', async () => {
  const { w } = await boot();
  const rp = (pts, d) => E(w, `cashResolvePoint(${JSON.stringify(pts)}, '${d}')`);
  assert.equal(rp([{ id: 'p', active: true }], 'd1').status, 'ok');
  assert.equal(rp([{ id: 'p', active: true, deviceIds: ['d1'] }, { id: 'q', active: true, deviceIds: ['d2'] }], 'd1').point.id, 'p');
  assert.equal(rp([{ id: 'p', active: true, deviceIds: ['d1'] }, { id: 'q', active: true, deviceIds: ['d1'] }], 'd1').status, 'ambiguous');
  assert.equal(rp([{ id: 'p', active: true }, { id: 'q', active: true }], 'd9').status, 'ambiguous');
  assert.equal(rp([{ id: 'p', active: false }], 'd1').status, 'none');
});

test('Sales Counter: no session -> the opening screen appears and no sale is made; after the count the sale is stamped with the session; staff B sells without recounting', async () => {
  const { w } = await boot();
  w.eval("addToCart('A'); currentPaymentMethod = 'cash'");
  w.document.getElementById('cash-tendered-input').value = '1000';
  const pending = w.eval('checkoutCart()');
  await until(() => w.document.getElementById('cash-modal') && w.document.getElementById('cash-modal').style.display === 'flex', 3000);
  assert.equal(w.eval('salesLog.length'), 0, 'nothing is sold before the drawer is open');
  const card = w.document.getElementById('cash-card');
  card.querySelector('[data-denom="1000"]').value = '5';
  card.querySelector('[data-denom="1000"]').dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.match(card.querySelector('#cash-count-total').textContent, /5,000\.00/);
  card.querySelector('[data-act="do-open"]').click();
  assert.match(card.querySelector('#cash-err').textContent, /Confirm/, 'must confirm first');
  card.querySelector('#cash-confirm').checked = true;
  card.querySelector('[data-act="do-open"]').click();
  await pending;
  assert.equal(w.eval('cashSessions.length'), 1);
  const sale = E(w, 'salesLog[salesLog.length - 1]');
  assert.equal(sale.cashSessionId, w.eval('cashSessions[0].id')); assert.equal(sale.cashAmount, 1000);
  // another employee sells on the same terminal: no second prompt, no second session
  w.eval("addToCart('A'); currentPaymentMethod = 'cash'");
  w.document.getElementById('cash-tendered-input').value = '1000';
  await w.eval('checkoutCart()');
  assert.equal(w.eval('cashSessions.length'), 1); assert.equal(w.eval('salesLog.length'), 2);
  assert.equal(E(w, 'cashSessionSummary(cashSessions[0], salesLog, cashMovements, {}).expected'), 7000);
});

test('closed session: no further sale is assigned to it - the next sale opens a NEW session (new id)', async () => {
  const { w } = await boot();
  const pt = E(w, "cashDrawerInternals.resolve().point");
  const r = E(w, `cashOpenSession(cashSessions, ${JSON.stringify(pt)}, {settings: cashDrawerInternals.settings(), counts:{1000:1}, confirmed:true, by:'A', now:1000})`);
  w.eval(`cashSessions.push(${JSON.stringify(r.session)})`);
  const c = E(w, `cashCloseSession(cashSessions[0], cashSessionSummary(cashSessions[0], salesLog, cashMovements, {}), {settings: cashDrawerInternals.settings(), counts:{1000:1}, confirmed:true, by:'A', now:2000})`);
  w.eval(`cashSessions[0].closing=${JSON.stringify(c.closing)}; cashSessions[0].status='closed'`);
  assert.equal(w.eval('cashDrawerInternals.activeSession()'), null);
  const again = E(w, `cashOpenSession(cashSessions, ${JSON.stringify(pt)}, {settings: cashDrawerInternals.settings(), counts:{1000:2}, confirmed:true, by:'B', now:3000})`);
  assert.ok(again.created); assert.notEqual(again.session.id, r.session.id); assert.equal(again.session.seq, 2);
  assert.equal(E(w, `cashCloseSession(cashSessions[0], {expected:0}, {settings: cashDrawerInternals.settings(), counts:{}, confirmed:true})`).ok, false, 'a closed session cannot be closed twice');
});

test('feature off: the Sales Counter sells with no prompt and past records are kept', async () => {
  const { w } = await boot({ pos_cash_config: JSON.stringify([{ id: 'cfg', enabled: false, updatedAt: 1 }]), pos_cash_sessions: JSON.stringify([{ id: 'cs-old-1', pointId: 'old', status: 'closed', opening: { total: 1, by: 'x', at: 1 }, closing: null, updatedAt: 1 }]) });
  w.eval("addToCart('A'); currentPaymentMethod = 'cash'");
  w.document.getElementById('cash-tendered-input').value = '1000';
  await w.eval('checkoutCart()');
  assert.equal(w.eval('salesLog.length'), 1); assert.equal(w.eval('cashSessions.length'), 1);
  assert.ok(!E(w, 'salesLog[0]').cashSessionId);
});

test('two devices open the same drawer OFFLINE: after sync there is ONE session, the earliest count stands, the other is kept as a conflict', async () => {
  const s = makeServer();
  const d1 = await boot({}, s); const d2 = await boot({ pos_device_id: 'dev_second' }, s);
  s.state.down = true;
  const mk = (dev, n, by, now) => { const pt = E(dev.w, "cashDrawerInternals.resolve().point"); const r = E(dev.w, `cashOpenSession(cashSessions, ${JSON.stringify(pt)}, {settings: cashDrawerInternals.settings(), counts:{1000:${n}}, confirmed:true, by:'${by}', deviceId:'${dev.w.eval("localStorage.getItem('pos_device_id')")}', now:${now}})`); dev.w.eval(`cashSessions.push(${JSON.stringify(r.session)}); cashDrawerInternals.save()`); return r.session; };
  const a = mk(d1, 5, 'Alice', Date.now()), b = mk(d2, 4, 'Bob', Date.now() + 5000);
  assert.equal(a.id, b.id, 'deterministic id: both devices produce the same session record');
  s.state.down = false;
  for (const d of [d1, d2, d1]) { await d.w.eval('pushNow()'); await d.w.eval('pullState()'); }
  for (const d of [d1, d2]) {
    assert.equal(d.w.eval('cashSessions.length'), 1);
    assert.equal(d.w.eval('cashSessions[0].opening.by'), 'Alice', 'the earliest opening is the authoritative one');
    assert.equal(d.w.eval('cashSessions[0].opening.total'), 5000);
    assert.equal(d.w.eval('(cashSessions[0].conflicts || []).length'), 1, 'Bob\'s count is preserved for review');
  }
});

test('server merge: a stale copy cannot reopen a closed session or undo an approval; the first closing count stands', async () => {
  const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/_merge.js')).href);
  const open = { id: 's', status: 'open', opening: { at: 1, by: 'A', deviceId: 'd' }, updatedAt: 10 };
  const closed = { ...open, status: 'closed', closing: { at: 50, by: 'A', deviceId: 'd', variance: -200, approval: { status: 'pending' } }, updatedAt: 50 };
  assert.equal(m.mergeNestedRecord('cashSessions', closed, { ...open, updatedAt: 999 }).status, 'closed');
  const approved = { ...closed, closing: { ...closed.closing, approval: { status: 'approved', by: 'M' } }, updatedAt: 60 };
  const merged = m.mergeNestedRecord('cashSessions', approved, closed);
  assert.equal(merged.closing.approval.status, 'approved');
  const second = { ...closed, closing: { ...closed.closing, at: 80, by: 'B', deviceId: 'e', variance: 0 }, updatedAt: 90 };
  const two = m.mergeNestedRecord('cashSessions', closed, second);
  assert.equal(two.closing.by, 'A'); assert.equal(two.conflicts.length, 1);
});

const closedSession = (w, expected, countedCounts, by = 'A', openedAt = 1000) => {
  const pt = E(w, 'cashDrawerInternals.resolve().point');
  const r = E(w, `cashOpenSession(cashSessions, ${JSON.stringify(pt)}, {settings: cashDrawerInternals.settings(), counts:{1000:${expected / 1000}}, confirmed:true, by:'${by}', now:${openedAt}})`);
  w.eval(`cashSessions.push(${JSON.stringify(r.session)})`);
  const c = E(w, `cashCloseSession(cashSessions[cashSessions.length-1], cashSessionSummary(cashSessions[cashSessions.length-1], salesLog, cashMovements, {}), {settings: cashDrawerInternals.settings(), counts:${JSON.stringify(countedCounts)}, confirmed:true, reason:'short', by:'${by}', now:${openedAt + 1000}})`);
  w.eval(`cashSessions[cashSessions.length-1].closing=${JSON.stringify(c.closing)}; cashSessions[cashSessions.length-1].status='closed'`);
  return E(w, 'cashSessions[cashSessions.length-1]');
};

test('correcting a finished count: manager + reason only; the original is kept; variance re-measured; goes back to approval', async () => {
  const { w } = await boot();
  const s = closedSession(w, 10000, { 1000: 9, 500: 1, 200: 1, 100: 1 });   // counted 9800, variance -200
  const st = JSON.stringify({ ...E(w, 'cashDrawerInternals.settings()'), approvalThreshold: 100 });
  const go = (o) => E(w, `cashCorrectClosing(${JSON.stringify(s)}, Object.assign({settings:${st}, now: 9000, by:'M'}, ${JSON.stringify(o)}))`);
  assert.equal(go({ isManager: false, reason: 'x', counts: { 1000: 10 } }).ok, false, 'staff cannot correct');
  assert.equal(go({ isManager: true, reason: ' ', counts: { 1000: 10 } }).ok, false, 'reason required');
  assert.equal(go({ isManager: true, reason: 'x', counts: { 1000: -1 } }).ok, false, 'bad count');
  const ok = go({ isManager: true, reason: 'recounted notes', counts: { 1000: 9, 500: 1 } });   // 9500 -> -500
  assert.ok(ok.ok); assert.equal(ok.closing.counted, 9500); assert.equal(ok.closing.variance, -500); assert.equal(ok.closing.expected, 10000);
  assert.equal(ok.closing.approval.status, 'pending'); assert.equal(ok.correction.before.counted, 9800, 'the original count is preserved'); assert.equal(ok.correction.before.variance, -200);
  assert.equal(ok.closing.at, s.closing.at, 'closing time is not rewritten');
  assert.equal(E(w, `cashCorrectClosing({status:'open'}, {isManager:true, reason:'x', total:1})`).ok, false, 'open sessions cannot be corrected');
});

test('a corrected count survives a sync with a stale copy of the same closing (merge)', async () => {
  const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/_merge.js')).href);
  const base = { id: 's', status: 'closed', opening: { at: 1, by: 'A', deviceId: 'd' }, closing: { at: 50, by: 'A', deviceId: 'd', counted: 9800, variance: -200, approval: { status: 'not-required' } }, corrections: [], updatedAt: 50 };
  const fixed = { ...base, closing: { ...base.closing, counted: 9500, variance: -500, correctedAt: 70, approval: { status: 'pending' } }, corrections: [{ id: 'cor-1', at: 70, by: 'M', reason: 'r', before: { counted: 9800 }, after: { counted: 9500 } }], updatedAt: 70 };
  for (const [a, b] of [[base, fixed], [fixed, base]]) { const r = m.mergeNestedRecord('cashSessions', a, b); assert.equal(r.closing.counted, 9500); assert.equal(r.corrections.length, 1); }
});

test('history filters and CSV: by point, status, date, operator, differences-only; CSV escapes commas and quotes', async () => {
  const { w } = await boot();
  w.eval("cashPoints.push({id:'t1',name:'Till, 1',active:true,deviceIds:[],updatedAt:1})");
  const d1 = new Date('2026-03-01T09:00:00').getTime(), d2 = new Date('2026-03-05T09:00:00').getTime();
  w.eval(`cashSessions.push({id:'cs-t1-1',pointId:'t1',pointName:'Till, 1',seq:1,status:'closed',openedAt:${d1},opening:{by:'Alice',total:1000,at:${d1}},closing:{by:'Bob',at:${d1 + 1},expected:1000,counted:900,variance:-100,reason:'said "oops"',breakdown:{cashSales:0},approval:{status:'pending'}},conflicts:[],corrections:[]},
    {id:'cs-p-1',pointId:'p',pointName:'Main',seq:1,status:'open',openedAt:${d2},opening:{by:'Carol',total:500,at:${d2}},closing:null,conflicts:[],corrections:[]})`);
  const f = (x) => E(w, `cashFilterSessions(cashSessions, ${JSON.stringify(x)})`).map((s) => s.id);
  assert.deepEqual(f({}).sort(), ['cs-p-1', 'cs-t1-1']);
  assert.deepEqual(f({ pointId: 't1' }), ['cs-t1-1']); assert.deepEqual(f({ status: 'open' }), ['cs-p-1']);
  assert.deepEqual(f({ from: '2026-03-04' }), ['cs-p-1']); assert.deepEqual(f({ to: '2026-03-02' }), ['cs-t1-1']);
  assert.deepEqual(f({ operator: 'bob' }), ['cs-t1-1']); assert.deepEqual(f({ varianceOnly: true }), ['cs-t1-1']);
  const csv = w.eval('cashSessionsCsv(cashSessions)');
  assert.match(csv, /"Till, 1"/); assert.match(csv, /"said ""oops"""/); assert.equal(csv.split('\n').length, 3);
});

test('history screen: filter + Correct count + CSV buttons are real and work through the UI', async () => {
  const { w } = await boot();
  const s = closedSession(w, 5000, { 1000: 4, 500: 1 });   // counted 4500, variance -500 (default threshold 500 -> no approval)
  w.eval("window.cashDrawerOpen(); document.querySelector('#cash-card [data-act=goto-history]').click()");
  const card = () => w.document.getElementById('cash-card');
  assert.ok(card().querySelector('#cf-point') && card().querySelector('[data-act="csv"]'));
  assert.ok(card().querySelector('[data-act="goto-correct"]'), 'admin/manager sees Correct count');
  card().querySelector('#cf-var').checked = true; card().querySelector('#cf-var').dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.match(card().textContent, /short KES 500\.00/);
  card().querySelector('[data-act="goto-correct"]').click();
  card().querySelector('[data-denom="1000"]').value = '5'; card().querySelector('[data-denom="1000"]').dispatchEvent(new w.Event('input', { bubbles: true }));
  card().querySelector('[data-act="do-correct"]').click();
  assert.match(card().querySelector('#cash-err').textContent, /reason/i);
  card().querySelector('#cash-reason').value = 'miscounted';
  card().querySelector('[data-act="do-correct"]').click();
  assert.equal(w.eval('cashSessions[0].closing.counted'), 5000); assert.equal(w.eval('cashSessions[0].closing.variance'), 0);
  assert.equal(w.eval('cashSessions[0].corrections.length'), 1); assert.equal(w.eval('cashSessions[0].corrections[0].before.counted'), 4500);
  assert.match(card().textContent, /No sessions yet/, 'a now-balanced session correctly leaves the differences-only view');
  card().querySelector('#cf-var').checked = false; card().querySelector('#cf-var').dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.match(card().textContent, /Corrected 1×/);
});

const openSession = (w, n = 5, by = 'A') => {
  const pt = E(w, 'cashDrawerInternals.resolve().point');
  const r = E(w, `cashOpenSession(cashSessions, ${JSON.stringify(pt)}, {settings: cashDrawerInternals.settings(), counts:{1000:${n}}, confirmed:true, by:'${by}', now:1000})`);
  w.eval(`cashSessions.push(${JSON.stringify(r.session)})`);
  return r.session;
};

test('voiding a wrong movement: manager + reason, only in the open session; the movement stays on record and expected cash recovers', async () => {
  const { w } = await boot();
  const s = openSession(w, 5);
  const m = E(w, `cashMakeMovement(cashMovements, cashSessions[0], {opId:'m1', direction:'out', category:'petty_cash', amount:700, reason:'tea', by:'A', now:2000})`);
  w.eval(`cashMovements.push(${JSON.stringify(m.movement)})`);
  const exp = () => E(w, 'cashSessionSummary(cashSessions[0], salesLog, cashMovements, {}).expected');
  assert.equal(exp(), 4300);
  const v = (o) => E(w, `cashVoidMovement(cashMovements[0], cashSessions[0], Object.assign({now: 3000, by:'M'}, ${JSON.stringify(o)}))`);
  assert.equal(v({ isManager: false, reason: 'typo' }).ok, false, 'staff cannot void');
  assert.equal(v({ isManager: true, reason: ' ' }).ok, false, 'reason required');
  const ok = v({ isManager: true, reason: 'entered twice' });
  assert.ok(ok.ok); assert.equal(ok.movement.voided, true); assert.equal(ok.movement.amount, 700, 'the original amount is kept'); assert.equal(ok.movement.voidReason, 'entered twice');
  w.eval(`cashMovements[0] = ${JSON.stringify(ok.movement)}`);
  assert.equal(exp(), 5000, 'expected cash recovers');
  assert.equal(E(w, `cashVoidMovement(cashMovements[0], cashSessions[0], {isManager:true, reason:'again'})`).ok, false, 'no double void');
  assert.equal(E(w, `cashVoidMovement({id:'x', sessionId:'cs-other', amount:1}, cashSessions[0], {isManager:true, reason:'r'})`).ok, false, 'other session');
  assert.equal(E(w, `cashVoidMovement({id:'x', sessionId:'${s.id}', amount:1}, {id:'${s.id}', status:'closed'}, {isManager:true, reason:'r'})`).ok, false, 'closed session is fixed');
});

test('correcting the opening count: manager + reason, open session only, original kept, expected cash follows', async () => {
  const { w } = await boot();
  const s = openSession(w, 5);   // counted 5000, really 4000
  const st = JSON.stringify(E(w, 'cashDrawerInternals.settings()'));
  const go = (o) => E(w, `cashCorrectOpening(cashSessions[0], Object.assign({settings:${st}, now: 5000, by:'M'}, ${JSON.stringify(o)}))`);
  assert.equal(go({ isManager: false, reason: 'x', counts: { 1000: 4 } }).ok, false);
  assert.equal(go({ isManager: true, reason: '', counts: { 1000: 4 } }).ok, false);
  assert.equal(go({ isManager: true, reason: 'x', counts: { 1000: -4 } }).ok, false);
  const ok = go({ isManager: true, reason: 'one note miscounted', counts: { 1000: 4 } });
  assert.ok(ok.ok); assert.equal(ok.opening.total, 4000); assert.equal(ok.opening.by, s.opening.by, 'the original counter stays recorded'); assert.equal(ok.opening.at, s.opening.at);
  assert.equal(ok.correction.before.total, 5000); assert.equal(ok.correction.kind, 'opening');
  w.eval(`cashSessions[0].opening = ${JSON.stringify(ok.opening)}`);
  assert.equal(E(w, 'cashSessionSummary(cashSessions[0], salesLog, cashMovements, {}).expected'), 4000);
  assert.equal(E(w, `cashCorrectOpening({status:'closed', opening:{}}, {isManager:true, reason:'r', total:1})`).ok, false, 'closed session');
});

test('a corrected OPENING count survives a sync with a stale copy (merge)', async () => {
  const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/_merge.js')).href);
  const base = { id: 's', status: 'open', opening: { at: 1, by: 'A', deviceId: 'd', total: 5000 }, corrections: [], updatedAt: 1 };
  const fixed = { ...base, opening: { ...base.opening, total: 4000, correctedAt: 9 }, corrections: [{ id: 'cor-open-9-M', kind: 'opening', at: 9, by: 'M', reason: 'r', before: { total: 5000 }, after: { total: 4000 } }], updatedAt: 9 };
  for (const [a, b] of [[base, fixed], [fixed, base]]) { const r = m.mergeNestedRecord('cashSessions', a, b); assert.equal(r.opening.total, 4000); assert.equal(r.corrections.length, 1); assert.equal((r.conflicts || []).length, 0, 'a correction is not a conflict'); }
});

test('drawer screen: Void and Correct opening count buttons work through the UI for a manager', async () => {
  const { w } = await boot();
  const s = openSession(w, 5);
  const m = E(w, `cashMakeMovement(cashMovements, cashSessions[0], {opId:'m1', direction:'out', category:'petty_cash', amount:700, reason:'tea', by:'A', now:2000})`);
  w.eval(`cashMovements.push(${JSON.stringify(m.movement)}); window.cashDrawerOpen()`);
  const card = () => w.document.getElementById('cash-card');
  assert.match(card().textContent, /Expected in drawer.*4,300\.00/);
  w.eval("window.prompt = () => ''");
  card().querySelector('[data-act="void-move"]').click();
  assert.equal(w.eval('cashMovements[0].voided'), undefined, 'no reason -> not voided');
  w.eval("window.prompt = () => 'entered twice'");
  card().querySelector('[data-act="void-move"]').click();
  assert.equal(w.eval('cashMovements[0].voided'), true);
  assert.match(card().textContent, /voided by .*entered twice/); assert.match(card().textContent, /Expected in drawer.*5,000\.00/);
  card().querySelector('[data-act="goto-correct-open"]').click();
  card().querySelector('[data-denom="1000"]').value = '4'; card().querySelector('[data-denom="1000"]').dispatchEvent(new w.Event('input', { bubbles: true }));
  card().querySelector('[data-act="do-correct-open"]').click();
  assert.match(card().querySelector('#cash-err').textContent, /reason/i);
  card().querySelector('#cash-reason').value = 'miscounted a note';
  card().querySelector('[data-act="do-correct-open"]').click();
  assert.equal(w.eval('cashSessions[0].opening.total'), 4000); assert.equal(w.eval('cashSessions[0].corrections.length'), 1);
  assert.match(card().textContent, /Opening corrected 1×/); assert.match(card().textContent, /Expected in drawer.*4,000\.00/);
});

test('money: one shared split rule; cash taken earlier today is shown but NEVER silently added to expected', async () => {
  const { w } = await boot();
  // split rule: per-method amounts win; an old sale with none follows paymentMethod; voided / unpaid = nothing
  const P = (s) => E(w, `salePaymentParts(${JSON.stringify(s)})`);
  assert.deepEqual(P({ total: 500, paymentMethod: 'cash' }), { cash: 500, mpesa: 0, card: 0, other: 0 });
  assert.deepEqual(P({ total: 500, paymentMethod: 'mpesa' }), { cash: 0, mpesa: 500, card: 0, other: 0 });
  assert.deepEqual(P({ total: 900, cashAmount: 400, mpesaAmount: 500 }), { cash: 400, mpesa: 500, card: 0, other: 0 });
  assert.deepEqual(P({ total: 500, voided: true, cashAmount: 500 }), { cash: 0, mpesa: 0, card: 0, other: 0 });
  assert.deepEqual(P({ total: 500, paid: false, cashAmount: 500 }), { cash: 0, mpesa: 0, card: 0, other: 0 });
  const day = new Date(); day.setHours(8, 0, 0, 0); const t0 = day.getTime();
  const session = { id: 'cs-x-2', pointId: 'x', status: 'open', openedAt: t0 + 6 * 36e5, opening: { total: 0 }, closing: null };
  const sales = [
    { timestamp: new Date(t0 + 3600e3).toISOString(), total: 15000, cashAmount: 15000 },                       // earlier today, no session
    { timestamp: new Date(t0 + 2 * 3600e3).toISOString(), total: 2000, mpesaAmount: 2000 },
    { timestamp: new Date(t0 + 7 * 36e5).toISOString(), total: 27330, cashAmount: 27330, cashSessionId: 'cs-x-2' },
    { timestamp: new Date(t0 + 7 * 36e5).toISOString(), total: 41950, mpesaAmount: 41950, cashSessionId: 'cs-x-2' },
  ];
  const sm = E(w, `cashSessionSummary(${JSON.stringify(session)}, ${JSON.stringify(sales)}, [], {})`);
  assert.equal(sm.cashSales, 27330); assert.equal(sm.expected, 27330, 'expected is unchanged');
  assert.equal(sm.earlier.cash, 15000); assert.equal(sm.earlier.mpesa, 2000); assert.equal(sm.earlier.count, 2);
  assert.equal(sm.nonCash.mpesa, 41950);
  // the manager adds it to the opening count -> expected = 42,330 (the real count)
  const fixed = E(w, `(() => { const s = ${JSON.stringify(session)}; const r = cashCorrectOpening(s, { isManager: true, mode: 'total', total: 15000, reason: 'earlier cash' }); s.opening = r.opening; return cashSessionSummary(s, ${JSON.stringify(sales)}, [], {}); })()`);
  assert.equal(fixed.expected, 42330);
});
