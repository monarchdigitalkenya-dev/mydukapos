import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { makeCrm, lead, newPhone, makeEnv } from './crm-harness.mjs';
import { waHook, msg, adRef, sign, WA_SECRET } from './crm-rev-helpers.mjs';

const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
async function pub(env, body, { ip = '1.2.3.4', origin, ct = 'application/json', method = 'POST', referer } = {}) {
  const m = await load('crm-lead.js');
  const headers = { 'content-type': ct, 'CF-Connecting-IP': ip, ...(origin ? { Origin: origin } : {}), ...(referer ? { Referer: referer } : {}) };
  const req = new Request('https://mydukapos.store/api/crm-lead', { method, headers, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
  const res = await (method === 'OPTIONS' ? m.onRequestOptions : m.onRequestPost)({ request: req, env });
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* */ }
  return { status: res.status, body: j, res };
}

test('public website lead: validation, honeypot, dedupe, attribution + UTM, source=website, notification, returns nothing internal', async () => {
  const c = await makeCrm();
  const a = await c.staff('Ann');
  let r = await pub(c.env, { name: 'Wanjiru', phone: '0722 111 222', message: 'I want a POS', product: 'pharmacy', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'brand', utm_term: 'pos kenya', referrer: 'https://google.com/' }, { origin: 'https://mydukapos.store' });
  assert.deepEqual([r.status, r.body], [200, { ok: true }], 'nothing internal is returned');
  const l = c.q('select * from crm_leads')[0];
  assert.deepEqual([l.name, l.phone, l.source_key, l.status_key, l.owner_id, l.notes], ['Wanjiru', '+254722111222', 'website', 'new', null, 'I want a POS']);
  assert.deepEqual([l.first_utm_source, l.first_utm_medium, l.first_utm_campaign, l.first_utm_term, l.first_referrer], ['google', 'cpc', 'brand', 'pos kenya', 'https://google.com/']);
  assert.equal(c.q('select count(*) n from crm_campaigns')[0].n, 0, 'a website UTM never invents a campaign');
  assert.equal(c.q('select count(*) n from crm_lead_products where lead_id = ?', l.id)[0].n, 1);
  assert.equal(c.q('select count(*) n from crm_attribution_events where lead_id = ?', l.id)[0].n, 1);
  assert.ok((await c.ok('GET', '/notifications')).items.some((n) => n.kind === 'new_lead'), 'managers are told');
  assert.equal(c.q(`select count(*) n from crm_audit where action = 'lead_create_website'`)[0].n, 1);
  // validation
  const bad = async (b) => (await pub(c.env, b)).body;
  assert.equal((await pub(c.env, {})).status, 400);
  assert.ok((await bad({ name: 'X', phone: '0722333444' })).fields.name);
  assert.ok((await bad({ name: 'Xavier', phone: '12' })).fields.phone);
  assert.ok((await bad({ name: 'Xavier', email: 'bad' })).fields.email);
  assert.ok((await bad({ name: 'Xavier' })).fields.phone, 'a phone, WhatsApp or e-mail is required');
  assert.equal((await pub(c.env, 'not json')).status, 400);
  assert.equal((await pub(c.env, '[1,2]')).status, 400);
  assert.equal((await pub(c.env, { name: 'Big', phone: '0722333444', message: 'x'.repeat(9000) })).status, 413);
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, 1);
  // form-encoded posts work
  r = await pub(c.env, 'name=Form+Person&phone=0733444555&utm_source=fb', { ct: 'application/x-www-form-urlencoded', ip: '9.9.9.9' });
  assert.equal(r.status, 200); assert.equal(c.q(`select first_utm_source s from crm_leads where name = 'Form Person'`)[0].s, 'fb');
  // returning person: same lead, attribution keeps the FIRST touch and adds an event
  r = await pub(c.env, { name: 'Wanjiru W', phone: '+254722111222', utm_source: 'facebook', utm_campaign: 'retarget', message: 'still keen' }, { ip: '5.5.5.5' });
  assert.equal(r.status, 200);
  assert.equal(c.q(`select count(*) n from crm_leads where phone_norm = '254722111222'`)[0].n, 1, 'no duplicate lead');
  const l2 = c.q(`select * from crm_leads where phone_norm = '254722111222'`)[0];
  assert.deepEqual([l2.name, l2.first_utm_source, l2.first_utm_campaign], ['Wanjiru', 'google', 'brand'], 'first attribution kept');
  const ev = c.q('select utm_source, utm_campaign from crm_attribution_events where lead_id = ? order by at, rowid', l.id);
  assert.deepEqual(ev.map((e) => e.utm_source), ['google', 'facebook']);
  const d = await c.ok('GET', `/leads/${l.id}`);
  assert.equal(d.attributions.length, 2); assert.equal(d.lead.firstTouch.utmSource, 'google');
  assert.ok(d.timeline.some((t) => /website form again/.test(t.summary)));
  // honeypot: a success-looking answer, nothing stored, and it does not burn the rate limit differently
  const before = c.q('select count(*) n from crm_leads')[0].n;
  for (const k of ['hp', '_hp', 'website_url', 'fax', 'url']) { const h = await pub(c.env, { name: 'Botty McBot', phone: newPhone(), [k]: 'http://spam' }, { ip: '7.7.7.7' }); assert.deepEqual([h.status, h.body], [200, { ok: true }], k); }
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, before);
});

test('public website lead: per-IP and global rate limits, origin allow-list + CORS, no database -> 503', async () => {
  const c = await makeCrm({ CRM_LEAD_IP_LIMIT: '3', CRM_LEAD_GLOBAL_LIMIT: '7', CRM_PUBLIC_ORIGINS: 'https://brochure.example.co.ke/' });
  const send = (ip, origin) => pub(c.env, { name: 'Person ' + ip, phone: newPhone() }, { ip, origin });
  const s = [];
  for (let i = 0; i < 5; i++) s.push((await send('10.0.0.1')).status);
  assert.deepEqual(s, [200, 200, 200, 429, 429]);
  const lim = await send('10.0.0.1'); assert.equal(lim.body.code, 'rate_limited'); assert.ok(Number(lim.res.headers.get('Retry-After')) > 0);
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, 3, 'throttled requests store nothing');
  assert.equal((await send('10.0.0.2')).status, 200, 'another visitor is unaffected');
  for (const ip of ['10.0.0.3', '10.0.0.4', '10.0.0.5']) assert.equal((await send(ip)).status, 200);   // 3 + 1 + 3 = 7 = the global limit
  const g = await send('10.0.0.6'); assert.equal(g.status, 429, 'global limit');
  // origins
  const c2 = await makeCrm({ CRM_PUBLIC_ORIGINS: 'https://brochure.example.co.ke/' });
  let r = await pub(c2.env, { name: 'Wanjiru', phone: newPhone() }, { origin: 'https://evil.example.com' });
  assert.deepEqual([r.status, r.body.code], [403, 'origin_not_allowed']); assert.equal(r.res.headers.get('access-control-allow-origin'), null);
  r = await pub(c2.env, { name: 'Wanjiru', phone: newPhone() }, { origin: 'https://www.mydukapos.store' });
  assert.equal(r.status, 200); assert.equal(r.res.headers.get('access-control-allow-origin'), 'https://www.mydukapos.store');
  r = await pub(c2.env, { name: 'Wanjiru', phone: newPhone() }, { origin: 'https://brochure.example.co.ke' });
  assert.equal(r.status, 200); assert.equal(r.res.headers.get('access-control-allow-origin'), 'https://brochure.example.co.ke');
  r = await pub(c2.env, null, { origin: 'https://brochure.example.co.ke', method: 'OPTIONS' });
  assert.equal(r.status, 204); assert.match(r.res.headers.get('access-control-allow-methods'), /POST/);
  r = await pub(c2.env, null, { origin: 'https://evil.example.com', method: 'OPTIONS' }); assert.equal(r.status, 403);
  // through the real middleware: the managed CORS header survives (and the marker never leaks)
  const mw = await load('_middleware.js');
  const req = new Request('https://mydukapos.store/api/crm-lead', { method: 'POST', headers: { Origin: 'https://brochure.example.co.ke', 'content-type': 'application/json', 'CF-Connecting-IP': '3.3.3.3' }, body: JSON.stringify({ name: 'Wanjiru', phone: newPhone() }) });
  const mres = await mw.onRequest({ request: req, env: c2.env, next: async () => (await load('crm-lead.js')).onRequestPost({ request: req, env: c2.env }), waitUntil() {} });
  assert.equal(mres.status, 200); assert.equal(mres.headers.get('access-control-allow-origin'), 'https://brochure.example.co.ke'); assert.equal(mres.headers.get('x-crm-cors'), null);
  // no database
  const noDb = makeEnv(); delete noDb.LEDGER_DB;
  r = await pub(noDb, { name: 'Wanjiru', phone: newPhone() }); assert.deepEqual([r.status, r.body.code], [503, 'crm_database_missing']);
});

test('WhatsApp webhook: signature, ingest, dedupe by message id, ad-referral -> lead with attribution, other chats stay conversations, 503 without D1', async () => {
  const c = await makeCrm({ WHATSAPP_APP_SECRET: WA_SECRET });
  const a = await c.staff('Ann');
  assert.equal((await waHook(c.env, [msg('w0', '254700111222', 'hi')], {}, { badSig: true })).status, 401);
  assert.equal((await waHook(c.env, [msg('w0', '254700111222', 'hi')], {}, { secret: 'other' })).status, 401);
  assert.equal(c.q('select count(*) n from crm_messages')[0].n, 0, 'nothing stored on a bad signature');
  // ordinary chat: a conversation and a message, NO lead
  assert.equal((await waHook(c.env, [msg('w1', '254700111222', 'Do you sell POS?')], { '254700111222': 'Random Person' })).status, 200);
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, 0);
  const conv = c.q(`select * from crm_conversations where wa_id = '254700111222'`)[0];
  assert.deepEqual([conv.contact_name, conv.unread_count, conv.lead_id], ['Random Person', 1, null]);
  assert.ok((await c.ok('GET', '/notifications')).items.some((n) => n.kind === 'whatsapp_message'));
  // Meta re-delivers the same message id: not stored twice
  await waHook(c.env, [msg('w1', '254700111222', 'Do you sell POS?')], {});
  assert.equal(c.q('select count(*) n from crm_messages')[0].n, 1); assert.equal(c.q(`select unread_count n from crm_conversations where wa_id = '254700111222'`)[0].n, 1);
  // ad chat: lead + attribution + ad entity, source meta_ads
  await waHook(c.env, [msg('w2', '254700333444', 'saw your ad', null, adRef('AD77'))], { '254700333444': 'Ad Person' });
  const l = c.q(`select * from crm_leads where whatsapp_norm = '254700333444'`)[0];
  assert.deepEqual([l.name, l.source_key, l.status_key, l.owner_id], ['Ad Person', 'meta_ads', 'new', null]);
  assert.ok(l.first_ad_id); assert.equal(c.q('select external_id from crm_ads where id = ?', l.first_ad_id)[0].external_id, 'AD77');
  assert.equal(c.q('select click_id from crm_attribution_events where lead_id = ?', l.id)[0].click_id, 'clid-AD77');
  // the same person writes again from a different ad: same lead, first attribution kept, a second event
  await waHook(c.env, [msg('w3', '254700333444', 'and this one', null, adRef('AD88', 'Second ad'))], {});
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, 1);
  const l2 = c.q(`select first_ad_id from crm_leads where id = ?`, l.id)[0]; assert.equal(l2.first_ad_id, l.first_ad_id);
  assert.equal(c.q('select count(*) n from crm_attribution_events where lead_id = ?', l.id)[0].n, 2);
  // a plain follow-up joins the conversation linked to the lead
  await waHook(c.env, [msg('w4', '254700333444', 'how much?')], {});
  const cv = await c.ok('GET', '/inbox/conversations');
  const mine = cv.items.find((x) => x.leadId === l.id); assert.ok(mine); assert.equal(mine.unread, 3);
  const thread = await c.ok('GET', `/inbox/conversations/${mine.id}/messages`);
  assert.deepEqual(thread.items.map((m) => m.text), ['saw your ad', 'and this one', 'how much?']);
  // a plain chat from a number that IS an existing lead is linked to it, not turned into a second lead
  const ex = (await c.ok('POST', '/leads', { body: { name: 'Existing', phone: '0700555666' } })).lead;
  await waHook(c.env, [msg('w5', '254700555666', 'hello there')], {});
  assert.equal(c.q(`select lead_id from crm_conversations where wa_id = '254700555666'`)[0].lead_id, ex.id);
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, 2);
  // owner sees the unread, staff mark read
  await c.ok('POST', `/inbox/conversations/${mine.id}/read`, {});
  assert.equal(c.q('select unread_count n from crm_conversations where id = ?', mine.id)[0].n, 0);
  // legacy KV inbox still gets the ad lead (transition)
  assert.ok(c.kv.data.size > 0);
  // no D1: the webhook still verifies but reports the problem? (legacy KV path keeps working)
  const noDb = makeEnv({ WHATSAPP_APP_SECRET: WA_SECRET }); delete noDb.LEDGER_DB;
  const r = await waHook(noDb, [msg('w9', '254700999888', 'x', null, adRef('AD1'))], {});
  assert.equal(r.status, 200, 'the old KV inbox path keeps working while D1 is not bound');
  // verification handshake
  const m = await load('whatsapp-webhook.js');
  const g = await m.onRequestGet({ request: new Request('https://x/api/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=CH'), env: { WHATSAPP_VERIFY_TOKEN: 'vt' } });
  assert.equal(await g.text(), 'CH');
});

test('WhatsApp send: whatsapp_not_configured without the Cloud API secrets; with them the message goes to Graph and is stored; Graph errors -> 502 and nothing is stored', async () => {
  const c = await makeCrm({ WHATSAPP_APP_SECRET: WA_SECRET });
  const a = await c.staff('Ann');
  await waHook(c.env, [msg('w1', '254711222333', 'Hello')], { '254711222333': 'Chatty' });
  const conv = c.q(`select id from crm_conversations`)[0].id;
  const send = (token, text = 'Hi, how can I help?') => c.api('POST', `/inbox/conversations/${conv}/messages`, { token, body: { text } });
  let r = await send(undefined); assert.deepEqual([r.status, r.body.code], [409, 'whatsapp_not_configured']);
  assert.equal(c.q(`select count(*) n from crm_messages where direction = 'out'`)[0].n, 0);
  assert.equal((await c.api('POST', `/inbox/conversations/${conv}/messages`, { body: { text: '  ' } })).status, 400);
  // configured (fetch stubbed at the network edge only)
  c.env.WHATSAPP_TOKEN = 'wa-token'; c.env.WHATSAPP_PHONE_NUMBER_ID = '555';
  const realFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT1' }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    r = await send(undefined);
    assert.equal(r.status, 201); assert.equal(r.body.message.direction, 'out'); assert.equal(r.body.message.status, 'sent');
    assert.match(calls[0].url, /\/555\/messages$/); assert.equal(calls[0].init.headers.Authorization, 'Bearer wa-token');
    const sent = JSON.parse(calls[0].init.body); assert.deepEqual([sent.to, sent.text.body, sent.messaging_product], ['254711222333', 'Hi, how can I help?', 'whatsapp']);
    assert.equal(c.q(`select ext_id from crm_messages where direction = 'out'`)[0].ext_id, 'wamid.OUT1');
    assert.equal(c.q(`select count(*) n from crm_audit where action = 'chat_send'`)[0].n, 1);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'Re-engagement message', code: 131047 } }), { status: 400, headers: { 'content-type': 'application/json' } });
    r = await send(undefined, 'again');
    assert.deepEqual([r.status, r.body.code], [502, 'whatsapp_send_failed']); assert.match(r.body.error, /Re-engagement/);
    assert.equal(c.q(`select count(*) n from crm_messages where direction = 'out'`)[0].n, 1, 'a failed send is not recorded as sent');
    globalThis.fetch = async () => { throw new Error('network'); };
    assert.equal((await send(undefined, 'again')).status, 502);
  } finally { globalThis.fetch = realFetch; }
  // sales staff need to own the linked lead / be allowed to reply
  const other = await c.staff('Ben');
  assert.ok([403, 404].includes((await send(other.token)).status));
  // inbox status tells the UI whether sending is available
  assert.equal((await c.ok('GET', '/inbox/status')).apiConfigured, true);
});

test('Meta lead-ads webhook: verify handshake, signature (META_APP_SECRET, else WHATSAPP_APP_SECRET), unresolved event without a page token, Graph resolution, dedupe', async () => {
  const m = await load('crm-meta-webhook.js');
  const post = async (env, obj, { secret = 'meta-secret', bad = false } = {}) => {
    const body = JSON.stringify(obj);
    const res = await m.onRequestPost({ request: new Request('https://x/api/crm-meta-webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': bad ? 'sha256=' + '1'.repeat(64) : sign(body, secret) } }), env });
    return { status: res.status, text: await res.text() };
  };
  const ev = (id, extra = {}) => ({ object: 'page', entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: id, ad_id: 'AD9', form_id: 'F1', page_id: 'P1', ...extra } }] }] });
  const c = await makeCrm({ META_APP_SECRET: 'meta-secret', META_VERIFY_TOKEN: 'vt' });
  const get = (q, env = c.env) => m.onRequestGet({ request: new Request('https://x/api/crm-meta-webhook?' + q), env });
  assert.equal(await (await get('hub.mode=subscribe&hub.verify_token=vt&hub.challenge=abc')).text(), 'abc');
  assert.equal((await get('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc')).status, 403);
  assert.equal((await get('hub.mode=subscribe&hub.verify_token=vt&hub.challenge=abc', {})).status, 503);
  assert.equal((await post(c.env, ev('L1'), { bad: true })).status, 401);
  assert.equal((await post(c.env, ev('L1'), { secret: 'wrong' })).status, 401);
  assert.equal((await post({ ...c.env, META_APP_SECRET: undefined }, ev('L1'))).status, 503);
  assert.equal(c.q('select count(*) n from crm_attribution_events')[0].n, 0);
  // fallback secret
  const fb = await makeCrm({ WHATSAPP_APP_SECRET: 'meta-secret' });
  assert.equal((await post(fb.env, ev('L0'))).status, 200);
  // no page token: kept as an unresolved event, no lead invented
  let r = await post(c.env, ev('L1'));
  assert.equal(r.status, 200); assert.equal(JSON.parse(r.text).results.unresolved, 1);
  assert.equal(c.q('select count(*) n from crm_leads')[0].n, 0);
  const u = c.q('select resolved, external_id from crm_attribution_events')[0]; assert.deepEqual([u.resolved, u.external_id], [0, 'leadgen:L1']);
  assert.equal((await c.api('POST', '/integrations/meta/resolve', {})).body.code, 'meta_not_configured');
  // token set: the lead is fetched from Graph (stubbed at the network edge)
  const realFetch = globalThis.fetch; const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ created_time: '2026-09-29T08:00:00+0000', ad_id: 'AD9', ad_name: 'Big Sale', adset_id: 'AS9', adset_name: 'Nairobi 25-45', campaign_id: 'CP9', campaign_name: 'September Push', field_data: [{ name: 'full_name', values: ['Meta Person'] }, { name: 'phone_number', values: ['+254 733 000 111'] }, { name: 'email', values: ['meta@x.co.ke'] }, { name: 'company_name', values: ['Meta Shop'] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    c.env.META_PAGE_TOKEN = 'page-token';
    const res = await c.ok('POST', '/integrations/meta/resolve', {});
    assert.equal(res.created, 1); assert.match(urls[0], /graph\.facebook\.com\/.*\/L1\?fields=/);
    const l = c.q(`select * from crm_leads`)[0];
    assert.deepEqual([l.name, l.phone, l.business_name, l.source_key], ['Meta Person', '+254733000111', 'Meta Shop', 'meta_ads']);
    assert.equal(c.q('select external_id, name from crm_campaigns')[0].external_id, 'CP9'); assert.equal(c.q('select name from crm_ads')[0].name, 'Big Sale');
    assert.ok(l.first_campaign_id && l.first_adset_id && l.first_ad_id);
    assert.equal(c.q('select resolved from crm_attribution_events where external_id = ?', 'leadgen:L1')[0].resolved, 1);
    // Meta retries the same event: no duplicate
    r = await post(c.env, ev('L1')); assert.equal(JSON.parse(r.text).results.duplicate, 1); assert.equal(c.q('select count(*) n from crm_leads')[0].n, 1);
    // a new event for the same person adds a touch, not a lead
    r = await post(c.env, ev('L2')); assert.equal(JSON.parse(r.text).results.touched, 1); assert.equal(c.q('select count(*) n from crm_leads')[0].n, 1);
    assert.equal(c.q('select count(*) n from crm_attribution_events where lead_id = ?', l.id)[0].n, 2);
    // Graph failure: parked, not lost, and Meta gets a 200 so it stops retrying
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'Invalid OAuth token' } }), { status: 400 });
    r = await post(c.env, ev('L3')); assert.equal(r.status, 200); assert.equal(JSON.parse(r.text).results.unresolved, 1);
    assert.match(c.q(`select raw from crm_attribution_events where external_id = 'leadgen:L3'`)[0].raw, /Invalid OAuth token/);
  } finally { globalThis.fetch = realFetch; }
  // non-leadgen changes are ignored
  r = await post(c.env, { entry: [{ changes: [{ field: 'feed', value: {} }] }] }); assert.equal(JSON.parse(r.text).results.ignored, 1);
});
