import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCrm, lead, newPhone } from './crm-harness.mjs';

// zip 162: the follow-up cases use "in 1-3 hours" - near midnight EAT that lands on tomorrow. Pin the clock to midday EAT (09:00 UTC) of today; it still ticks.
{ const real = Date.now.bind(Date), d = new Date(real()); d.setUTCHours(9, 0, 0, 0); const off = d.getTime() - real(); Date.now = () => real() + off; }
const shop = (c) => c.q(`select id from crm_products where key = 'shop'`)[0].id;

test('single lead: validation errors name the field; phones are normalised; nothing is stored on a bad request', async () => {
  const c = await makeCrm();
  let r = await c.api('POST', '/leads', { body: {} });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'validation_error'); assert.ok(r.body.fields.name && r.body.fields.phone);
  r = await c.api('POST', '/leads', { body: { name: 'A', phone: '12345' } }); assert.ok(r.body.fields.phone);
  r = await c.api('POST', '/leads', { body: { name: 'A', phone: '0812345678' } }); assert.ok(r.body.fields.phone, 'not a Safaricom-style number');
  r = await c.api('POST', '/leads', { body: { name: 'A', email: 'nope' } }); assert.ok(r.body.fields.email);
  r = await c.api('POST', '/leads', { body: { name: 'A', phone: '0712345678', source: 'carrier-pigeon' } }); assert.ok(r.body.fields.source);
  r = await c.api('POST', '/leads', { body: { name: 'A', phone: '0712345678', classification: 'boiling' } }); assert.ok(r.body.fields.classification);
  r = await c.api('POST', '/leads', { body: { name: 'A', phone: '0712345678', productIds: ['nope'] } }); assert.equal(r.body.code, 'invalid_product');
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, 0);
  for (const [i, raw] of ['0712345678', '+254712345678', '254712345678', '712345678', '+254 712-345-678', '00254712345678'].entries()) {
    const x = await c.api('POST', '/leads', { body: { name: 'N' + i, phone: raw, force: i > 0 } });
    assert.equal(x.status, 201, raw); assert.equal(x.body.lead.phone, '+254712345678'); assert.equal(c.q('select phone_norm from crm_leads where id = ?', x.body.lead.id)[0].phone_norm, '254712345678');
  }
  r = await c.api('POST', '/leads', { body: { name: 'Intl', phone: '+44 7700 900123' } });
  assert.equal(r.body.lead.phone, '+447700900123', 'other countries are kept as given');
  const ok = (await c.ok('POST', '/leads', { body: lead({ name: '  Wanjiku   ', phone: newPhone(), email: 'W@Shop.CO.KE', businessName: 'Wanjiku Hardware', location: 'Thika', source: 'referral', classification: 'hot', notes: 'met at expo', productIds: [shop(c)] }) })).lead;
  assert.deepEqual([ok.name, ok.email, ok.source, ok.classification, ok.status, ok.notes, ok.productIds.length], ['Wanjiku', 'w@shop.co.ke', 'referral', 'hot', 'new', 'met at expo', 1]);
  assert.equal(ok.ownerId, null, 'a manager / owner leaves it in the pool unless assigned');
  assert.equal(c.q(`select count(*) n from crm_audit where action = 'lead_create' and entity_id = ?`, ok.id)[0].n, 1);
});

test('duplicates: same phone / WhatsApp / e-mail in any format -> 409 with the matches; force adds anyway; mergeInto merges instead; nothing is invented', async () => {
  const c = await makeCrm();
  const a = (await c.ok('POST', '/leads', { body: lead({ name: 'Original', phone: '0711000111', email: 'orig@x.co.ke', notes: 'first' }) })).lead;
  let r = await c.api('POST', '/leads', { body: { name: 'Same phone', phone: '+254 711 000 111' } });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'duplicate'); assert.equal(r.body.duplicates.length, 1);
  assert.deepEqual([r.body.duplicates[0].id, r.body.duplicates[0].matchedOn], [a.id, ['phone']]);
  r = await c.api('POST', '/leads', { body: { name: 'Same email', email: 'ORIG@x.co.ke' } });
  assert.equal(r.status, 409); assert.deepEqual(r.body.duplicates[0].matchedOn, ['email']);
  r = await c.api('POST', '/leads', { body: { name: 'WA', whatsapp: '0711000111' } });
  assert.equal(r.status, 409, 'a WhatsApp number that is another lead\'s phone is a duplicate'); assert.deepEqual(r.body.duplicates[0].matchedOn, ['phone']);
  r = await c.api('POST', '/leads', { body: { name: 'Fresh', phone: '0711999888' } }); assert.equal(r.status, 201);
  // check-duplicates endpoint (used by the form as you type)
  const chk = await c.ok('POST', '/leads/check-duplicates', { body: { phone: '0711000111' } });
  assert.equal(chk.duplicates.length, 1);
  assert.equal((await c.ok('POST', '/leads/check-duplicates', { body: { phone: '0700000000' } })).duplicates.length, 0);
  // force
  r = await c.api('POST', '/leads', { body: { name: 'Twin', phone: '0711000111', force: true } });
  assert.equal(r.status, 201); assert.equal(c.q('select count(*) n from crm_leads where phone_norm = ?', '254711000111')[0].n, 2);
  // mergeInto: fills blanks, appends notes, adds products, no new lead
  const before = c.q('select count(*) n from crm_leads')[0].n;
  r = await c.api('POST', '/leads', { body: { name: 'Ignored name', phone: '0711000111', email: 'other@x.co.ke', businessName: 'Orig Ltd', location: 'Nairobi', notes: 'second call', productIds: [shop(c)], mergeInto: a.id, utm_source: 'facebook', utm_campaign: 'sept' } });
  assert.equal(r.status, 200); assert.equal(r.body.merged, true);
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, before, 'no new lead');
  const m = r.body.lead;
  assert.deepEqual([m.name, m.email, m.businessName, m.location, m.notes], ['Original', 'orig@x.co.ke', 'Orig Ltd', 'Nairobi', 'first\nsecond call'], 'existing values are never overwritten, blanks are filled');
  assert.equal(m.productIds.length, 1);
  const d = await c.ok('GET', `/leads/${a.id}`);
  assert.equal(d.attributions.length, 2, 'the merge is kept as a touch'); assert.equal(d.attributions[1].utmSource, 'facebook');
  assert.equal(d.lead.firstTouch.utmSource, null, 'the FIRST attribution is untouched');
  assert.ok(d.timeline.some((t) => t.type === 'merge'));
  // editing into a phone that another lead has is refused unless forced
  const other = (await c.ok('POST', '/leads', { body: lead({ name: 'Other', phone: '0755000111' }) })).lead;
  r = await c.api('PATCH', `/leads/${other.id}`, { body: { phone: '0711000111' } });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'duplicate');
  assert.equal((await c.api('PATCH', `/leads/${other.id}`, { body: { phone: '0711000111', force: true } })).status, 200);
});

test('merge two existing leads: history moves to the survivor, the other is kept (not deleted) and hidden', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann');
  const keep = (await c.ok('POST', '/leads', { token: a.token, body: lead({ name: 'Keep', phone: newPhone() }) })).lead;
  const gone = (await c.ok('POST', '/leads', { token: a.token, body: lead({ name: 'Gone', phone: newPhone(), email: 'gone@x.co.ke' }) })).lead;
  await c.ok('POST', `/leads/${gone.id}/note`, { token: a.token, body: { text: 'important history' } });
  await c.ok('POST', `/leads/${gone.id}/followups`, { token: a.token, body: { dueAt: Date.now() + 7200000, type: 'call' } });
  await c.ok('POST', `/leads/${gone.id}/products`, { token: a.token, body: { productIds: [shop(c)] } });
  await c.ok('POST', `/leads/${gone.id}/convert`, { token: a.token, body: { productId: shop(c), quantity: 1, unitPrice: 3000, paymentStatus: 'paid' } });
  assert.equal((await c.api('POST', `/leads/${gone.id}/merge`, { token: a.token, body: { intoId: gone.id } })).status, 400);
  const r = await c.ok('POST', `/leads/${gone.id}/merge`, { token: a.token, body: { intoId: keep.id } });
  assert.equal(r.lead.email, 'gone@x.co.ke');
  const d = await c.ok('GET', `/leads/${keep.id}`);
  assert.ok(d.timeline.some((t) => t.summary === 'important history'), 'notes moved'); assert.equal(d.followups.length, 1); assert.equal(d.sales.length, 1); assert.equal(d.products.length, 1);
  assert.equal((await c.api('GET', `/leads/${gone.id}`, { token: a.token })).status, 404, 'the merged-away lead is hidden');
  const row = c.q('select deleted_at, merged_into_id from crm_leads where id = ?', gone.id)[0];
  assert.ok(row.deleted_at && row.merged_into_id === keep.id, 'kept, marked merged');
  assert.equal(c.q('select count(*) n from crm_leads where owner_id is not null and deleted_at is not null')[0].n, 0);
});

test('search, filters, sort and paging', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann');
  const mk = async (name, extra = {}) => (await c.ok('POST', '/leads', { body: lead({ name, phone: newPhone(), ...extra }) })).lead;
  const l1 = await mk('Alpha Traders', { email: 'alpha@x.co.ke', source: 'website', classification: 'hot', location: 'Nakuru' });
  const l2 = await mk('Beta Pharmacy', { source: 'referral', classification: 'cold', productIds: [c.q(`select id from crm_products where key = 'pharmacy'`)[0].id] });
  const l3 = await mk('Gamma Hotel', { source: 'website', productIds: [c.q(`select id from crm_products where key = 'hotel'`)[0].id] });
  await c.ok('POST', `/leads/${l2.id}/assign`, { body: { userId: a.id } });
  await c.ok('POST', `/leads/${l2.id}/status`, { body: { status: 'contacted' } });
  await c.ok('POST', `/leads/${l1.id}/followups`, { body: { dueAt: Date.now() + 3600000, type: 'call' } }).catch(() => null);
  const names = async (qs) => (await c.ok('GET', '/leads?' + qs)).items.map((x) => x.name).sort();
  assert.deepEqual(await names('q=alpha'), ['Alpha Traders']);
  assert.deepEqual(await names('q=x.co.ke'), ['Alpha Traders'], 'e-mail');
  assert.deepEqual(await names('q=nakuru'), ['Alpha Traders'], 'location');
  const ph = c.q('select phone from crm_leads where id = ?', l3.id)[0].phone;
  assert.deepEqual(await names('q=' + encodeURIComponent(ph)), ['Gamma Hotel'], 'full phone, any format');
  assert.deepEqual(await names('q=' + encodeURIComponent('0' + ph.slice(4))), ['Gamma Hotel'], 'local format');
  assert.deepEqual(await names('q=' + encodeURIComponent('%')), [], '% is not a wildcard');
  assert.deepEqual(await names('source=website'), ['Alpha Traders', 'Gamma Hotel']);
  assert.deepEqual(await names('class=hot,cold'), ['Alpha Traders', 'Beta Pharmacy']);
  assert.deepEqual(await names('status=contacted'), ['Beta Pharmacy']);
  assert.deepEqual(await names('staff=' + a.id), ['Beta Pharmacy']);
  assert.deepEqual(await names('staff=none'), ['Alpha Traders', 'Gamma Hotel']);
  assert.deepEqual(await names('pool=1'), ['Alpha Traders', 'Gamma Hotel']);
  assert.deepEqual(await names('product=' + c.q(`select id from crm_products where key = 'hotel'`)[0].id), ['Gamma Hotel']);
  assert.deepEqual(await names('follow=today'), ['Alpha Traders']); assert.deepEqual(await names('follow=none'), ['Beta Pharmacy', 'Gamma Hotel']);
  assert.deepEqual(await names('follow=overdue'), []);
  const day = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  assert.equal((await names(`from=${day}&to=${day}`)).length, 3); assert.deepEqual(await names('to=2020-01-01'), []);
  assert.deepEqual(await names('revenue=won'), []); assert.equal((await names('revenue=none')).length, 3);
  const sorted = (await c.ok('GET', '/leads?sort=name&dir=asc')).items.map((x) => x.name); assert.deepEqual(sorted, ['Alpha Traders', 'Beta Pharmacy', 'Gamma Hotel']);
  const pg = await c.ok('GET', '/leads?sort=name&dir=asc&pageSize=2&page=2'); assert.deepEqual([pg.items.map((x) => x.name), pg.total, pg.page, pg.pageSize], [['Gamma Hotel'], 3, 2, 2]);
  assert.equal((await c.api('GET', '/leads?sort=password')).status, 400); assert.equal((await c.api('GET', '/leads?follow=maybe')).status, 400); assert.equal((await c.api('GET', '/leads?from=yesterday')).status, 400);
  assert.equal((await c.ok('GET', '/leads?pageSize=100000')).pageSize, 200, 'page size is capped');
  const csv = await c.api('GET', '/leads/export.csv?status=contacted');
  assert.equal(csv.status, 200); assert.match(csv.res.headers.get('content-type'), /text\/csv/); assert.match(csv.text, /Beta Pharmacy/); assert.doesNotMatch(csv.text, /Alpha Traders/);
  assert.equal(c.q(`select count(*) n from crm_audit where action = 'leads_export'`)[0].n, 1, 'exports are audited');
});

test('lead lifecycle: status (lost needs a reason, won only through Convert), classification, products, notes, contact, dead / reopen', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann');
  const l = (await c.ok('POST', '/leads', { token: a.token, body: lead({ phone: newPhone() }) })).lead;
  let r = await c.api('POST', `/leads/${l.id}/status`, { token: a.token, body: { status: 'qualified' } });
  assert.equal(r.status, 200); assert.equal(r.body.lead.status, 'qualified');
  assert.equal((await c.api('POST', `/leads/${l.id}/status`, { token: a.token, body: { status: 'nonsense' } })).body.code, 'invalid_status');
  assert.equal((await c.api('POST', `/leads/${l.id}/status`, { token: a.token, body: { status: 'won' } })).body.code, 'use_convert');
  assert.equal((await c.api('POST', `/leads/${l.id}/status`, { token: a.token, body: { status: 'lost' } })).body.code, 'lost_reason_required');
  assert.equal((await c.api('POST', `/leads/${l.id}/status`, { token: a.token, body: { status: 'lost', lostReason: 'because' } })).body.code, 'lost_reason_required');
  r = await c.ok('POST', `/leads/${l.id}/status`, { token: a.token, body: { status: 'lost', lostReason: 'price' } });
  assert.deepEqual([r.lead.status, r.lead.lostReason], ['lost', 'price']); assert.ok(r.lead.lostAt);
  r = await c.ok('POST', `/leads/${l.id}/status`, { token: a.token, body: { status: 'contacted' } });
  assert.deepEqual([r.lead.status, r.lead.lostReason, r.lead.lostAt], ['contacted', null, null], 'reopened: the lost reason is cleared');
  assert.equal((await c.ok('POST', `/leads/${l.id}/status`, { token: a.token, body: { status: 'contacted' } })).unchanged, true);
  // classification
  assert.equal((await c.ok('POST', `/leads/${l.id}/classification`, { token: a.token, body: { value: 'hot' } })).lead.classification, 'hot');
  assert.equal((await c.ok('POST', `/leads/${l.id}/classification`, { token: a.token, body: { value: null } })).lead.classification, null);
  assert.equal((await c.api('POST', `/leads/${l.id}/classification`, { token: a.token, body: { value: 'lava' } })).status, 400);
  // products
  const pr = c.q('select id, key from crm_products order by position');
  let p = await c.ok('POST', `/leads/${l.id}/products`, { token: a.token, body: { productIds: [pr[0].id, pr[1].id] } });
  assert.equal(p.lead.productIds.length, 2);
  p = await c.ok('POST', `/leads/${l.id}/products`, { token: a.token, body: { productIds: [pr[1].id] } }); assert.deepEqual(p.lead.productIds, [pr[1].id]);
  assert.equal((await c.api('POST', `/leads/${l.id}/products`, { token: a.token, body: { productIds: ['x'] } })).status, 400);
  // notes
  assert.equal((await c.api('POST', `/leads/${l.id}/note`, { token: a.token, body: { text: '  ' } })).status, 400);
  await c.ok('POST', `/leads/${l.id}/note`, { token: a.token, body: { text: '<b>hello</b> "quoted"' } });
  // contact: validated, sets first contact once, moves New -> Contacted
  const l2 = (await c.ok('POST', '/leads', { token: a.token, body: lead({ phone: newPhone() }) })).lead;
  assert.equal((await c.api('POST', `/leads/${l2.id}/contact`, { token: a.token, body: { method: 'pigeon' } })).status, 400);
  assert.equal((await c.api('POST', `/leads/${l2.id}/contact`, { token: a.token, body: { method: 'call', outcome: 'flew away' } })).status, 400);
  const c1 = (await c.ok('POST', `/leads/${l2.id}/contact`, { token: a.token, body: { method: 'call', outcome: 'no_answer', notes: 'rang out' } })).lead;
  assert.equal(c1.status, 'contacted'); assert.ok(c1.firstContactAt); assert.equal(c1.firstResponseAt, null, 'no answer is not a response');
  await new Promise((r2) => setTimeout(r2, 5));
  const c2 = (await c.ok('POST', `/leads/${l2.id}/contact`, { token: a.token, body: { method: 'whatsapp', outcome: 'replied' } })).lead;
  assert.equal(c2.firstContactAt, c1.firstContactAt, 'the first contact time is never moved'); assert.ok(c2.firstResponseAt >= c2.firstContactAt);
  assert.equal(c.q('select count(*) n from crm_contact_attempts where lead_id = ?', l2.id)[0].n, 2);
  // the timeline shows all of it, newest first, with who did it
  const d = await c.ok('GET', `/leads/${l.id}`);
  const types = d.timeline.map((t) => t.type);
  for (const t of ['create', 'status', 'classification', 'product', 'note']) assert.ok(types.includes(t), t);
  assert.ok(d.timeline.every((t) => t.userName === 'Ann')); assert.ok(d.timeline[0].at >= d.timeline[d.timeline.length - 1].at);
  // every state change has an audit row with previous + new value
  const au = c.q(`select prev, next from crm_audit where entity = 'lead' and entity_id = ? and action = 'lead_status' order by id`, l.id);
  assert.deepEqual([JSON.parse(au[0].prev).status, JSON.parse(au[0].next).status], ['new', 'qualified']);
  // delete: only with the permission; refused for a lead with sales
  assert.equal((await c.api('DELETE', `/leads/${l2.id}`, { token: a.token })).status, 403);
  await c.ok('DELETE', `/leads/${l2.id}`);
  assert.equal((await c.api('GET', `/leads/${l2.id}`)).status, 404); assert.equal((await c.ok('GET', '/leads')).items.some((x) => x.id === l2.id), false);
  assert.equal(c.q('select count(*) n from crm_leads where id = ?', l2.id)[0].n, 1, 'soft delete: the row is kept');
  await c.ok('POST', `/leads/${l.id}/convert`, { token: a.token, body: { productId: pr[0].id, quantity: 1, unitPrice: 100, paymentStatus: 'paid' } });
  assert.equal((await c.api('DELETE', `/leads/${l.id}`)).body.code, 'has_sales');
});

test('follow-ups: create / edit / complete / cancel, buckets, due + overdue notifications (once each)', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann');
  const l = (await c.ok('POST', '/leads', { token: a.token, body: lead({ phone: newPhone() }) })).lead;
  const soon = (await c.ok('POST', `/leads/${l.id}/followups`, { token: a.token, body: { dueAt: Date.now() + 3600000, type: 'call', notes: 'ask about price' } })).followup;
  const tomorrow = (await c.ok('POST', `/leads/${l.id}/followups`, { token: a.token, body: { dueAt: Date.now() + 2 * 86400000, type: 'visit' } })).followup;
  const late = (await c.ok('POST', `/leads/${l.id}/followups`, { token: a.token, body: { dueAt: Date.now() - 2 * 3600000, type: 'whatsapp', remindMinutes: 0 } })).followup;
  assert.equal((await c.api('POST', `/leads/${l.id}/followups`, { token: a.token, body: { dueAt: 'soon' } })).body.code, 'invalid_time');
  assert.equal((await c.api('POST', `/leads/${l.id}/followups`, { token: a.token, body: { dueAt: Date.now() - 5 * 86400000 } })).body.code, 'invalid_time');
  assert.equal((await c.api('POST', `/leads/${l.id}/followups`, { token: a.token, body: { dueAt: Date.now() + 1000, type: 'telepathy' } })).status, 400);
  c.db._db.exec(`delete from crm_meta where k = 'sweep'`);
  const bucket = async (b) => (await c.ok('GET', '/followups?bucket=' + b, { token: a.token })).items.map((x) => x.id);
  assert.deepEqual(await bucket('overdue'), [late.id]);
  assert.ok((await bucket('upcoming')).includes(tomorrow.id));
  assert.equal((await c.api('GET', '/followups?bucket=weird', { token: a.token })).status, 400);
  // notifications: swept at most once a minute; each kind once per follow-up
  const notes = async () => (await c.ok('GET', '/notifications', { token: a.token })).items.filter((n) => /followup/.test(n.kind)).map((n) => n.kind).sort();
  assert.deepEqual(await notes(), ['followup_due', 'followup_overdue'], 'the late one was due and overdue');
  c.db._db.exec(`delete from crm_meta where k = 'sweep'`);
  assert.deepEqual(await notes(), ['followup_due', 'followup_overdue'], 'not repeated');
  // edit moves the due time (reminder re-armed); complete; cancel
  const ed = await c.ok('PATCH', `/followups/${soon.id}`, { token: a.token, body: { dueAt: Date.now() + 5400000, notes: 'moved' } });
  assert.equal(ed.followup.notes, 'moved');
  const done = await c.ok('POST', `/followups/${late.id}/complete`, { token: a.token, body: { notes: 'spoke to him' } });
  assert.equal(done.followup.status, 'done'); assert.ok(done.followup.completedAt);
  assert.equal((await c.ok('POST', `/followups/${late.id}/complete`, { token: a.token, body: {} })).unchanged, true);
  assert.deepEqual(await bucket('overdue'), []); assert.deepEqual(await bucket('completed'), [late.id]);
  await c.ok('PATCH', `/followups/${tomorrow.id}`, { token: a.token, body: { status: 'cancelled' } });
  assert.equal((await c.api('PATCH', `/followups/${tomorrow.id}`, { token: a.token, body: { notes: 'x' } })).body.code, 'followup_closed');
  assert.ok(!(await bucket('upcoming')).includes(tomorrow.id));
  assert.equal(c.q(`select count(*) n from crm_audit where entity = 'followup'`)[0].n >= 6, true);
  // a won lead stops nagging: no overdue notification for it
  const l2 = (await c.ok('POST', '/leads', { token: a.token, body: lead({ phone: newPhone() }) })).lead;
  await c.ok('POST', `/leads/${l2.id}/followups`, { token: a.token, body: { dueAt: Date.now() - 3 * 3600000 } });
  await c.ok('POST', `/leads/${l2.id}/convert`, { token: a.token, body: { productId: shop(c), quantity: 1, unitPrice: 1000, paymentStatus: 'paid' } });
  c.db._db.exec(`delete from crm_meta where k = 'sweep'`);
  const before = (await notes()).length; c.db._db.exec(`delete from crm_meta where k = 'sweep'`);
  assert.equal((await notes()).length, before);
});

test('convert: creates the sale, marks the lead won, records the closing staff and notifies; validation; optional MyDuka client', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann'), m = await c.staff('Mona', 'manager');
  const l = (await c.ok('POST', '/leads', { token: a.token, body: lead({ name: 'Big Shop', businessName: 'Big Shop Ltd', phone: newPhone() }) })).lead;
  const bad = (body) => c.api('POST', `/leads/${l.id}/convert`, { token: a.token, body });
  assert.equal((await bad({ quantity: 1, unitPrice: 1 })).body.code, 'invalid_product');
  assert.equal((await bad({ productId: shop(c), quantity: 0, unitPrice: 1000 })).body.code, 'invalid_quantity');
  assert.equal((await bad({ productId: shop(c), quantity: 1, unitPrice: -5 })).body.code, 'invalid_unitPrice');
  assert.equal((await bad({ productId: shop(c), quantity: 1, unitPrice: 100, discount: 500 })).body.code, 'invalid_discount');
  assert.equal((await bad({ productId: shop(c), quantity: 1, unitPrice: 100, paymentStatus: 'maybe' })).status, 400);
  assert.equal((await bad({ productId: shop(c), quantity: 1, unitPrice: 100, paymentStatus: 'partial' })).status, 400, 'a part payment needs the amount paid');
  assert.equal((await bad({ productId: shop(c), quantity: 1, unitPrice: 100, paymentStatus: 'partial', amountPaid: 100 })).body.code, 'invalid_amount_paid');
  assert.equal(c.q('select count(*) n from crm_sales')[0].n, 0, 'nothing stored by the failed attempts');
  const r = await c.ok('POST', `/leads/${l.id}/convert`, { token: a.token, body: { productId: shop(c), quantity: 3, unitPrice: 12000, discount: 1000, paymentStatus: 'partial', amountPaid: 20000 } });
  assert.equal(r.sale.total, 35000); assert.equal(r.sale.paymentStatus, 'partial'); assert.equal(r.sale.amountPaid, 20000);
  assert.deepEqual([r.sale.closedBy, r.sale.closedByName, r.sale.productLabel], [a.id, 'Ann', 'Shop POS']);
  assert.equal(r.lead.status, 'won'); assert.ok(r.lead.convertedAt);
  assert.equal(r.customer, undefined, 'no MyDuka client unless asked');
  assert.ok((await c.ok('GET', '/notifications', { token: m.token })).items.some((n) => n.kind === 'conversion'), 'managers are told');
  assert.equal(c.q(`select count(*) n from crm_audit where action = 'sale_create'`)[0].n, 1);
  // a second sale to the same customer: still one conversion time
  const first = r.lead.convertedAt;
  const r2 = await c.ok('POST', `/leads/${l.id}/convert`, { token: a.token, body: { productId: shop(c), quantity: 1, unitPrice: 500, paymentStatus: 'paid' } });
  assert.equal(r2.lead.convertedAt, first);
  // payment update
  const up = await c.ok('PATCH', `/sales/${r.sale.id}`, { token: a.token, body: { paymentStatus: 'paid' } });
  assert.deepEqual([up.sale.paymentStatus, up.sale.amountPaid], ['paid', 35000]);
  assert.equal((await c.api('PATCH', `/sales/${r.sale.id}`, { token: a.token, body: { paymentStatus: 'partial', amountPaid: 40000 } })).status, 400);
  // won leads are locked for the sales person, open to a manager
  assert.equal((await c.api('POST', `/leads/${l.id}/status`, { token: a.token, body: { status: 'contacted' } })).body.code, 'lead_won');
  assert.equal((await c.api('POST', `/leads/${l.id}/status`, { token: m.token, body: { status: 'contacted' } })).status, 200);
  // with a MyDuka client: a real license record is created and linked
  const l3 = (await c.ok('POST', '/leads', { token: a.token, body: lead({ name: 'New Client', businessName: 'Fresh Foods', phone: newPhone() }) })).lead;
  const hotel = c.q(`select id from crm_products where key = 'hotel'`)[0].id;
  const cc = await c.ok('POST', `/leads/${l3.id}/convert`, { token: a.token, body: { productId: hotel, quantity: 1, unitPrice: 30000, paymentStatus: 'paid', createClient: true } });
  assert.ok(cc.customer && cc.customer.licenseClientId && cc.customer.type === 'permanent' && cc.customer.product === 'hotel');
  assert.match(cc.customer.link, /^https:\/\/fresh-foods[^/]*\.mydukapos\.store\/hotel\/\?c=/);
  const lic = JSON.parse(c.kv.data.get('license:' + cc.customer.licenseClientId).value);
  assert.deepEqual([lic.product, lic.type, lic.label], ['hotel', 'permanent', 'Fresh Foods']);
  assert.equal(c.q('select customer_id from crm_leads where id = ?', l3.id)[0].customer_id, cc.customer.id);
  assert.equal(c.q('select customer_id from crm_sales where id = ?', cc.sale.id)[0].customer_id, cc.customer.id);
  const dd = await c.ok('GET', `/leads/${l3.id}`, { token: a.token });
  assert.equal(dd.sales.length, 1);
  // a failing client creation is reported, and the sale still stands
  const c2 = await makeCrm();
  const x = (await c2.ok('POST', '/leads', { body: lead({ phone: newPhone() }) })).lead;
  const realPut = c2.env.mydukapos_kv.put.bind(c2.env.mydukapos_kv); c2.env.mydukapos_kv.put = async (k, ...r) => { if (String(k).startsWith('license:')) throw new Error('kv down'); return realPut(k, ...r); };
  const fail = await c2.api('POST', `/leads/${x.id}/convert`, { body: { productId: shop(c2), quantity: 1, unitPrice: 10, paymentStatus: 'paid', createClient: true } });
  assert.equal(fail.status, 201); assert.match(fail.body.clientError, /could not be created/); assert.equal(c2.q('select count(*) n from crm_sales')[0].n, 1);
});
