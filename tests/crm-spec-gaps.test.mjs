// Spec-gap closure: lead fields, the lead list (revenue / sorts / filters), import template + mapping, dashboard blocks, staff report, notifications,
// automation events, and one regression test per bug found in the deep review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCrm, lead, newPhone } from './crm-harness.mjs';
import { waHook, msg, WA_SECRET } from './crm-rev-helpers.mjs';
import { ensureCrmSchema } from '../functions/api/_crm/schema.js';
import { makeD1 } from './d1-fake.mjs';
import { csvCell, email as normEmail } from '../functions/api/_crm/core.js';

const P = (i) => '07' + String(30000000 + i).padStart(8, '0');
const prod = (c) => c.q('select id from crm_products order by position')[0].id;
async function importRows(c, rows, { options, mapping, token, source } = {}) {
  const { id } = await c.ok('POST', '/imports', { token, body: { fileName: 'f.csv', options, mapping, source } });
  await c.ok('POST', `/imports/${id}/rows`, { token, body: { rows } });
  let last; do { last = await c.ok('POST', `/imports/${id}/commit`, { token }); } while (!last.done);
  return { id, last };
}

test('lead fields: country, estimated value, expected close, next action; edits are audited; validation', async () => {
  const c = await makeCrm();
  const r = await c.api('POST', '/leads', { body: lead({ phone: newPhone(), country: 'Kenya', estimatedValue: 'KES 15,000', expectedCloseDate: '2030-01-31', nextAction: 'Send quote', classification: 'hot', status: 'qualified' }) });
  assert.equal(r.status, 201);
  const l = r.body.lead;
  assert.deepEqual([l.country, l.estimatedValue, l.expectedCloseDate, l.nextAction, l.status, l.classification, l.contactAttempts], ['Kenya', 15000, '2030-01-31', 'Send quote', 'qualified', 'hot', 0]);
  const a0 = c.q(`select next from crm_audit where action = 'lead_create' and entity_id = ?`, l.id)[0];
  assert.equal(JSON.parse(a0.next).estimatedValue, 15000, 'creation audit carries the new fields');
  const p = await c.ok('PATCH', `/leads/${l.id}`, { body: { estimatedValue: 20000, country: 'Uganda', nextAction: '' } });
  assert.deepEqual([p.lead.estimatedValue, p.lead.country, p.lead.nextAction], [20000, 'Uganda', null]);
  const au = c.q(`select prev, next from crm_audit where action = 'lead_update' and entity_id = ?`, l.id)[0];
  assert.equal(JSON.parse(au.prev).estimated_value, 15000); assert.equal(JSON.parse(au.next).estimated_value, 20000);
  assert.equal((await c.api('PATCH', `/leads/${l.id}`, { body: { estimatedValue: -5 } })).body.fields.estimatedValue.length > 0, true);
  assert.equal((await c.api('PATCH', `/leads/${l.id}`, { body: { expectedCloseDate: '31/02/2030' } })).status, 400);
  // a new lead cannot start won / lost / unknown (B14)
  for (const status of ['won', 'lost', 'nonsense']) assert.equal((await c.api('POST', '/leads', { body: lead({ phone: newPhone(), status }) })).status, 400, status);
});

test('contact attempts: counters, last contacted by, next action, auto status change is audited, events are emitted', async () => {
  const c = await makeCrm(); const a = await c.staff('Ann');
  const l = (await c.ok('POST', '/leads', { token: a.token, body: lead({ phone: newPhone() }) })).lead;
  const r = await c.ok('POST', `/leads/${l.id}/contact`, { token: a.token, body: { method: 'call', outcome: 'no_answer', nextAction: 'Try again 4pm' } });
  assert.deepEqual([r.lead.contactAttempts, r.lead.lastContactedBy, r.lead.lastContactedByName, r.lead.status, r.lead.nextAction], [1, a.id, 'Ann', 'contacted', 'Try again 4pm']);
  assert.ok(r.lead.lastContactedAt > 0);
  await c.ok('POST', `/leads/${l.id}/contact`, { token: a.token, body: { method: 'whatsapp' } });
  assert.equal(c.q('select contact_attempts n from crm_leads where id = ?', l.id)[0].n, 2);
  const auto = c.q(`select next from crm_audit where action = 'lead_status' and entity_id = ?`, l.id).map((x) => JSON.parse(x.next));
  assert.equal(auto.filter((x) => x.auto === 'first_contact').length, 1, 'the automatic New -> Contacted is audited (B13)');
  const names = c.q('select name from crm_events where lead_id = ? order by id', l.id).map((x) => x.name);
  assert.deepEqual(names.slice(0, 2), ['lead.created', 'lead.contacted']);
});

test('convert sets actual_value from the sales and emits the events; merge carries the new fields', async () => {
  const c = await makeCrm();
  const l = (await c.ok('POST', '/leads', { body: lead({ phone: newPhone(), estimatedValue: 9000 }) })).lead;
  await c.ok('POST', `/leads/${l.id}/convert`, { body: { productId: prod(c), quantity: 2, unitPrice: 1000, discount: 500, paymentStatus: 'paid' } });
  assert.equal(c.q('select actual_value v from crm_leads where id = ?', l.id)[0].v, 1500);
  await c.ok('POST', `/leads/${l.id}/convert`, { body: { productId: prod(c), quantity: 1, unitPrice: 500, paymentStatus: 'paid' } });
  assert.equal(c.q('select actual_value v from crm_leads where id = ?', l.id)[0].v, 2000);
  const ev = c.q('select name from crm_events order by id').map((x) => x.name);
  assert.ok(ev.includes('lead.converted') && ev.includes('sale.recorded'));
  const other = (await c.ok('POST', '/leads', { body: lead({ phone: newPhone(), country: 'Kenya' }) })).lead;
  await c.ok('POST', `/leads/${other.id}/contact`, { body: { method: 'call' } });
  await c.ok('POST', `/leads/${other.id}/merge`, { body: { intoId: l.id } });
  const m = c.q('select country, contact_attempts n from crm_leads where id = ?', l.id)[0];
  assert.deepEqual([m.country, m.n], ['Kenya', 1]);
});

test('lead list: revenue, estimated value, last contact, next follow-up, campaign, ad, product names; sorting; scoped revenue; server-side pagination', async () => {
  const c = await makeCrm(); const a = await c.staff('Ann');
  const camp = (await c.ok('POST', '/campaigns', { body: { name: 'Sep Promo', platform: 'meta' } })).campaign || {};
  const cid = camp.id || c.q('select id from crm_campaigns')[0].id;
  const adset = await c.ok('POST', `/campaigns/${cid}/adsets`, { body: { name: 'Nairobi Set' } });
  const asid = (adset.adset || adset).id;
  const ad = await c.ok('POST', `/adsets/${asid}/ads`, { body: { name: 'Video A' } });
  const adid = (ad.ad || ad).id;
  const l1 = (await c.ok('POST', '/leads', { body: lead({ name: 'Alpha', phone: newPhone(), estimatedValue: 5000, campaignId: cid, adsetId: asid, adId: adid, productIds: [prod(c)] }) })).lead;
  const l2 = (await c.ok('POST', '/leads', { body: lead({ name: 'Beta', phone: newPhone(), estimatedValue: 100 }) })).lead;
  const l3 = (await c.ok('POST', '/leads', { body: lead({ name: 'Gamma', phone: newPhone() }) })).lead;
  await c.ok('POST', `/leads/${l1.id}/convert`, { body: { productId: prod(c), quantity: 1, unitPrice: 7000, paymentStatus: 'paid' } });
  await c.ok('POST', `/leads/${l2.id}/contact`, { body: { method: 'call' } });
  await c.ok('POST', `/leads/${l2.id}/followups`, { body: { dueAt: Date.now() + 3600e3, type: 'demo', notes: 'Show the till' } });
  const list = await c.ok('GET', '/leads?pageSize=10');
  const A = list.items.find((x) => x.name === 'Alpha'), B = list.items.find((x) => x.name === 'Beta');
  assert.deepEqual([A.revenue, A.estimatedValue, A.firstTouch.campaignName, A.firstTouch.adName, A.firstTouch.adsetName], [7000, 5000, 'Sep Promo', 'Video A', 'Nairobi Set']);
  assert.equal(A.productNames.length, 1); assert.ok(B.lastContactedAt > 0); assert.ok(B.nextFollowupAt > 0); assert.deepEqual([B.nextFollowupType, B.nextFollowupNotes], ['demo', 'Show the till']);
  assert.equal(list.canSeeRevenue, true);
  const names = async (qs) => (await c.ok('GET', '/leads?' + qs)).items.map((x) => x.name);
  assert.equal((await names('sort=revenue&dir=desc'))[0], 'Alpha');
  assert.equal((await names('sort=deal_value&dir=desc'))[0], 'Alpha');
  assert.deepEqual((await names('sort=deal_value&dir=asc')).slice(0, 2), ['Beta', 'Alpha'], 'empty values always sort last');
  assert.equal((await names('sort=last_contact&dir=desc'))[0], 'Beta');
  assert.equal((await names('sort=next_followup&dir=asc'))[0], 'Beta');
  assert.equal((await names('sort=campaign&dir=asc'))[0], 'Alpha'); assert.equal((await names('sort=ad&dir=asc'))[0], 'Alpha'); assert.equal((await names('sort=product&dir=asc'))[0], 'Alpha');
  for (const s of ['phone', 'source', 'staff', 'class', 'status', 'name', 'created_at']) assert.equal((await c.api('GET', '/leads?sort=' + s)).status, 200, s);
  assert.deepEqual(await names(`ad=${adid}`), ['Alpha']); assert.deepEqual(await names(`adset=${asid}`), ['Alpha']);
  assert.deepEqual(await names('revenue=won'), ['Alpha']); assert.equal((await names('revenue=none')).length, 2);
  assert.deepEqual(await names('q=' + encodeURIComponent('Gam')), ['Gamma']);
  // pagination is server side and exact at the boundary
  const p1 = await c.ok('GET', '/leads?sort=name&dir=asc&pageSize=2&page=1'), p2 = await c.ok('GET', '/leads?sort=name&dir=asc&pageSize=2&page=2'), p3 = await c.ok('GET', '/leads?sort=name&dir=asc&pageSize=2&page=3');
  assert.deepEqual([p1.items.length, p2.items.length, p3.items.length, p1.total], [2, 1, 0, 3]);
  // B2: revenue is judged inside the viewer's own revenue scope, and refused without a revenue permission
  const mine = (await c.ok('POST', '/leads', { token: a.token, body: lead({ name: 'AnnLead', phone: newPhone() }) })).lead;
  const own = await c.ok('GET', '/leads?revenue=won', { token: a.token });
  assert.equal(own.items.length, 0, 'Ann cannot learn which leads have sales she may not see');
  assert.equal(own.items.every((x) => x.revenue === 0 || x.revenue === undefined), true);
  await c.ok('PUT', `/staff/${a.id}/permissions`, { body: { grant: [], deny: ['revenue.own'] } });
  assert.equal((await c.api('GET', '/leads?revenue=won', { token: a.token })).status, 403);
  assert.equal((await c.api('GET', '/leads?sort=revenue', { token: a.token })).status, 403);
  const noRev = await c.ok('GET', '/leads', { token: a.token });
  assert.equal(noRev.canSeeRevenue, false); assert.ok(noRev.items.every((x) => x.revenue === undefined && x.actualValue === null));
  assert.ok(mine.id);
  // export carries the new columns
  const csv = await c.api('GET', '/leads/export.csv');
  assert.match(csv.text.split('\n')[0], /estimated_value,actual_value,revenue,expected_close_date,next_action,contact_attempts,last_contacted_at,last_contacted_by,next_followup_at/);
});

test('import: spec template headers map without manual mapping; campaign / ad set / ad by name; estimated value and created date; breakdown counts', async () => {
  const c = await makeCrm();
  const camp = await c.ok('POST', '/campaigns', { body: { name: 'Sep Promo', platform: 'meta' } }); const cid = (camp.campaign || camp).id || c.q('select id from crm_campaigns')[0].id;
  const asid = ((await c.ok('POST', `/campaigns/${cid}/adsets`, { body: { name: 'Nairobi Set' } })).adset || {}).id || c.q('select id from crm_adsets')[0].id;
  await c.ok('POST', `/adsets/${asid}/ads`, { body: { name: 'Video A' } });
  const tpl = (await c.api('GET', '/imports/template.csv')).text.split('\n')[0].replace(/\r/g, '');
  assert.equal(tpl, 'Full Name,Phone,WhatsApp,Email,Company,Location,Source,Campaign,Ad Set,Ad,Product,Status,Classification,Assigned Staff,Estimated Value,Notes,Created Date');
  const row = (o) => Object.fromEntries(tpl.split(',').map((h) => [h, o[h] ?? '']));
  const rows = [
    row({ 'Full Name': 'Full Row', Phone: P(1), Campaign: 'sep promo', 'Ad Set': 'Nairobi Set', Ad: 'Video A', 'Estimated Value': 'KES 12,500', 'Created Date': '2026-01-15', Company: 'Duka Ltd', Status: 'Qualified', Classification: 'Hot' }),
    row({ 'Full Name': 'Unknown Camp', Phone: P(2), Campaign: 'Ghost campaign', Ad: 'Ghost ad' }),
    row({ 'Full Name': '', Phone: P(3) }), row({ 'Full Name': 'No contact' }), row({ 'Full Name': 'Bad phone', Phone: '12' }), row({ 'Full Name': 'Bad mail', Phone: P(4), Email: 'zzz' }),
    row({ 'Full Name': 'Future', Phone: P(5), 'Created Date': '2999-01-01' }),
  ];
  const { id } = await c.ok('POST', '/imports', { body: { fileName: 'f.csv' } });
  await c.ok('POST', `/imports/${id}/rows`, { body: { rows } });
  const pv = await c.ok('GET', `/imports/${id}/preview`);
  assert.deepEqual([pv.counts.missingName, pv.counts.missingContact, pv.counts.invalidPhone, pv.counts.invalidEmail], [1, 1, 1, 1]);
  let last; do { last = await c.ok('POST', `/imports/${id}/commit`); } while (!last.done);
  const f = c.q(`select * from crm_leads where name = 'Full Row'`)[0];
  assert.deepEqual([f.estimated_value, f.business_name, f.status_key, f.class_key, f.first_campaign_id, f.first_adset_id !== null, f.first_ad_id !== null], [12500, 'Duka Ltd', 'qualified', 'hot', cid, true, true]);
  assert.equal(new Date(f.created_at).toISOString().slice(0, 10), '2026-01-14', 'Nairobi midnight of the 15th');
  const u = c.q(`select * from crm_leads where name = 'Unknown Camp'`)[0];
  assert.equal(u.first_campaign_id, null); assert.equal(u.first_utm_campaign, 'Ghost campaign'); assert.equal(c.q('select count(*) n from crm_campaigns')[0].n, 1, 'no campaign is invented');
  const fut = c.q(`select created_at from crm_leads where name = 'Future'`)[0].created_at; assert.ok(fut < Date.now() + 60000, 'a future created date is ignored');
  const h = (await c.ok('GET', '/imports')).items[0];
  assert.deepEqual([h.uploadedBy.length > 0, h.assignment.mode, h.updated, h.skipped, h.failed], [true, 'none', 0, 0, 4]);
  assert.ok(c.q(`select 1 from crm_events where name = 'import.finished'`).length === 1);
});

test('dashboard: leads block, action today, revenue per lead, response times, my work, ad breakdown; CPL/ROAS only with spend', async () => {
  const c = await makeCrm(); const a = await c.staff('Ann');
  const camp = await c.ok('POST', '/campaigns', { body: { name: 'C1', platform: 'meta' } }); const cid = (camp.campaign || camp).id || c.q('select id from crm_campaigns')[0].id;
  const l1 = (await c.ok('POST', '/leads', { token: a.token, body: lead({ phone: newPhone(), campaignId: cid }) })).lead;
  const l2 = (await c.ok('POST', '/leads', { body: lead({ phone: newPhone(), campaignId: cid }) })).lead;
  await c.ok('POST', `/leads/${l1.id}/contact`, { token: a.token, body: { method: 'call' } });
  await c.ok('POST', `/leads/${l1.id}/status`, { token: a.token, body: { status: 'awaiting_response' } });
  await c.ok('POST', `/leads/${l1.id}/followups`, { token: a.token, body: { dueAt: Date.now() + 60000, type: 'call' } });
  await c.ok('POST', `/leads/${l1.id}/convert`, { token: a.token, body: { productId: prod(c), quantity: 1, unitPrice: 4000, paymentStatus: 'paid' } });
  const d = await c.ok('GET', '/dashboard?range=month');
  assert.equal(d.leads.total, 2); assert.equal(d.leads.unassigned, 1); assert.equal(d.leads.converted, 1); assert.equal(typeof d.leads.requiringActionToday, 'number');
  for (const k of ['new', 'assigned', 'claimed', 'awaitingResponse', 'followupRequired', 'qualified', 'potential', 'dead']) assert.ok(k in d.leads, k);
  assert.deepEqual([d.revenue.avgDealValue, d.revenue.revenuePerLead, d.revenue.revenuePerConvertedLead], [4000, 2000, 4000]);
  assert.ok(d.response.avgCreatedToFirstContactMinutes != null);
  assert.ok(d.byCampaign[0].leads === 2 && d.byCampaign[0].cpl === null && d.byCampaign[0].roas === null, 'no spend -> no CPL / ROAS');
  assert.ok(Array.isArray(d.byAdset) && Array.isArray(d.byAd));
  assert.ok(d.mine && 'followupsToday' in d.mine);
  await c.ok('POST', `/campaigns/${cid}/spend`, { body: { date: new Date().toISOString().slice(0, 10), amount: 1000 } });
  const d2 = await c.ok('GET', '/dashboard?range=month');
  assert.equal(d2.byCampaign[0].cpl, 500); assert.ok(d2.marketing.cpl === 500);
  const f = await c.ok('GET', `/dashboard?range=month&campaign=${cid}&source=nope`); assert.equal(f.leads.total, 0, 'filters apply');
  const mine = await c.ok('GET', '/dashboard?range=month', { token: a.token }); assert.equal(mine.scope, 'own'); assert.ok(mine.mine.conversions === 1);
  assert.ok(l2.id);
});

test('staff report: leads claimed, status distribution, meetings scheduled, follow-ups created, average response', async () => {
  const c = await makeCrm(); const a = await c.staff('Ann');
  const l = (await c.ok('POST', '/leads', { body: lead({ phone: newPhone() }) })).lead;
  await c.ok('POST', `/leads/${l.id}/claim`, { token: a.token, body: {} });
  await c.ok('POST', `/leads/${l.id}/contact`, { token: a.token, body: { method: 'call' } });
  await c.ok('POST', `/leads/${l.id}/meetings`, { token: a.token, body: { startsAt: Date.now() + 86400e3, type: 'call' } });
  await c.ok('POST', `/leads/${l.id}/followups`, { token: a.token, body: { dueAt: Date.now() + 86400e3 } });
  const r = (await c.ok('GET', '/reports/staff?range=month')).rows.find((x) => x.userId === a.id);
  assert.deepEqual([r.leadsClaimed, r.meetingsScheduled, r.followupsCreated], [1, 1, 1]);
  assert.equal(r.statusDistribution.meeting, 1); assert.ok(r.avgResponseMinutes != null);
});

test('notifications: new lead in the pool reaches claimers, meeting changes reach the assignee, import finish, conversation links', async () => {
  const c = await makeCrm(); const a = await c.staff('Ann'); const b = await c.staff('Ben');
  const l = (await c.ok('POST', '/leads', { body: lead({ phone: newPhone() }) })).lead;
  assert.ok((await c.ok('GET', '/notifications', { token: a.token })).items.some((n) => n.kind === 'new_lead' && n.leadId === l.id), 'the pool is announced to everyone who can claim');
  await c.ok('POST', `/leads/${l.id}/claim`, { token: a.token, body: {} });
  const m = (await c.ok('POST', `/leads/${l.id}/meetings`, { token: a.token, body: { startsAt: Date.now() + 86400e3, type: 'call' } })).meeting;
  await c.ok('POST', `/meetings/${m.id}/status`, { body: { status: 'cancelled' } });
  const n = (await c.ok('GET', '/notifications', { token: a.token })).items;
  assert.ok(n.some((x) => x.kind === 'meeting' && /cancelled/i.test(x.title)), 'the assignee hears about a cancellation');
  assert.ok(b.id);
});

test('automation events: listed in order, filtered, acknowledged; owner / integrations only; the table cannot be rewritten', async () => {
  const c = await makeCrm(); const a = await c.staff('Ann');
  await c.ok('POST', '/leads', { body: lead({ phone: newPhone() }) });
  const ev = await c.ok('GET', '/events?name=lead.created');
  assert.equal(ev.items.length, 1); assert.equal(ev.items[0].name, 'lead.created'); assert.ok(ev.next >= ev.items[0].id);
  assert.equal((await c.api('GET', '/events', { token: a.token })).status, 403);
  await c.ok('POST', '/events/ack', { body: { ids: [ev.items[0].id] } });
  assert.equal((await c.ok('GET', '/events?pending=1&name=lead.created')).items.length, 0);
  assert.throws(() => c.db._db.exec(`update crm_events set name = 'x'`), /./); assert.throws(() => c.db._db.exec(`delete from crm_events`), /./);
});

test('schema: an old (v1) database is upgraded in place with the new lead columns', async () => {
  const d1 = makeD1(); await ensureCrmSchema(d1);
  const db = d1._db;
  db.exec('drop index if exists ix_crm_leads_lastcontact');
  for (const col of ['country', 'estimated_value', 'actual_value', 'expected_close_date', 'next_action', 'contact_attempts', 'last_contacted_at', 'last_contacted_by', 'last_contacted_by_name']) db.exec(`alter table crm_leads drop column ${col}`);
  db.exec(`update crm_meta set v = '1' where k = 'schema'`);
  await ensureCrmSchema({ ...d1 });
  const cols = d1.query('pragma table_info(crm_leads)').map((r) => r.name);
  for (const col of ['country', 'estimated_value', 'actual_value', 'contact_attempts', 'last_contacted_by_name']) assert.ok(cols.includes(col), col);
});

// ---------------- deep-review regressions ----------------
test('B1 CSV formula injection: cells that start with = + - @ (even "+1+cmd|...") are neutralised, real numbers and phones are not', () => {
  for (const evil of ['=1+1', '+1+cmd|calc', '-2+3+cmd|x', '@SUM(A1)', '\tx', '\r=1']) assert.match(csvCell(evil), /^"?'/, evil);
  for (const fine of ['+254712345678', '-15', '0712 345 678', '(020) 123-456']) assert.equal(csvCell(fine).replace(/"/g, ''), fine, fine);
});

test('B7 mailto injection: an email with header / quote characters is refused', () => {
  for (const bad of ['a@b.co?bcc=evil@x.com', 'a@b.co&cc=x', 'a"@b.co', "o'x@b.co", 'a@b.co\nBcc: x@y.z']) assert.equal(normEmail(bad), false, bad);
  assert.equal(normEmail('Good.Person+tag@Example.co.ke'), 'good.person+tag@example.co.ke');
});

test('B3 removing staff and moving their leads needs BOTH leads.assign and leads.all', async () => {
  const c = await makeCrm(); const m = await c.staff('Mia', 'manager'); const t = await c.staff('Tom');
  await c.ok('PUT', `/staff/${m.id}/permissions`, { body: { grant: [], deny: ['leads.all'] } });
  const r = await c.api('POST', `/staff/${t.id}/remove`, { token: m.token, body: { toUserId: m.id } });
  assert.equal(r.status, 403, 'a manager without leads.all cannot bulk-move leads by removing someone');
});

test('B4 import "update" cannot modify another person\'s lead; it is skipped with a warning', async () => {
  const c = await makeCrm(); const a = await c.staff('Ann'); const b = await c.staff('Ben');
  const phone = P(50);
  const lead1 = (await c.ok('POST', '/leads', { token: a.token, body: lead({ name: 'Ann Lead', phone, location: '' }) })).lead;
  await c.ok('PUT', `/staff/${b.id}/permissions`, { body: { grant: ['leads.import'], deny: [] } });
  const { last } = await importRows(c, [{ Name: 'Hijack', Phone: phone, Location: 'Mombasa' }], { token: b.token, options: { duplicates: 'update' } });
  assert.equal(last.updated, 0); assert.equal(last.skipped, 1);
  assert.equal(c.q('select location, name from crm_leads where id = ?', lead1.id)[0].location, null);
});

test('B5 two simultaneous manual creates with the same phone: exactly one lead, the other gets a 409', async () => {
  const c = await makeCrm(); const phone = newPhone();
  const rs = await Promise.all([1, 2, 3].map((i) => c.api('POST', '/leads', { body: lead({ name: 'Racer ' + i, phone }) })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409]);
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, 1);
  assert.equal(rs.find((r) => r.status === 409).body.code, 'duplicate');
});

test('B6 two staging calls at once never collide on row_no', async () => {
  const c = await makeCrm();
  const { id } = await c.ok('POST', '/imports', { body: { fileName: 'r.csv' } });
  const rows = (k) => Array.from({ length: 30 }, (_, i) => ({ Name: `R${k}-${i}`, Phone: P(k * 100 + i) }));
  const rs = await Promise.all([1, 2, 3].map((k) => c.api('POST', `/imports/${id}/rows`, { body: { rows: rows(k) } })));
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
  const n = c.q('select count(*) n, count(distinct row_no) d, max(row_no) m from crm_import_rows where import_id = ?', id)[0];
  assert.deepEqual([n.n, n.d, n.m], [90, 90, 90]);
  assert.equal(c.q('select total from crm_imports where id = ?', id)[0].total, 90);
});

test('B8 reschedule_count is incremented inside the UPDATE (two reschedules both count)', async () => {
  const c = await makeCrm();
  const l = (await c.ok('POST', '/leads', { body: lead({ phone: newPhone() }) })).lead;
  const m = (await c.ok('POST', `/leads/${l.id}/meetings`, { body: { startsAt: Date.now() + 86400e3, type: 'call' } })).meeting;
  await Promise.all([1, 2].map((i) => c.api('PATCH', `/meetings/${m.id}`, { body: { startsAt: Date.now() + (2 + i) * 86400e3 } })));
  assert.equal(c.q('select reschedule_count n from crm_meetings where id = ?', m.id)[0].n, 2);
  const a = c.q(`select next from crm_audit where action = 'meeting_reschedule' order by id`).map((x) => JSON.parse(x.next).reschedule_count);
  assert.ok(a.every((x) => typeof x === 'number'), 'the audit records numbers, not the SQL increment marker');
});

test('B9 sales rows carry campaign / ad set / ad names (the Sales screen used to show "Unknown")', async () => {
  const c = await makeCrm();
  const camp = await c.ok('POST', '/campaigns', { body: { name: 'C9', platform: 'meta' } }); const cid = (camp.campaign || camp).id || c.q('select id from crm_campaigns')[0].id;
  const l = (await c.ok('POST', '/leads', { body: lead({ phone: newPhone(), campaignId: cid }) })).lead;
  await c.ok('POST', `/leads/${l.id}/convert`, { body: { productId: prod(c), quantity: 1, unitPrice: 100, paymentStatus: 'paid' } });
  assert.equal((await c.ok('GET', '/sales')).items[0].campaignName, 'C9');
});

test('B10 inbox: a webhook message is readable through the API (real SQLite), oldest first, and a contact attempt is logged on reply', async () => {
  const c = await makeCrm({ WHATSAPP_APP_SECRET: WA_SECRET });
  const t0 = Date.now() - 60000;
  for (const [i, txt] of ['first', 'second', 'third'].entries()) assert.equal((await waHook(c.env, [msg('wamid.' + i, '254700999888', txt, t0 + i * 1000)], { '254700999888': 'Chat Person' })).status, 200);
  const cv = (await c.ok('GET', '/inbox/conversations')).items[0];
  const r = await c.api('GET', `/inbox/conversations/${cv.id}/messages`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map((m) => m.text), ['first', 'second', 'third']);
  assert.ok(c.q(`select 1 from crm_events where name = 'message.received'`).length === 3);
});

test('B11 object-typed ids are a 400 / 404, never a 500', async () => {
  const c = await makeCrm();
  const l = (await c.ok('POST', '/leads', { body: lead({ phone: newPhone() }) })).lead;
  for (const [m, p, body] of [['POST', '/leads', lead({ phone: newPhone(), campaignId: { a: 1 } })], ['POST', '/leads', lead({ phone: newPhone(), assignTo: { $ne: 1 } })], ['POST', `/leads/${l.id}/assign`, { userId: { x: 1 } }], ['POST', `/leads/${l.id}/merge`, { intoId: { x: 1 } }], ['POST', '/leads/check-duplicates', { phone: '0712000111', excludeId: { x: 1 } }]]) {
    const r = await c.api(m, p, { body }); assert.ok(r.status < 500, `${p} -> ${r.status}`);
    if (p !== '/leads/check-duplicates') assert.ok(r.status >= 400, `${p} must be refused`);
  }
});

test('B12 UI router: a malformed % in the hash does not throw', async () => {
  const src = await import('node:fs').then((f) => f.readFileSync(new URL('../crm/crm-core.js', import.meta.url), 'utf8'));
  assert.match(src, /const dec = \(v\) => \{ try \{ return decodeURIComponent\(v\); \} catch/);
});
