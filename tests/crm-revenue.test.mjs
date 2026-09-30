import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCrm, lead, newPhone } from './crm-harness.mjs';
import { waHook, msg, adRef, WA_SECRET } from './crm-rev-helpers.mjs';

const pid = (c, key) => c.q('select id from crm_products where key = ?', key)[0].id;
const today = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);

async function scenario() {
  const c = await makeCrm({ WHATSAPP_APP_SECRET: WA_SECRET });
  const ann = await c.staff('Ann'), ben = await c.staff('Ben');
  assert.equal((await waHook(c.env, [msg('w1', '254711000001', 'hi', null, adRef('AD1')), msg('w2', '254711000002', 'hi', null, adRef('AD1')), msg('w3', '254711000003', 'hi', null, adRef('AD2'))])).status, 200);
  const camp = (await c.ok('POST', '/campaigns', { body: { name: 'Sept Shop', platform: 'meta' } })).campaign;
  const set = (await c.ok('POST', `/campaigns/${camp.id}/adsets`, { body: { name: 'Nairobi' } })).adset;
  const ads = c.q('select id, external_id from crm_ads order by external_id');
  for (const a of ads) await c.ok('PATCH', `/ads/${a.id}`, { body: { adsetId: set.id } });
  const byAd = (ext) => c.q('select l.id from crm_leads l join crm_ads a on a.id = l.first_ad_id where a.external_id = ? order by l.created_at, l.id', ext).map((x) => x.id);
  const [l1, l2] = byAd('AD1'), [l3] = byAd('AD2');
  const manual = (await c.ok('POST', '/leads', { token: ann.token, body: lead({ phone: newPhone(), source: 'referral' }) })).lead;
  await c.ok('POST', `/leads/${l1}/claim`, { token: ann.token });
  await c.ok('POST', `/leads/${l3}/claim`, { token: ben.token });
  const conv = (id, token, body) => c.ok('POST', `/leads/${id}/convert`, { token, body: { quantity: 1, paymentStatus: 'paid', ...body } });
  const s1 = await conv(l1, ann.token, { productId: pid(c, 'shop'), unitPrice: 10000 });
  const s2 = await conv(l3, ben.token, { productId: pid(c, 'hotel'), unitPrice: 30000, paymentStatus: 'partial', amountPaid: 10000 });
  const s3 = await conv(manual.id, ann.token, { productId: pid(c, 'pharmacy'), unitPrice: 5000, discount: 500 });
  return { c, ann, ben, camp, set, ads, l1, l2, l3, manual, s1, s2, s3 };
}

test('revenue by lead / staff / product / source / campaign / ad-set / ad; CPL, CPA, ROAS only when spend > 0', async () => {
  const { c, ann, ben, camp, set, ads, l1, l3, manual } = await scenario();
  // lead-level
  assert.equal((await c.ok('GET', `/leads/${l1}`)).sales[0].total, 10000);
  // staff
  const st = (await c.ok('GET', '/reports/staff?range=month')).rows;
  const row = (n) => st.find((r) => r.name === n);
  assert.deepEqual([row('Ann').dealsClosed, row('Ann').revenue, row('Ann').collected], [2, 14500, 14500]);
  assert.deepEqual([row('Ben').dealsClosed, row('Ben').revenue, row('Ben').collected], [1, 30000, 10000]);
  // product
  const pr = (await c.ok('GET', '/reports/products?range=month')).rows;
  assert.deepEqual(pr.filter((r) => r.deals).map((r) => [r.key, r.revenue, r.discounts]).sort(), [['hotel', 30000, 0], ['pharmacy', 4500, 500], ['shop', 10000, 0]]);
  // source
  const so = (await c.ok('GET', '/reports/sources?range=month')).rows;
  assert.equal(so.find((r) => r.source === 'meta_ads').revenue, 40000); assert.equal(so.find((r) => r.source === 'referral').revenue, 4500);
  // campaign / adset / ad, no spend yet -> null metrics, never 0 or Infinity
  let cr = (await c.ok('GET', '/reports/campaigns?range=month')).rows;
  const camRow = cr.find((r) => r.level === 'campaign');
  assert.deepEqual([camRow.leads, camRow.wonLeads, camRow.revenue, camRow.spend, camRow.cpl, camRow.cpa, camRow.roas], [3, 2, 40000, 0, null, null, null]);
  assert.equal(cr.find((r) => r.level === 'ad' && r.id === ads[0].id).revenue, 10000);
  assert.equal(cr.find((r) => r.level === 'ad' && r.id === ads[1].id).revenue, 30000);
  assert.equal(cr.find((r) => r.level === 'adset').revenue, 40000);
  // spend: validation, then real numbers
  const bad = (b) => c.api('POST', `/campaigns/${camp.id}/spend`, { body: b });
  assert.equal((await bad({ date: 'today', amount: 10 })).status, 400); assert.equal((await bad({ date: today(), amount: -5 })).status, 400); assert.equal((await bad({ date: '2999-01-01', amount: 5 })).status, 400);
  assert.equal((await bad({ date: today(), amount: 'lots' })).status, 400);
  assert.equal((await c.api('POST', `/campaigns/${camp.id}/spend`, { token: ann.token, body: { date: today(), amount: 5 } })).status, 403);
  assert.equal((await bad({ date: today(), amount: 0 })).status < 300, true);
  cr = (await c.ok('GET', '/reports/campaigns?range=month')).rows; assert.equal(cr.find((r) => r.level === 'campaign').cpl, null, 'spend 0 -> still no CPL');
  await c.ok('POST', `/campaigns/${camp.id}/spend`, { body: { date: today(), amount: 8000 } });
  const upd = await c.ok('POST', `/campaigns/${camp.id}/spend`, { body: { date: today(), amount: 4000 } });
  assert.equal(upd.spend.replaced, true, 'one row per day: entering again replaces');
  assert.equal(c.q('select count(*) n from crm_spend')[0].n, 1);
  cr = (await c.ok('GET', '/reports/campaigns?range=month')).rows;
  const cm = cr.find((r) => r.level === 'campaign');
  assert.deepEqual([cm.spend, cm.cpl, cm.cpa, cm.roas], [4000, 1333.33, 2000, 10]);
  assert.equal(cr.find((r) => r.level === 'adset').cpl, null, 'no spend entered at ad-set level -> null');
  // same day at another level would double count
  assert.equal((await c.api('POST', `/campaigns/${camp.id}/spend`, { body: { date: today(), amount: 100, adsetId: set.id } })).body.code, 'spend_level_conflict');
  // ad-level spend on another day is fine, and gives the ad its own CPL
  const yday = new Date(Date.now() + 3 * 3600000 - 86400000).toISOString().slice(0, 10);
  await c.ok('POST', `/campaigns/${camp.id}/spend`, { body: { date: yday, amount: 600, adId: ads[0].id } });
  const range = `range=custom&from=${yday}&to=${yday}`;
  const ad0 = (await c.ok('GET', `/reports/campaigns?${range}`)).rows.find((r) => r.id === ads[0].id);
  assert.equal(ad0.spend, 600);
  // dashboard agrees with the reports
  const d = await c.ok('GET', '/dashboard?range=month');
  assert.deepEqual([d.revenue.deals, d.revenue.total, d.revenue.collected, d.revenue.outstanding], [3, 44500, 24500, 20000]);
  assert.equal(d.marketing.spend, 4600); assert.equal(d.leads.created, 4); assert.equal(d.pool, 1);
  // sales list is filterable and consistent with the totals
  const sl = await c.ok('GET', '/sales?range=month'); assert.equal(sl.items.length, 3); assert.equal(sl.totals.revenue, 44500);
  assert.equal((await c.ok('GET', `/sales?staff=${ben.id}`)).totals.revenue, 30000);
  assert.equal((await c.ok('GET', `/sales?campaign=${camp.id}`)).totals.revenue, 40000);
  assert.equal((await c.ok('GET', `/sales?product=${pid(c, 'pharmacy')}`)).totals.revenue, 4500);
  // an empty range shows zeros (or null ratios), not invented numbers
  const e = await c.ok('GET', '/reports/campaigns?range=custom&from=2020-01-01&to=2020-01-31');
  assert.ok(e.rows.every((r) => r.revenue === 0 && r.cpl === null && r.roas === null));
  assert.equal((await c.ok('GET', '/dashboard?range=custom&from=2020-01-01&to=2020-01-31')).revenue.total, 0);
  assert.equal((await c.api('GET', '/dashboard?range=custom&from=2020-02-01&to=2020-01-01')).status, 400);
  assert.equal((await c.api('GET', '/dashboard?range=fortnight')).status, 400);
});

test('date ranges: today / yesterday / week / 7d / month / lastmonth / custom in Africa/Nairobi', async () => {
  const c = await makeCrm();
  const rng = async (q) => (await c.ok('GET', '/reports/funnel?' + q));
  const t = await rng('range=today'), y = await rng('range=yesterday');
  assert.equal(t.fromDay, today()); assert.equal(t.to - t.from, 86400000); assert.equal(y.to, t.from);
  assert.equal(new Date(t.from).getUTCHours(), 21, 'Nairobi midnight is 21:00 UTC the day before');
  const w = await rng('range=week'); assert.equal(new Date(w.from + 3 * 3600000).getUTCDay(), 1, 'the week starts on Monday');
  const d7 = await rng('range=7d'); assert.equal(d7.to - d7.from, 7 * 86400000);
  const mo = await rng('range=month'); assert.equal(mo.fromDay.slice(8), '01');
  const lm = await rng('range=lastmonth'); assert.equal(lm.to, mo.from); assert.equal(lm.fromDay.slice(8), '01');
  const cu = await rng('range=custom&from=2026-03-05&to=2026-03-06'); assert.equal(cu.to - cu.from, 2 * 86400000); assert.equal(cu.fromDay, '2026-03-05');
  assert.equal((await c.api('GET', '/reports/funnel?range=custom&from=05-03-2026&to=2026-03-06')).status, 400);
  // a lead created at 23:30 Nairobi time belongs to that Nairobi day
  const l = (await c.ok('POST', '/leads', { body: lead({ phone: newPhone() }) })).lead;
  const late = Date.parse('2026-03-05T20:30:00Z');   // 23:30 in Nairobi
  c.db._db.exec(`update crm_leads set created_at = ${late} where id = '${l.id}'`);
  assert.equal((await rng('range=custom&from=2026-03-05&to=2026-03-05')).totals.created, 1);
  assert.equal((await rng('range=custom&from=2026-03-06&to=2026-03-06')).totals.created, 0);
});

test('meetings: schedule / list / reschedule / cancel / complete / no-show, reminders and rules', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann'), b = await c.staff('Ben');
  const l = (await c.ok('POST', '/leads', { token: a.token, body: lead({ phone: newPhone() }) })).lead;
  const at = Date.now() + 5 * 3600000;
  const bad = (body) => c.api('POST', `/leads/${l.id}/meetings`, { token: a.token, body });
  assert.equal((await bad({ startsAt: 'later' })).status, 400); assert.equal((await bad({ startsAt: Date.now() - 3 * 86400000 })).body.code, 'invalid_time');
  assert.equal((await bad({ startsAt: at, type: 'seance' })).status, 400); assert.equal((await bad({ startsAt: at, durationMin: 1 })).status, 400); assert.equal((await bad({ startsAt: at, link: 'javascript:alert(1)' })).status, 400);
  const m = (await c.ok('POST', `/leads/${l.id}/meetings`, { token: a.token, body: { startsAt: at, type: 'video', durationMin: 45, link: 'https://meet.example.com/abc', notes: 'demo' } })).meeting;
  assert.deepEqual([m.status, m.durationMin, m.type, m.userId], ['scheduled', 45, 'video', a.id]);
  assert.equal(c.q('select status_key from crm_leads where id = ?', l.id)[0].status_key, 'meeting', 'a new lead moves to Meeting scheduled');
  assert.equal((await c.ok('GET', '/meetings', { token: a.token })).items.length, 1);
  assert.equal((await c.ok('GET', '/meetings', { token: b.token })).items.length, 0, 'Ben cannot see Ann\'s');
  assert.equal((await c.api('PATCH', `/meetings/${m.id}`, { token: b.token, body: { notes: 'x' } })).status, 404);
  assert.equal((await c.api('POST', `/meetings/${m.id}/status`, { token: b.token, body: { status: 'cancelled' } })).status, 404);
  assert.equal((await c.api('POST', `/leads/${l.id}/meetings`, { token: b.token, body: { startsAt: at } })).status, 404);
  // reschedule (PATCH or status) counts
  const p = (await c.ok('PATCH', `/meetings/${m.id}`, { token: a.token, body: { startsAt: at + 3600000 } })).meeting;
  assert.deepEqual([p.status, p.rescheduleCount], ['rescheduled', 1]);
  assert.equal((await c.api('POST', `/meetings/${m.id}/status`, { token: a.token, body: { status: 'rescheduled' } })).status, 400);
  const r2 = (await c.ok('POST', `/meetings/${m.id}/status`, { token: a.token, body: { status: 'rescheduled', startsAt: at + 7200000 } })).meeting; assert.equal(r2.rescheduleCount, 2);
  assert.equal((await c.ok('POST', `/meetings/${m.id}/status`, { token: a.token, body: { status: 'confirmed' } })).meeting.status, 'confirmed');
  assert.equal((await c.api('POST', `/meetings/${m.id}/status`, { token: a.token, body: { status: 'no_show' } })).body.code, 'meeting_in_future');
  assert.equal((await c.api('POST', `/meetings/${m.id}/status`, { token: a.token, body: { status: 'exploded' } })).status, 400);
  // reminder within the hour before start (swept, once)
  const soon = (await c.ok('POST', `/leads/${l.id}/meetings`, { token: a.token, body: { startsAt: Date.now() + 20 * 60000 } })).meeting;
  c.db._db.exec(`delete from crm_meta where k = 'sweep'`);
  const n1 = (await c.ok('GET', '/notifications', { token: a.token })).items.filter((n) => n.kind === 'meeting_reminder');
  assert.equal(n1.length, 1); c.db._db.exec(`delete from crm_meta where k = 'sweep'`);
  assert.equal((await c.ok('GET', '/notifications', { token: a.token })).items.filter((n) => n.kind === 'meeting_reminder').length, 1, 'not repeated');
  // complete / cancel / no-show are final
  assert.equal((await c.ok('POST', `/meetings/${soon.id}/status`, { token: a.token, body: { status: 'completed' } })).meeting.status, 'completed');
  assert.equal((await c.api('POST', `/meetings/${soon.id}/status`, { token: a.token, body: { status: 'cancelled' } })).body.code, 'meeting_closed');
  assert.equal((await c.api('PATCH', `/meetings/${soon.id}`, { token: a.token, body: { startsAt: at } })).body.code, 'meeting_closed');
  assert.equal((await c.ok('PATCH', `/meetings/${soon.id}`, { token: a.token, body: { notes: 'went well' } })).meeting.notes, 'went well');
  await c.ok('POST', `/meetings/${m.id}/status`, { token: a.token, body: { status: 'cancelled' } });
  // a past meeting can be marked no-show
  const past = (await c.ok('POST', `/leads/${l.id}/meetings`, { token: a.token, body: { startsAt: Date.now() - 2 * 3600000 } })).meeting;
  assert.equal((await c.ok('POST', `/meetings/${past.id}/status`, { token: a.token, body: { status: 'no_show' } })).meeting.status, 'no_show');
  // report + dashboard counts
  const rep = (await c.ok('GET', '/reports/staff?range=month')).rows.find((r) => r.name === 'Ann');
  assert.deepEqual([rep.meetingsCompleted, rep.meetingsNoShow], [1, 1]);
  const d = await c.ok('GET', '/dashboard?range=month', { token: a.token });
  assert.equal(d.meetings.completed, 1); assert.equal(d.meetings.noShow, 1);
  // audit trail
  const acts = c.q(`select action from crm_audit where entity = 'meeting' order by id`).map((x) => x.action);
  for (const k of ['meeting_create', 'meeting_update', 'meeting_rescheduled', 'meeting_confirmed', 'meeting_completed', 'meeting_cancelled', 'meeting_no_show']) assert.ok(acts.includes(k), k);
  // date filters
  const fut = await c.ok('GET', `/meetings?from=${today()}&to=${today()}`, { token: a.token }); assert.ok(Array.isArray(fut.items));
  assert.equal((await c.api('GET', '/meetings?from=garbage', { token: a.token })).status, 400);
});
