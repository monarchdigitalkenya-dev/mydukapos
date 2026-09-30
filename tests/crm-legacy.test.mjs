import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCrm } from './crm-harness.mjs';

function seedKv(c) {
  const put = (k, v) => c.kv.data.set(k, { value: JSON.stringify(v) });
  put('leads-staff-list', ['Ann', 'Bob']);
  put('leads-sheet:2026-09-01', [
    { id: 'a1', name: 'Wanjiru', phone: '0722111222', product: 'shop', contacted: false, notes: 'n1', createdAt: '2026-09-01T07:00:00+03:00' },
    { id: 'b1', name: 'Otieno', phone: '0733000001', product: 'hotel', contacted: true, contactedBy: 'Ann', updatedAt: '2026-09-01T10:00:00+03:00' },
    { id: 'c1', name: 'Dead One', phone: '0733000002', dead: true, product: 'shop' },
    { id: 'd1', name: 'No Phone', phone: '' },
  ]);
  put('leads-sheet:2026-09-02', [
    { id: 'a2', name: 'Wanjiru', phone: '+254722111222', product: 'shop', contacted: true, contactedBy: 'Bob', assignedTo: 'Bob', updatedAt: '2026-09-02T11:00:00+03:00' },
    { id: 'b2', name: 'Otieno', phone: '254733000001', product: 'hotel', contacted: true, contactedBy: 'Ann', closed: true, clientId: 'CL1', clientLink: 'https://otieno.mydukapos.store/hotel/?c=CL1', agreedAmount: 20000, paidAmount: 5000, updatedAt: '2026-09-02T12:00:00+03:00' },
  ]);
  put('leads-meetings', [
    { id: 'm1', leadId: 'a1', phone: '0722111222', leadName: 'Wanjiru', meetingDate: '2026-10-05T10:00:00+03:00', done: false, notes: 'demo' },
    { id: 'm2', phone: '0799000000', leadName: 'Ghost', meetingDate: '2026-09-03', done: true },
  ]);
  put('leads-whatsapp-inbox', [{ id: 'wamid.L1', from: '254744000001', name: 'Ad Guy', text: 'hello from the ad', at: '2026-09-02T09:00:00Z', fromAd: true, adHeadline: 'Big Sale', adId: 'AD5' }]);
}
const snapshot = (c) => JSON.stringify([...c.kv.data.entries()].filter(([k]) => /^leads-/.test(k)).sort());

test('legacy migration: owner only, dry run writes nothing, carried-forward day-sheet records fold into one lead, KV untouched', async () => {
  const c = await makeCrm();
  seedKv(c);
  const m = await c.staff('Mona', 'manager');
  assert.equal((await c.api('POST', '/legacy/migrate', { token: m.token, body: { dryRun: true } })).status, 403);
  assert.equal((await c.api('GET', '/legacy/verify', { token: m.token })).status, 403);
  const before = snapshot(c);
  const leadsBefore = c.q('select count(*) n from crm_leads')[0].n;
  const dry = await c.ok('POST', '/legacy/migrate', { body: { dryRun: true } });
  assert.equal(dry.dryRun, true);
  assert.deepEqual([dry.counts.sheets, dry.counts.leadRecords, dry.counts.leads.found, dry.counts.leads.created, dry.counts.meetings.found], [2, 6, 4, 4, 2]);
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, leadsBefore, 'a dry run stores nothing');
  assert.equal(c.q('select count(*) n from crm_users where legacy_id is not null')[0].n, 0);
  const real = await c.ok('POST', '/legacy/migrate', { body: {} });
  assert.equal(real.dryRun, false); assert.deepEqual(real.errors, []);
  assert.deepEqual([real.counts.leads.created, real.counts.leads.failed, real.counts.staff.created, real.counts.meetings.created, real.counts.sales.created], [5, 0, 2, 2, 1], '4 folded leads + the ghost of meeting m2');
  assert.equal(snapshot(c), before, 'NOTHING in KV changed or was deleted');
  // folded: Wanjiru appears on two sheets under two ids and is ONE lead
  const w = c.q(`select * from crm_leads where legacy_id = 'lead:p:722111222'`)[0];
  assert.equal(c.q(`select count(*) n from crm_leads where name = 'Wanjiru'`)[0].n, 1);
  assert.deepEqual([w.phone, w.status_key, w.source_key], ['+254722111222', 'contacted', 'legacy']);
  assert.equal(c.q('select name from crm_users where id = ?', w.owner_id)[0].name, 'Bob');
  assert.ok(w.first_contact_at);
  assert.equal(JSON.parse(w.legacy_json).records.length, 2, 'the original records are kept verbatim');
  // won lead: a sale with the agreed / paid amounts, closed by the recorded person, customer link kept
  const o = c.q(`select * from crm_leads where legacy_id = 'lead:p:733000001'`)[0];
  assert.deepEqual([o.status_key, !!o.converted_at], ['won', true]);
  const sale = c.q('select * from crm_sales where lead_id = ?', o.id)[0];
  assert.deepEqual([sale.total, sale.amount_paid, sale.payment_status, sale.closed_by_name, sale.product_label.includes('Hotel')], [20000, 5000, 'partial', 'Ann', true]);
  assert.equal(c.q('select license_client_id l from crm_customers where lead_id = ?', o.id)[0].l, 'CL1');
  // lost, and no-phone lead keep their own identity
  assert.equal(c.q(`select status_key s from crm_leads where legacy_id = 'lead:p:733000002'`)[0].s, 'lost');
  const np = c.q(`select * from crm_leads where legacy_id = 'lead:i:d1'`)[0]; assert.equal(np.phone_norm, null); assert.equal(np.name, 'No Phone');
  // staff names: archived, cannot log in, history keeps their names
  const ann = c.q(`select * from crm_users where legacy_id = 'staff:ann'`)[0];
  assert.deepEqual([ann.archived, ann.login_disabled, ann.status], [1, 1, 'inactive']);
  assert.equal((await c.api('POST', '/auth/login', { token: null, body: { email: 'ann', password: 'x' } })).status >= 400, true);
  assert.equal((await c.ok('GET', '/staff?archived=1')).items.some((u) => u.name === 'Ann') || (await c.ok('GET', '/staff')).items.some((u) => u.name === 'Ann'), true);
  const d = await c.ok('GET', `/leads/${o.id}`);
  assert.equal(d.sales[0].closedByName, 'Ann'); assert.ok(d.timeline.some((t) => /Migrated/.test(t.summary)));
  // meetings
  const mt = c.q(`select * from crm_meetings where legacy_id = 'meeting:m1'`)[0];
  assert.equal(mt.starts_at, Date.parse('2026-10-05T10:00:00+03:00')); assert.equal(mt.lead_id, w.id);
  const m2 = c.q(`select * from crm_meetings where legacy_id = 'meeting:m2'`)[0];
  assert.equal(m2.starts_at, Date.parse('2026-09-03T09:00:00+03:00')); assert.match(m2.notes, /placeholder/);
  // whatsapp inbox -> conversation + message (+ a lead, since it is an ad chat)
  assert.equal(c.q(`select count(*) n from crm_messages where ext_id = 'wamid.L1'`)[0].n, 1);
  assert.equal(c.q(`select count(*) n from crm_leads where legacy_id like 'inboxlead:%'`)[0].n, 1);
  assert.equal(real.counts.inboxLeads.created, 1);
  // audit
  assert.equal(c.q(`select count(*) n from crm_audit where action = 'legacy_migrate'`)[0].n, 1);
  assert.equal(c.q(`select count(*) n from crm_audit where action = 'lead_migrate'`)[0].n >= 5, true);
});

test('legacy migration: idempotent (second run creates nothing, never overwrites CRM edits); verify compares counts and money', async () => {
  const c = await makeCrm();
  seedKv(c);
  const first = await c.ok('POST', '/legacy/migrate', { body: {} });
  const v1 = await c.ok('GET', '/legacy/verify');
  assert.equal(v1.ok, true, JSON.stringify(v1.match));
  assert.deepEqual([v1.kv.leads, v1.kv.won, v1.kv.lost, v1.kv.meetings, v1.kv.agreedTotal, v1.kv.paidTotal], [4, 1, 1, 2, 20000, 5000]);
  assert.deepEqual([v1.crm.leads, v1.crm.won, v1.crm.lost, v1.crm.meetings, v1.crm.agreedTotal, v1.crm.paidTotal], [5, 1, 1, 2, 20000, 5000].map((x, i) => (i === 0 ? 5 : x)));
  assert.deepEqual(v1.missingLeads, []);
  // a CRM edit survives a re-run
  const w = c.q(`select id from crm_leads where legacy_id = 'lead:p:722111222'`)[0].id;
  await c.ok('PATCH', `/leads/${w}`, { body: { name: 'Wanjiru Edited' } });
  await c.ok('POST', `/leads/${w}/classification`, { body: { value: 'hot' } });
  const counts0 = ['crm_leads', 'crm_sales', 'crm_meetings', 'crm_users', 'crm_conversations', 'crm_messages', 'crm_customers'].map((t) => c.q(`select count(*) n from ${t}`)[0].n);
  const again = await c.ok('POST', '/legacy/migrate', { body: {} });
  assert.deepEqual([again.counts.leads.created, again.counts.meetings.created, again.counts.sales.created, again.counts.staff.created, again.counts.messages.created], [0, 0, 0, 0, 0]);
  assert.equal(again.counts.leads.skipped, first.counts.leads.created - 1, 'the 4 sheet leads are skipped (the meeting-only lead is found by its legacy id too)');
  const counts1 = ['crm_leads', 'crm_sales', 'crm_meetings', 'crm_users', 'crm_conversations', 'crm_messages', 'crm_customers'].map((t) => c.q(`select count(*) n from ${t}`)[0].n);
  assert.deepEqual(counts1, counts0, 'no row was added');
  const e = c.q('select name, class_key from crm_leads where id = ?', w)[0]; assert.deepEqual([e.name, e.class_key], ['Wanjiru Edited', 'hot']);
  // a new sheet later: only the new person is added
  c.kv.data.set('leads-sheet:2026-09-03', { value: JSON.stringify([{ id: 'n1', name: 'Newcomer', phone: '0755123123' }, { id: 'a3', name: 'Wanjiru', phone: '0722111222' }]) });
  const later = await c.ok('POST', '/legacy/migrate', { body: {} });
  assert.equal(later.counts.leads.created, 1);
  assert.equal(c.q(`select count(*) n from crm_leads where name like 'Wanjiru%'`)[0].n, 1);
  // verify catches a difference: delete nothing in KV, but a lead missing in the CRM shows up
  c.kv.data.set('leads-sheet:2026-09-04', { value: JSON.stringify([{ id: 'z1', name: 'Later Person', phone: '0766555444' }]) });
  const v2 = await c.ok('GET', '/legacy/verify');
  assert.equal(v2.ok, false); assert.deepEqual(v2.missingLeads.map((x) => x.name), ['Later Person']);
  await c.ok('POST', '/legacy/migrate', { body: {} });
  assert.equal((await c.ok('GET', '/legacy/verify')).ok, true);
  // nothing in the old KV was ever removed
  assert.ok(c.kv.data.has('leads-staff-list') && c.kv.data.has('leads-meetings') && c.kv.data.has('leads-whatsapp-inbox') && c.kv.data.has('leads-sheet:2026-09-01'));
});

test('legacy migration: bad data does not stop the run; without KV it says so', async () => {
  const c = await makeCrm();
  c.kv.data.set('leads-sheet:2026-09-01', { value: '{not json' });
  c.kv.data.set('leads-sheet:2026-09-02', { value: JSON.stringify([null, 5, 'x', { id: 'ok', name: 'Fine', phone: '0722000111' }, { name: 'Weird phone', phone: '12ab' }]) });
  c.kv.data.set('leads-meetings', { value: JSON.stringify([{ id: 'bad', meetingDate: 'sometime', phone: '0700000001' }]) });
  const r = await c.ok('POST', '/legacy/migrate', { body: {} });
  assert.equal(r.counts.leads.failed, 0); assert.equal(r.counts.meetings.failed, 1); assert.match(r.errors.join(' '), /unreadable date/);
  assert.equal(c.q(`select count(*) n from crm_leads where name = 'Fine'`)[0].n, 1);
  assert.match(c.q(`select notes from crm_leads where name = 'Weird phone'`)[0].notes, /Legacy phone/);
  const c2 = await makeCrm(); delete c2.env.mydukapos_kv;
  assert.equal((await c2.api('POST', '/legacy/migrate', { body: {} })).status >= 400, true);
});
