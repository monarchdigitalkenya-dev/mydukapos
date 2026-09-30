import test from 'node:test';
import assert from 'node:assert/strict';
import { bootCrm } from './crm-ui-boot.mjs';
import { makeStub } from './crm-ui-stub.mjs';

// Zip 158 — CRM front end: the lead form's extra fields and the list columns, WhatsApp attachments in the inbox, the Automation screen.
const OWNER = { pos_owner_session_token: 'o2.tok', crm_mode: 'owner' };
const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), blob: async () => new Blob([JSON.stringify(body)], { type: 'image/png' }) });
const labelInput = (b, text) => { const l = b.qa('.modal label').find((x) => x.textContent.trim().startsWith(text)); return l && b.d.getElementById(l.getAttribute('for')); };

test('lead list columns: product, deal value, last contact, next follow-up show; a header click sorts on the server (sort=product)', async () => {
  const now = Date.now();
  const stub = makeStub({ leads: [
    { id: 'L1', name: 'Amina Hassan', phone: '0711222333', status: 'new', ownerId: 'u1', ownerName: 'Wanjiru', source: 'whatsapp', createdAt: now - 3600e3, product: 'MyDuka Hotel', dealValue: 5000, lastContact: now - 7200e3, nextFollow: now + 86400e3, revenue: 1200 },
  ] });
  const b = await bootCrm({ stub, storage: OWNER, hash: '#/leads' });
  await b.until(() => b.q('table.t tbody tr'));
  const heads = b.qa('table.t thead th').map((t) => t.textContent.trim());
  for (const h of ['Product', 'Deal value', 'Last contact', 'Next follow-up', 'Revenue', 'Campaign', 'Ad']) assert.ok(heads.some((x) => x.startsWith(h)), 'column ' + h + ': ' + heads.join('|'));
  const row = b.q('table.t tbody tr').textContent;
  assert.match(row, /MyDuka Hotel/); assert.match(row, /5,000/);
  b.click(b.qa('table.t thead th').find((t) => t.textContent.trim().startsWith('Product')));
  await b.until(() => stub.calls.some((c) => c.path === '/leads' && c.q.sort === 'product'));
  assert.equal(stub.calls.filter((c) => c.path === '/leads' && c.q.sort === 'product').pop().q.dir, 'asc');
  await b.until(() => b.qa('table.t thead th').find((t) => t.textContent.trim().startsWith('Product') && t.getAttribute('aria-sort') === 'ascending'));
  b.click(b.qa('table.t thead th').find((t) => t.textContent.trim().startsWith('Product')));
  await b.until(() => stub.calls.some((c) => c.path === '/leads' && c.q.sort === 'product' && c.q.dir === 'desc'));
  assert.deepEqual(b.errors, []); b.close();
});

test('add lead form: country, estimated value, expected close date and next action are sent; a negative value is refused before sending', async () => {
  const stub = makeStub(); const b = await bootCrm({ stub, storage: OWNER, hash: '#/leads' });
  await b.until(() => b.byText('.pagehead button', 'Add lead')); b.click(b.byText('.pagehead button', 'Add lead')); await b.until(() => b.q('.modal input[type=tel]'));
  b.type(b.qa('.modal input[type=text]')[0], 'Zawadi Otieno'); b.type(b.q('.modal input[type=tel]'), '0733444555');
  b.type(labelInput(b, 'Country'), 'Uganda'); b.type(labelInput(b, 'Estimated value'), '-5'); b.type(labelInput(b, 'Expected close date'), '2026-12-01'); b.type(labelInput(b, 'Next action'), 'Send the quote');
  b.click(b.byText('.modal button', 'Save lead'));
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!stub.calls.some((c) => c.method === 'POST' && c.path === '/leads'), 'a negative estimated value is not sent');
  assert.match(b.text(), /Estimated value must be 0 or more/);
  b.type(labelInput(b, 'Estimated value'), '25000');
  b.click(b.byText('.modal button', 'Save lead'));
  await b.until(() => stub.calls.some((c) => c.method === 'POST' && c.path === '/leads'));
  const body = stub.calls.find((c) => c.method === 'POST' && c.path === '/leads').body;
  assert.equal(body.name, 'Zawadi Otieno'); assert.equal(body.country, 'Uganda'); assert.equal(body.estimatedValue, 25000);
  assert.equal(body.expectedCloseDate, '2026-12-01'); assert.equal(body.nextAction, 'Send the quote');
  assert.deepEqual(b.errors, []); b.close();
});

test('inbox: attachments show a typed label with the caption; Open fetches the file through the API; without the token it explains', async () => {
  const stub = makeStub({ apiConfigured: true });
  const t = Date.now();
  stub.messages.cv1 = [
    { id: 'm1', direction: 'in', type: 'text', text: 'Hello, price?', at: t - 90e3 },
    { id: 'm2', direction: 'in', type: 'image', text: 'the shop front', caption: 'the shop front', media: { label: '📷 Image', mime: 'image/jpeg', available: true }, at: t - 80e3 },
    { id: 'm3', direction: 'in', type: 'voice', text: '', caption: '', media: { label: '🎤 Voice note', mime: 'audio/ogg', available: true }, at: t - 70e3 },
    { id: 'm4', direction: 'in', type: 'document', text: 'please sign', caption: 'please sign', media: { label: '📄 Quote 44.pdf', mime: 'application/pdf', name: 'Quote 44.pdf', available: false }, at: t - 60e3 },
  ];
  let mediaStatus = 409;
  const f0 = stub.fetch; stub.fetch = async (url, init) => { const u = new URL(url, 'https://mydukapos.store'); if (u.pathname.startsWith('/api/crm/inbox/media/')) { stub.calls.push({ method: 'GET', path: u.pathname.replace('/api/crm', ''), q: {} }); return mediaStatus === 200 ? json(200, 'x') : json(409, { error: 'not connected', code: 'whatsapp_not_configured' }); } return f0(url, init); };
  const b = await bootCrm({ stub, storage: OWNER, hash: '#/inbox/cv1' });
  await b.until(() => b.qa('.bubble').length >= 4);
  const bubbles = b.qa('.bubble').map((x) => x.textContent);
  assert.ok(bubbles.some((x) => /📷 Image/.test(x) && /the shop front/.test(x)), 'image + caption');
  assert.ok(bubbles.some((x) => /🎤 Voice note/.test(x)), 'voice note');
  assert.ok(bubbles.some((x) => /📄 Quote 44\.pdf/.test(x) && /please sign/.test(x)), 'document name + caption');
  assert.ok(!bubbles.some((x) => /\[(image|voice|document)\]/.test(x)), 'no bare [type] text');
  assert.equal(b.qa('.bubble button[data-media]').length, 2, 'Open only where the file can be fetched');
  b.w.open = () => { b.w.__opened = (b.w.__opened || 0) + 1; }; b.w.URL.createObjectURL = () => 'blob:x'; b.w.URL.revokeObjectURL = () => {};
  b.click(b.qa('.bubble button[data-media]')[0]);
  await b.until(() => /cannot be opened here/.test(b.text()));
  mediaStatus = 200;
  b.click(b.qa('.bubble button[data-media]')[0]);
  await b.until(() => b.w.__opened === 1);
  assert.deepEqual(b.errors, []); b.close();
});

test('Settings > Automation: the two rules and the recent events show; saving sends the minutes (0 = off)', async () => {
  const stub = makeStub();
  const rules = { autoUnassignedLeadMinutes: 30, autoFollowupOverdueMinutes: 15 };
  const f0 = stub.fetch;
  stub.fetch = async (url, init = {}) => {
    const u = new URL(url, 'https://mydukapos.store'); const p = u.pathname.replace('/api/crm', '');
    if (p === '/automation') { stub.calls.push({ method: 'GET', path: p, q: {} }); return json(200, { canEdit: true, pendingEvents: 3, rules: [
      { key: 'autoUnassignedLeadMinutes', label: 'A new lead nobody has taken', action: 'Notify the managers', unit: 'minutes', value: rules.autoUnassignedLeadMinutes, off: rules.autoUnassignedLeadMinutes === 0 },
      { key: 'autoFollowupOverdueMinutes', label: 'A follow-up is overdue', action: 'Notify its owner', unit: 'minutes', value: rules.autoFollowupOverdueMinutes, off: false }],
      events: [{ id: 9, name: 'automation.unassigned_lead_escalated', at: Date.now() - 60e3, processedAt: null }, { id: 8, name: 'lead.created', actorName: 'Wanjiru', at: Date.now() - 120e3, processedAt: Date.now() }] }); }
    if (p === '/settings' && (init.method || '').toUpperCase() === 'PUT') { const body = JSON.parse(init.body); stub.calls.push({ method: 'PUT', path: p, q: {}, body }); Object.assign(rules, body.settings); return json(200, { settings: rules }); }
    return f0(url, init);
  };
  const b = await bootCrm({ stub, storage: OWNER, hash: '#/settings' });
  await b.until(() => b.byText('.tab', 'Automation')); b.click(b.byText('.tab', 'Automation'));
  await b.until(() => b.q('[data-rule]'));
  assert.equal(b.qa('[data-rule]').length, 2);
  assert.match(b.text(), /A new lead nobody has taken/); assert.match(b.text(), /automation\.unassigned_lead_escalated/); assert.match(b.text(), /3 waiting/);
  assert.equal(b.qa('[data-event]').length, 2);
  b.type(b.q('[data-rule="autoUnassignedLeadMinutes"] input'), '0');
  b.click(b.byText('button', 'Save rules'));
  await b.until(() => stub.calls.some((c) => c.method === 'PUT' && c.path === '/settings'));
  assert.deepEqual(stub.calls.find((c) => c.method === 'PUT').body, { settings: { autoUnassignedLeadMinutes: 0, autoFollowupOverdueMinutes: 15 } });
  await b.until(() => /\(off\)/.test(b.text()));
  assert.deepEqual(b.errors, []); b.close();
});
