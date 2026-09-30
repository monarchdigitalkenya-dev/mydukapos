import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCrm, lead, newPhone } from './crm-harness.mjs';
import { waHook, payload, WA_SECRET } from './crm-rev-helpers.mjs';
import { extractInboundMessages } from '../functions/api/_whatsapp.js';
import { ensureCrmSchema } from '../functions/api/_crm/schema.js';
import { makeD1 } from './d1-fake.mjs';

const T = Math.floor(Date.now() / 1000);
const media = (id, from, kind, body) => ({ id, from, timestamp: String(T), type: kind, [kind]: body });
const bytes = (n) => new Uint8Array(n).fill(7);
const realFetch = globalThis.fetch;
const withGraph = (handler) => { globalThis.fetch = async (url, opts) => handler(String(url), opts || {}) || new Response('?', { status: 404 }); return () => { globalThis.fetch = realFetch; }; };

test('C1: attachments keep their type, caption and media id; the inbox shows typed labels; a retried webhook is one message', async () => {
  const c = await makeCrm({ WHATSAPP_APP_SECRET: WA_SECRET });
  const msgs = [
    media('wamid.i1', '254700111222', 'image', { id: 'MEDIA-IMG', mime_type: 'image/jpeg', caption: 'the shop front' }),
    media('wamid.v1', '254700111222', 'audio', { id: 'MEDIA-VN', mime_type: 'audio/ogg; codecs=opus', voice: true }),
    media('wamid.d1', '254700111222', 'document', { id: 'MEDIA-DOC', mime_type: 'application/pdf', filename: 'Quote 44.pdf', caption: 'please sign' }),
    media('wamid.s1', '254700111222', 'video', { id: 'MEDIA-VID', mime_type: 'video/mp4' }),
  ];
  assert.equal((await waHook(c.env, msgs, { '254700111222': 'Media Person' })).status, 200);
  assert.equal((await waHook(c.env, msgs, { '254700111222': 'Media Person' })).status, 200, 'Meta retries');
  const cv = (await c.ok('GET', '/inbox/conversations')).items[0];
  const items = (await c.ok('GET', `/inbox/conversations/${cv.id}/messages`)).items;
  assert.equal(items.length, 4, 'not duplicated');
  const by = Object.fromEntries(items.map((m) => [m.type, m]));
  assert.equal(by.image.media.label, '📷 Image'); assert.equal(by.image.caption, 'the shop front'); assert.equal(by.image.media.mime, 'image/jpeg');
  assert.equal(by.voice.media.label, '🎤 Voice note');
  assert.equal(by.document.media.label, '📄 Quote 44.pdf'); assert.equal(by.document.caption, 'please sign');
  assert.equal(by.video.media.label, '🎥 Video');
  assert.equal(c.q(`select media_id from crm_messages where ext_id = 'wamid.i1'`)[0].media_id, 'MEDIA-IMG');
  assert.ok(!JSON.stringify(items).includes('MEDIA-IMG'), 'the media id is not handed to the browser');
  assert.match(cv.lastMessageText, /🎥 Video|📄|🎤|📷/, 'the list shows a label, not "[image]"');
  assert.ok(!/^\[(image|audio|video|document)\]$/.test(cv.lastMessageText));
});

test('C2: GET /inbox/media/:id needs the token, the right to open the chat, streams within the size cap, and never renders unsafe types', async () => {
  const c = await makeCrm({ WHATSAPP_APP_SECRET: WA_SECRET });
  await waHook(c.env, [media('wamid.i2', '254700333444', 'image', { id: 'M-OK', mime_type: 'image/png' }), media('wamid.h2', '254700333444', 'document', { id: 'M-HTML', mime_type: 'text/html', filename: 'x.html' }), media('wamid.b2', '254700333444', 'video', { id: 'M-BIG', mime_type: 'video/mp4' }), media('wamid.u2', '254700333444', 'document', { id: 'M-UNK', mime_type: 'application/pdf' })], {});
  const cv = (await c.ok('GET', '/inbox/conversations')).items[0];
  const ids = Object.fromEntries((await c.ok('GET', `/inbox/conversations/${cv.id}/messages`)).items.map((m) => [m.type + (m.media && m.media.name || ''), m.id]));
  // no token configured: a clear 409, nothing is fetched
  let r = await c.api('GET', `/inbox/media/${ids.image}`);
  assert.equal(r.status, 409); assert.equal(r.body.code, 'whatsapp_not_configured');
  c.env.WHATSAPP_TOKEN = 'wa-token'; c.env.WHATSAPP_PHONE_NUMBER_ID = '123';
  const calls = [];
  const restore = withGraph((url, o) => {
    calls.push([url, o.headers && o.headers.Authorization]);
    if (/\/M-OK$/.test(url)) return Response.json({ url: 'https://lookaside.example/ok', mime_type: 'image/png', file_size: 100 });
    if (/\/M-HTML$/.test(url)) return Response.json({ url: 'https://lookaside.example/html', mime_type: 'text/html', file_size: 20 });
    if (/\/M-BIG$/.test(url)) return Response.json({ url: 'https://lookaside.example/big', mime_type: 'video/mp4', file_size: 50 * 1024 * 1024 });
    if (/\/M-UNK$/.test(url)) return Response.json({ url: 'https://lookaside.example/unk', mime_type: 'application/pdf' });   // no size given
    if (url.endsWith('/ok')) return new Response(bytes(100), { headers: { 'content-type': 'image/png', 'content-length': '100' } });
    if (url.endsWith('/html')) return new Response('<script>alert(1)</script>', { headers: { 'content-type': 'text/html' } });
    if (url.endsWith('/unk')) return new Response(new ReadableStream({ start(ctl) { for (let i = 0; i < 20; i++) ctl.enqueue(bytes(1024 * 1024)); ctl.close(); } }), { headers: { 'content-type': 'application/pdf' } });   // 20 MB, no length
    return null;
  });
  try {
    r = await c.api('GET', `/inbox/media/${ids.image}`);
    assert.equal(r.status, 200); assert.equal(r.res.headers.get('content-type'), 'image/png'); assert.match(r.res.headers.get('content-disposition'), /^inline/);
    assert.equal(r.text.length, 100, 'the file arrived whole');
    assert.ok(calls.every(([, a]) => a === 'Bearer wa-token'), 'both Graph calls carry the token');
    r = await c.api('GET', `/inbox/media/${ids['documentx.html']}`);
    assert.equal(r.status, 200); assert.equal(r.res.headers.get('content-type'), 'application/octet-stream'); assert.match(r.res.headers.get('content-disposition'), /^attachment/);
    assert.equal(r.res.headers.get('x-content-type-options'), 'nosniff');
    r = await c.api('GET', `/inbox/media/${ids.video}`);
    assert.equal(r.status, 413, 'declared size over the cap');
    // no declared size and no content-length: the cap is enforced while streaming
    const rr = await c.router.handle({ request: new Request('https://mydukapos.store/api/crm/inbox/media/' + ids.document, { headers: { Authorization: 'Bearer owner-tok' } }), env: c.env });
    await assert.rejects(async () => { const reader = rr.body.getReader(); let n = 0; for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.byteLength; } return n; }, /too large/);
  } finally { restore(); }
  // rights: a salesperson who does not own the lead / chat cannot open its media; nor can someone without inbox.view
  const s = await c.staff('Sam');
  r = await c.api('GET', `/inbox/media/${ids.image}`, { token: s.token });
  assert.equal(r.status, 404, 'not linked to a lead this person may see');
  r = await c.api('GET', `/inbox/media/nope`);
  assert.equal(r.status, 404);
});

test('C3: schema v2 database gains the media columns in place', async () => {
  const d1 = makeD1(); await ensureCrmSchema(d1);
  d1._db.exec('alter table crm_messages drop column media_id'); d1._db.exec('alter table crm_messages drop column media_mime'); d1._db.exec('alter table crm_messages drop column media_name');
  d1._db.exec(`update crm_meta set v = '2' where k = 'schema'`);
  await ensureCrmSchema({ ...d1 });
  const cols = d1.query('pragma table_info(crm_messages)').map((r) => r.name);
  for (const col of ['media_id', 'media_mime', 'media_name']) assert.ok(cols.includes(col), col);
});

test('C4: Automation rule: a new lead nobody has taken for N minutes notifies the managers once; assigned / off / too-new leads do not', async () => {
  const c = await makeCrm();
  const mgr = await c.staff('Mona', 'manager');
  const sales = await c.staff('Sam');
  const mk = async (name, ageMin) => { const l = (await c.ok('POST', '/leads', { body: lead({ name, phone: newPhone() }) })).lead; c.db._db.exec(`update crm_leads set created_at = ${Date.now() - ageMin * 60000} where id = '${l.id}'`); return l; };
  const old = await mk('Old Lead', 90), fresh = await mk('Fresh Lead', 5), taken = await mk('Taken Lead', 90);
  await c.ok('POST', `/leads/${taken.id}/claim`, { token: sales.token });
  const rerun = () => c.db._db.exec(`update crm_meta set v = '0' where k = 'auto'`);
  const count = (uid) => c.q(`select count(*) n from crm_notifications where kind = 'lead_unassigned_late' and user_id = ?`, uid)[0].n;
  rerun(); await c.ok('GET', '/me');
  assert.equal(count(mgr.id), 1, 'only the old, untaken lead');
  assert.equal(c.q(`select lead_id from crm_events where name = 'automation.unassigned_lead_escalated'`).map((r) => r.lead_id).join(), old.id);
  for (let i = 0; i < 3; i++) { rerun(); await c.ok('GET', '/me'); }
  assert.equal(count(mgr.id), 1, 'never notified twice');
  // the fresh lead becomes late
  c.db._db.exec(`update crm_leads set created_at = ${Date.now() - 45 * 60000} where id = '${fresh.id}'`);
  rerun(); await c.ok('GET', '/me');
  assert.equal(count(mgr.id), 2);
  // rule off
  await c.ok('PUT', '/settings', { body: { settings: { autoUnassignedLeadMinutes: 0 } } });
  const late = await mk('Late Lead', 500); rerun(); await c.ok('GET', '/me');
  assert.equal(count(mgr.id), 2, 'off means off'); void late;
  // validation
  assert.equal((await c.api('PUT', '/settings', { body: { settings: { autoUnassignedLeadMinutes: -1 } } })).status, 400);
});

test('C5: the follow-up-overdue rule uses its configured minutes (0 = off)', async () => {
  const c = await makeCrm();
  const sales = await c.staff('Sam');
  const l = (await c.ok('POST', '/leads', { token: sales.token, body: lead({ name: 'Mine', phone: newPhone() }) })).lead;
  await c.ok('POST', `/leads/${l.id}/claim`, { token: sales.token }).catch(() => null);
  const f = await c.ok('POST', `/leads/${l.id}/followups`, { token: sales.token, body: { dueAt: Date.now() + 3600000, type: 'call' } });
  const fid = (f.followup || f).id;
  const sweep = async () => { c.db._db.exec(`update crm_meta set v = '0' where k = 'sweep'`); await c.ok('GET', '/me', { token: sales.token }); };
  const late = () => c.q(`select count(*) n from crm_notifications where kind = 'followup_overdue' and user_id = ?`, sales.id)[0].n;
  c.db._db.exec(`update crm_followups set due_at = ${Date.now() - 20 * 60000}, remind_minutes = 0 where id = '${fid}'`);
  await c.ok('PUT', '/settings', { body: { settings: { autoFollowupOverdueMinutes: 60 } } });
  await sweep(); assert.equal(late(), 0, '20 min late is inside the 60 minute grace');
  await c.ok('PUT', '/settings', { body: { settings: { autoFollowupOverdueMinutes: 0 } } });
  await sweep(); assert.equal(late(), 0, 'off');
  await c.ok('PUT', '/settings', { body: { settings: { autoFollowupOverdueMinutes: 10 } } });
  await sweep(); assert.equal(late(), 1, '20 min late is past a 10 minute grace');
});

test('C6: GET /automation lists the rules and the recent events (newest first) for settings people only', async () => {
  const c = await makeCrm();
  await c.ok('POST', '/leads', { body: lead({ name: 'A', phone: newPhone() }) });
  await c.ok('POST', '/leads', { body: lead({ name: 'B', phone: newPhone() }) });
  const r = await c.ok('GET', '/automation');
  assert.deepEqual(r.rules.map((x) => x.key), ['autoUnassignedLeadMinutes', 'autoFollowupOverdueMinutes']);
  assert.equal(r.rules[0].value, 30);
  assert.ok(r.events.length >= 2 && r.events[0].id > r.events[r.events.length - 1].id, 'newest first');
  assert.equal(r.canEdit, true);
  const s = await c.staff('Sam');
  assert.equal((await c.api('GET', '/automation', { token: s.token })).status, 403);
});

test('C7: leads sort by product name on the server (both directions, empty last)', async () => {
  const c = await makeCrm();
  const prods = c.q('select id, label from crm_products order by label');
  assert.ok(prods.length >= 2);
  const a = (await c.ok('POST', '/leads', { body: lead({ name: 'L-a', phone: newPhone(), productIds: [prods[prods.length - 1].id] }) })).lead;
  const b = (await c.ok('POST', '/leads', { body: lead({ name: 'L-b', phone: newPhone(), productIds: [prods[0].id] }) })).lead;
  const n = (await c.ok('POST', '/leads', { body: lead({ name: 'L-none', phone: newPhone() }) })).lead;
  const asc = (await c.ok('GET', '/leads?sort=product&dir=asc')).items.map((x) => x.id);
  assert.deepEqual(asc, [b.id, a.id, n.id]);
  const desc = (await c.ok('GET', '/leads?sort=product&dir=desc')).items.map((x) => x.id);
  assert.deepEqual(desc, [a.id, b.id, n.id]);
});
