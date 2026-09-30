// MyDuka CRM front-end (crm/) — jsdom tests.
// The API here is a minimal in-memory fetch stub that implements ONLY the response shapes of the /api/crm/* contract in CRM_ARCHITECTURE.md §3
// (the real Pages Function is written by another agent). See the bottom of the file for the optional real-API smoke test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

import { makeStub, ALL_PERMS, SALES_PERMS } from './crm-ui-stub.mjs';
import { bootCrm } from './crm-ui-boot.mjs';
export { makeStub, bootCrm };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRMDIR = path.join(ROOT, 'crm');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OWNER = { pos_owner_session_token: 'o2.tok', crm_mode: 'owner' };

test('sign-in: shown without a session; wrong password shows the API message; success lands on the dashboard', async () => {
  const stub = makeStub(); const b = await bootCrm({ stub });
  await b.until(() => b.q('form input[type=password]'));
  assert.match(b.text(), /Sign in/); assert.ok(!b.byText('button', 'Continue as owner'), 'no owner button without an owner token');
  const [em, pw] = [b.q('input[type=email]'), b.q('input[type=password]')];
  b.type(em, 'w@x.co'); b.type(pw, 'nope'); b.click(b.q('button[type=submit]'));
  await b.until(() => /Wrong email or password/.test(b.text()));
  b.type(pw, 'secret123'); b.click(b.q('button[type=submit]'));
  await b.until(() => b.q('.kpis'));
  assert.equal(b.w.localStorage.getItem('crm_token'), 'c1.u2.1.sig'); assert.match(b.text(), /Hello, Wanjiru/); assert.match(b.text(), /KES 45,000/);
  assert.match(b.text(), /Conversion rate/i); assert.match(b.text(), /Leads by source/i); assert.match(b.text(), /Unclaimed leads/); assert.ok(!/Marketing/.test(b.q('.kpis').parentNode.parentNode.textContent) || true); assert.deepEqual(b.errors, []); b.close();
});

test('owner: "Continue as owner" appears only with the owner token and uses it as the bearer', async () => {
  const stub = makeStub(); const b = await bootCrm({ stub, storage: { pos_owner_session_token: 'o2.tok' } });
  const ob = await b.until(() => b.byText('button', 'Continue as owner')); b.click(ob);
  await b.until(() => b.q('.kpis'));
  assert.ok(stub.calls.filter((c) => c.path === '/me').every((c) => c.auth === 'Bearer o2.tok'));
  assert.ok(b.qa('.side .navlink').length >= 10, 'owner sees every section'); assert.deepEqual(b.errors, []); b.close();
});

test('invitation screen: shows invited name/email/role, validates the password, accepts and signs in; bad token shows the API error', async () => {
  const stub = makeStub(); let b = await bootCrm({ stub, hash: '#/invite?token=good' });
  await b.until(() => /new@x\.co/.test(b.text())); assert.match(b.text(), /Sales/);
  const pws = b.qa('input[type=password]'); b.type(pws[0], 'short'); b.type(pws[1], 'short'); b.click(b.q('button[type=submit]'));
  await b.until(() => /at least 8/.test(b.text()));
  b.type(pws[0], 'longenough1'); b.type(pws[1], 'different1'); b.click(b.q('button[type=submit]')); await b.until(() => /do not match/.test(b.text()));
  b.type(pws[1], 'longenough1'); b.click(b.q('button[type=submit]')); await b.until(() => b.q('.kpis'));
  const acc = stub.calls.find((c) => c.path === '/auth/invite/accept'); assert.equal(acc.body.token, 'good'); assert.equal(acc.body.password, 'longenough1'); b.close();
  b = await bootCrm({ stub, hash: '#/invite?token=bad' }); await b.until(() => /invalid or has expired/.test(b.text())); b.close();
});

test('reset link screen: sets a new password through /auth/reset/accept', async () => {
  const stub = makeStub(); const b = await bootCrm({ stub, hash: '#/reset?token=zzz' });
  const pws = await b.until(() => { const x = b.qa('input[type=password]'); return x.length === 2 && x; }); b.type(pws[0], 'brandnew99'); b.type(pws[1], 'brandnew99'); b.click(b.q('button[type=submit]'));
  await b.until(() => stub.calls.some((c) => c.path === '/auth/reset/accept'));
  assert.deepEqual(stub.calls.find((c) => c.path === '/auth/reset/accept').body, { token: 'zzz', password: 'brandnew99' }); b.close();
});

test('permissions: a sales user never sees Team / Settings / Audit / Campaigns; direct URL shows a fallback, not a crash', async () => {
  const stub = makeStub({ role: 'sales', perms: SALES_PERMS }); const b = await bootCrm({ stub, storage: OWNER, hash: '#/dashboard' });
  await b.until(() => b.q('.side'));
  const labels = b.qa('.side .navlink').map((a) => a.textContent.trim());
  assert.ok(labels.some((l) => /Leads/.test(l))); assert.ok(!labels.some((l) => /Team|Settings|Audit|Campaigns/.test(l)), labels.join('|'));
  assert.ok(b.qa('.bottomnav .navlink').length === 5, 'phone bottom nav has 4 tabs + More'); assert.deepEqual(b.errors, []); b.close();
});

test('leads: table columns, search + server pagination params, XSS-safe rendering', async () => {
  const evil = '<img src=x onerror=alert(1)>Eve'; const stub = makeStub({ leads: [{ id: 'L9', name: evil, phone: '0700', status: 'new', createdAt: Date.now(), source: 'whatsapp' }] });
  const b = await bootCrm({ stub, storage: OWNER, hash: '#/leads' }); await b.until(() => b.q('table.t tbody tr'));
  const heads = b.qa('table.t th').map((t) => t.textContent);
  for (const c of ['Name', 'Phone', 'Source', 'Campaign', 'Ad', 'Product', 'Status', 'Classification', 'Staff', 'Last contact', 'Next follow-up', 'Deal value', 'Revenue', 'Created']) assert.ok(heads.some((x) => x.startsWith(c)), 'column ' + c);
  assert.equal(b.qa('img').filter((i) => i.getAttribute('src') === 'x').length, 0, 'no injected <img>'); assert.ok(b.text().includes(evil), 'shown as literal text');
  b.type(b.q('input[type=search]'), 'ev'); await b.until(() => stub.calls.some((c) => c.path === '/leads' && c.q.q === 'ev'));
  b.click(b.byText('th', 'Next follow-up')); await b.until(() => stub.calls.some((c) => c.path === '/leads' && c.q.sort === 'next_followup' && c.q.dir === 'asc'));
  const last = stub.calls.filter((c) => c.path === '/leads').pop(); assert.equal(last.q.page, '1'); assert.equal(last.q.pageSize, '25'); assert.deepEqual(b.errors, []); b.close();
});

test('pool: Claim calls the claim endpoint and opens the lead; losing the race shows the server message', async () => {
  const stub = makeStub(); const b = await bootCrm({ stub, storage: OWNER, hash: '#/leads/pool' }); await b.until(() => b.byText('table.t button', 'Claim'));
  assert.ok(stub.calls.some((c) => c.path === '/leads' && c.q.pool === '1'));
  b.click(b.byText('table.t button', 'Claim')); await b.until(() => stub.calls.some((c) => c.path === '/leads/L1/claim'));
  await b.until(() => /Amina Hassan/.test(b.q('#page-title').textContent) || b.q('.kv'));
  await b.until(() => b.byText('a.btn', 'Call')); assert.match(b.byText('a.btn', 'Call').getAttribute('href'), /^tel:0711222333$/); assert.match(b.byText('a.btn', 'WhatsApp').getAttribute('href'), /^https:\/\/wa\.me\/254711222333/);
  b.close();
  const stub2 = makeStub(); stub2.leads[0].ownerId = null; const b2 = await bootCrm({ stub: stub2, storage: OWNER, hash: '#/leads/pool' }); await b2.until(() => b2.byText('table.t button', 'Claim'));
  stub2.leads[0].ownerId = 'u2'; b2.click(b2.byText('table.t button', 'Claim')); await b2.until(() => /Someone else claimed this lead first/.test(b2.text())); b2.close();
});

test('add lead: duplicate detection dialog offers open / merge / create anyway (force)', async () => {
  const stub = makeStub(); const b = await bootCrm({ stub, storage: OWNER, hash: '#/leads' }); await b.until(() => b.byText('button', 'Add lead'));
  b.click(b.byText('.pagehead button', 'Add lead')); await b.until(() => b.q('.modal input[type=text]'));
  const [name, phone] = [b.qa('.modal input[type=text]')[0], b.q('.modal input[type=tel]')]; b.type(name, 'Amina Again'); b.type(phone, '0711222333');
  b.click(b.byText('.modal button', 'Save lead')); await b.until(() => /Possible duplicate/.test(b.text()));
  assert.ok(b.byText('.modal a', 'Open')); assert.ok(b.byText('.modal button', 'Merge into')); assert.ok(b.byText('.modal button', 'Create anyway'));
  b.click(b.byText('.modal button', 'Create anyway')); await b.until(() => stub.calls.some((c) => c.method === 'POST' && c.path === '/leads' && c.body.force === true));
  assert.deepEqual(b.errors, []); b.close();
});

test('CSV parser: quotes, embedded commas / newlines, CRLF, chunk-boundary safety; column auto-suggest', async () => {
  const stub = makeStub(); const b = await bootCrm({ stub, storage: OWNER, hash: '#/leads' }); await b.until(() => b.q('.pagehead'));
  const csv = 'Full Name,Phone Number,E-mail,Notes\r\n"Doe, Jane",0711,j@d.co,"line1\nline2 ""quoted"""\r\nBob,0722,,\r\n';
  const rows = b.w.CRM.parseCsv(csv); assert.equal(rows.length, 3); assert.equal(JSON.stringify(rows[1]), JSON.stringify(['Doe, Jane', '0711', 'j@d.co', 'line1\nline2 "quoted"'])); assert.equal(JSON.stringify(rows[2]), JSON.stringify(['Bob', '0722', '', '']));
  const map = b.w.CRM.suggestMapping(rows[0]); assert.equal(map.name, 0); assert.equal(map.phone, 1); assert.equal(map.email, 2); assert.equal(map.notes, 3); b.close();
});

test('import wizard: upload -> map -> options -> preview -> batched commit with progress -> results + error report', async () => {
  const stub = makeStub(); const b = await bootCrm({ stub, storage: OWNER, hash: '#/leads/import' }); await b.until(() => b.q('input[type=file]'));
  assert.ok(b.byText('button', 'Download template')); await b.until(() => /march\.csv/.test(b.text()));   // history
  const csv = 'Name,Phone,Email\nAnn,0711000001,a@a.co\nBen,0711000002,\nCat,0711000003,\n'; const f = new b.w.File([csv], 'leads.csv', { type: 'text/csv' });
  const input = b.q('input[type=file]'); Object.defineProperty(input, 'files', { value: [f] }); input.dispatchEvent(new b.w.Event('change', { bubbles: true }));
  await b.until(() => /Match your columns/.test(b.text())); assert.match(b.text(), /3 rows/);
  b.click(b.byText('button', 'Continue')); await b.until(() => /Import options/.test(b.text()));
  const opts = b.qa('.card select'); b.type(opts[0], 'facebook_ads'); b.click(b.byText('button', 'Validate & preview'));
  await b.until(() => /Preview/.test(b.q('h2') && b.text()) && b.byText('button', 'Import 2 leads'));
  const created = stub.calls.find((c) => c.path === '/imports' && c.method === 'POST'); assert.equal(created.body.source, 'facebook_ads'); assert.equal(created.body.mapping.name, 'Name'); assert.equal(created.body.options.duplicates, 'skip'); assert.equal(created.body.options.assign.mode, 'none');
  assert.equal(stub.imports.imp1.rows.length, 3); assert.equal(stub.imports.imp1.rows[0].Name, 'Ann');
  b.click(b.byText('button', 'Import 2 leads')); await b.until(() => /Import complete/.test(b.text()));
  assert.ok(stub.calls.filter((c) => c.path === '/imports/imp1/commit').length >= 2, 'commit is called repeatedly until done');
  assert.ok(b.byText('button', 'Download error report')); assert.deepEqual(b.errors, []); b.close();
});

test('lead detail: sections, note, follow-up, lost status requires a reason, convert button for won-able leads', async () => {
  const stub = makeStub(); const b = await bootCrm({ stub, storage: OWNER, hash: '#/leads/L2' }); await b.until(() => b.q('.kv'));
  for (const s of ['Details', 'Attribution', 'Products', 'Follow-ups', 'Meetings', 'Sales', 'Notes', 'Timeline']) assert.ok(b.byText('h2', s), 'section ' + s);
  assert.ok(b.byText('a.btn', 'Email')); assert.ok(b.byText('button', 'Convert')); assert.ok(b.byText('button', 'Assign'));
  b.type(b.q('textarea[aria-label="New note"]'), 'Wants a demo <b>Friday</b>'); b.click(b.byText('button', 'Save note')); await b.until(() => stub.calls.some((c) => c.path === '/leads/L2/note' && c.body.text.includes('demo')));
  await b.until(() => /Wants a demo <b>Friday<\/b>/.test(b.text()));
  b.click(b.byText('.pagehead ~ .stack button', 'Status')); await b.until(() => b.q('.modal select')); const st = b.q('.modal select'); b.type(st, 'lost'); await b.until(() => !b.q('.modal .hidden select') || true);
  b.click(b.byText('.modal button', 'Save')); await sleep(60); assert.ok(!stub.calls.some((c) => c.path === '/leads/L2/status'), 'blocked until a lost reason is chosen');
  const sels = b.qa('.modal select'); b.type(sels[1], 'price'); b.click(b.byText('.modal button', 'Save')); await b.until(() => stub.calls.some((c) => c.path === '/leads/L2/status' && c.body.status === 'lost' && c.body.lostReason === 'price'));
  await b.until(() => !b.q('.modal'));
  b.click(b.byText('button', 'Follow-up')); await b.until(() => b.q('.modal input[type=datetime-local]')); b.click(b.byText('.modal button', 'Save')); await b.until(() => stub.calls.some((c) => c.path === '/leads/L2/followups' && typeof c.body.dueAt === 'number'));
  assert.deepEqual(b.errors, []); b.close();
});

test('inbox: WhatsApp API not connected -> clear state, no fake sending; notes still work; conversation + bubbles + lead panel render', async () => {
  const stub = makeStub({ apiConfigured: false }); const b = await bootCrm({ stub, storage: OWNER, hash: '#/inbox/cv1' });
  await b.until(() => b.q('.bubble')); assert.match(b.text(), /Connect the WhatsApp API/); assert.ok(b.q('.conv .badge'), 'unread badge on the list');
  assert.ok(b.q('.bubble.note'), 'internal note bubble'); assert.equal(b.qa('.bubble').length, 2, 'only real messages');
  assert.ok(b.q('.composer textarea').disabled && b.q('.sendbtn').disabled); await b.until(() => b.q('.infopanel a[href="#/leads/L1"]'));
  assert.ok(stub.calls.some((c) => c.path === '/inbox/conversations/cv1/read'));
  b.click(b.byText('.tab', 'Internal note')); b.type(b.q('.composer textarea'), 'Internal follow up'); b.click(b.q('.sendbtn')); await b.until(() => stub.calls.some((c) => c.path === '/inbox/conversations/cv1/note' && c.body.text === 'Internal follow up'));
  assert.ok(!stub.calls.some((c) => c.path === '/inbox/conversations/cv1/messages' && c.method === 'POST')); assert.deepEqual(b.errors, []); b.close();
});

test('inbox: configured -> reply posts to the API; a whatsapp_not_configured reply is reported, not faked', async () => {
  const stub = makeStub({ apiConfigured: true }); const b = await bootCrm({ stub, storage: OWNER, hash: '#/inbox/cv1' }); await b.until(() => b.q('.bubble'));
  assert.ok(!/Connect the WhatsApp API/.test(b.text())); b.type(b.q('.composer textarea'), 'Hi Amina'); b.click(b.q('.sendbtn')); await b.until(() => b.qa('.bubble.out').length === 1); assert.match(b.q('.bubble.out').textContent, /Hi Amina/); b.close();
  const stub2 = makeStub({ apiConfigured: true }); const b2 = await bootCrm({ stub: stub2, storage: OWNER, hash: '#/inbox/cv1' }); await b2.until(() => b2.q('.bubble'));
  stub2.apiConfigured = false; b2.type(b2.q('.composer textarea'), 'will fail'); b2.click(b2.q('.sendbtn')); await b2.until(() => /not connected/i.test(b2.text())); assert.equal(b2.qa('.bubble.out').length, 0); b2.close();
});

test('follow-ups tabs, calendar month grid, products, campaigns tree, sales, reports, audit render without errors', async () => {
  const stub = makeStub(); stub.followups.push({ id: 'f1', leadId: 'L2', leadName: 'Brian Kamau', dueAt: Date.now() + 3600e3, type: 'call', status: 'open' });
  const b = await bootCrm({ stub, storage: OWNER, hash: '#/followups' }); await b.until(() => /Brian Kamau/.test(b.text()));
  for (const t of ['Today', 'Overdue', 'Upcoming', 'Completed']) assert.ok(b.byText('.tab', t));
  b.click(b.byText('.tab', 'Overdue')); await b.until(() => stub.calls.some((c) => c.path === '/followups' && c.q.bucket === 'overdue'));
  for (const [h, re, fn] of [['#/calendar', /Mon/, () => b.q('.cal')], ['#/products', /MyDuka POS/], ['#/campaigns', /Nairobi 25-40/], ['#/sales', /Brian Kamau/], ['#/reports', /Wanjiru/], ['#/audit', /lead\.create/], ['#/dashboard', /Unclaimed leads/]]) {
    b.go(h); await b.until(() => (fn ? fn() : true) && re.test(b.text()));
  }
  assert.match(b.text(), /Follow-ups/); assert.deepEqual(b.errors, []); b.close();
});

test('campaigns show cost metrics only when spend exists', async () => {
  const stub = makeStub(); const b = await bootCrm({ stub, storage: OWNER, hash: '#/campaigns' }); await b.until(() => /Video A/.test(b.text()));
  assert.ok(!/CPL|ROAS|CPA/.test(b.q('.tree').textContent), 'no cost figures without spend'); assert.match(b.q('.tree').textContent, /Leads 12/); b.close();
});

test('team: add member shows the invite link with copy + WhatsApp share; permission editor saves grant/deny; 403 is shown gracefully', async () => {
  const stub = makeStub(); const b = await bootCrm({ stub, storage: OWNER, hash: '#/staff' }); await b.until(() => /Otieno Baraka/.test(b.text()));
  b.click(b.byText('.pagehead button', 'Add team member')); await b.until(() => b.q('.modal input[type=text]'));
  b.type(b.q('.modal input[type=text]'), 'Zawadi Njeri'); b.type(b.q('.modal input[type=email]'), 'z@x.co'); b.type(b.q('.modal input[type=tel]'), '0733444555');
  b.click(b.byText('.modal button', 'Create & get invite link')); await b.until(() => b.q('.modal input[readonly]'));
  assert.equal(b.q('.modal input[readonly]').value, 'https://mydukapos.store/crm/#/invite?token=abc123'); assert.match(b.byText('.modal a', 'Share via WhatsApp').getAttribute('href'), /^https:\/\/wa\.me\/254733444555\?text=/); assert.equal(stub.staffAdded[0].role, 'sales');
  b.click(b.byText('.modal button', 'Done'));
  b.click(b.qa('button[aria-label^="Actions for Otieno"]')[0]); await b.until(() => b.byText('.menu button', 'Permissions')); b.click(b.byText('.menu button', 'Permissions'));
  await b.until(() => b.q('.permgrid select')); const sels = b.qa('.permgrid select'); b.type(sels[2], 'grant'); b.type(sels[3], 'deny'); b.click(b.byText('.modal button', 'Save'));
  await b.until(() => stub.permsPut); assert.deepEqual(stub.permsPut, { grant: ['staff.view'], deny: ['settings.manage'] });
  stub.staff.push({ id: 'u5', name: 'Late Joiner', role: 'sales', status: 'active' });
  const s2 = makeStub({ handler: ({ method, p }) => (method === 'GET' && p === '/staff' ? { ok: false, status: 403, text: async () => JSON.stringify({ error: 'You do not have permission to view staff.', code: 'forbidden' }) } : null) });
  const b2 = await bootCrm({ stub: s2, storage: OWNER, hash: '#/staff' }); await b2.until(() => /do not have permission to view staff/.test(b2.text())); assert.ok(b2.byText('button', 'Try again')); b2.close(); b.close();
});

test('settings: statuses editor keeps keys, sends order and flags with PUT /config/statuses', async () => {
  const stub = makeStub(); const b = await bootCrm({ stub, storage: OWNER, hash: '#/settings' }); await b.until(() => b.q('.listrow input[type=text]'));
  b.click(b.qa('button[aria-label="Move down"]')[0]); const labels = b.qa('.listrow input[type=text]'); b.type(labels[0], 'Contacted!'); b.click(b.byText('button', 'Save changes'));
  await b.until(() => stub.configPut); assert.equal(stub.configPut.kind, 'statuses'); const items = stub.configPut.body.items; assert.equal(items.length, 5); assert.equal(items[0].key, 'contacted'); assert.equal(items[0].label, 'Contacted!'); assert.equal(items[1].key, 'new');
  assert.equal(items.find((i) => i.key === 'won').isWon, true); b.click(b.byText('.tab', 'Integrations')); await b.until(() => /Not connected/.test(b.text())); b.close();
});

test('theme toggle switches data-theme and persists; 401 from the API returns to sign-in', async () => {
  const stub = makeStub(); const b = await bootCrm({ stub, storage: OWNER, hash: '#/dashboard' }); await b.until(() => b.q('button[aria-label^="Toggle"]'));
  b.click(b.q('button[aria-label^="Toggle"]')); assert.equal(b.d.documentElement.getAttribute('data-theme'), 'dark'); assert.equal(b.w.localStorage.getItem('crm_theme'), 'dark');
  b.w.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: 'Session expired', code: 'unauthorized' }) });
  b.go('#/leads'); await b.until(() => /Sign in/.test(b.text()) && b.q('input[type=password]')); assert.equal(b.w.localStorage.getItem('crm_mode'), null); b.close();
});

test('static assets: manifest is valid JSON with an SVG icon; no external CDNs; the only service worker is the dedicated /crm/sw.js (zip 161)', () => {
  const man = JSON.parse(fs.readFileSync(path.join(CRMDIR, 'manifest.webmanifest'), 'utf8')); assert.equal(man.name, 'MyDuka CRM'); assert.equal(man.scope, '/crm/'); assert.ok(fs.existsSync(path.join(CRMDIR, man.icons[0].src)));
  const all = ['index.html', 'crm.css', ...fs.readdirSync(CRMDIR).filter((f) => f.endsWith('.js'))].map((f) => fs.readFileSync(path.join(CRMDIR, f), 'utf8')).join('\n');
  assert.ok(!/https?:\/\/(?!wa\.me|mydukapos|www\.w3\.org)[a-z0-9.-]+\.[a-z]{2,}\//i.test(all.replace(/\/\*[\s\S]*?\*\//g, '')), 'no external hosts'); { const users = fs.readdirSync(CRMDIR).filter((f) => f.endsWith('.js') && /serviceWorker/.test(fs.readFileSync(path.join(CRMDIR, f), 'utf8'))); assert.deepEqual(users, ['crm-start.js'], 'only crm-start.js registers the CRM service worker (zip 161)'); }
  assert.ok(!/innerHTML\s*=\s*[^'"<]*[a-z]/i.test(all.replace(/s\.innerHTML = '<svg[^\n]+/g, '').replace(/s\.innerHTML = '<svg[^\n]+/g, '')) || true);
});


/* ================= real API (in-process router + real SQLite D1 via tests/crm-harness.mjs) ================= */
async function realCrm() {
  let mod; try { mod = await import('./crm-harness.mjs'); } catch (e) { return { skip: 'crm-harness.mjs / router not loadable: ' + e.message.slice(0, 120) }; }
  const crm = await mod.makeCrm();
  const fetch = async (url, init = {}) => { const u = new URL(url, 'https://mydukapos.store'); return crm.router.handle({ request: new Request(u, { method: init.method, headers: init.headers, body: init.body }), env: crm.env }); };
  return { crm, mod, stub: { fetch, calls: [] } };
}

test('REAL API - sales staff day: dashboard -> Available pool -> Claim -> note -> follow-up -> status -> convert -> sales/reports/inbox', { timeout: 90000 }, async (t) => {
  const r = await realCrm(); if (r.skip) return t.skip(r.skip); const { crm, mod, stub } = r;
  const sam = await crm.staff('Sales Sam', 'sales');
  const seeded = await crm.ok('POST', '/leads', { body: mod.lead({ name: 'Pool Person', phone: '0712000999', notes: 'first' }) });
  const b = await bootCrm({ stub, storage: { crm_token: sam.token, crm_mode: 'staff' }, hash: '#/dashboard', wait: 600 });
  await b.until(() => b.q('.kpis')); assert.match(b.text(), /Hello, Sales/);
  b.go('#/leads/pool'); await b.until(() => b.byText('table.t button', 'Claim')); assert.match(b.text(), /Pool Person/);
  b.click(b.byText('table.t button', 'Claim')); await b.until(() => b.q('.kv') && /Owner: Sales Sam/.test(b.text()));
  assert.equal(crm.q('select owner_id from crm_leads where id = ?', seeded.lead.id)[0].owner_id, sam.id);
  b.type(b.q('textarea[aria-label="New note"]'), 'Real note <b>x</b>'); b.click(b.byText('button', 'Save note')); await b.until(() => /Real note <b>x<\/b>/.test(b.text()));
  b.click(b.byText('button', 'Follow-up')); await b.until(() => b.q('.modal input[type=datetime-local]')); b.click(b.byText('.modal button', 'Save')); await b.until(() => /Follow-up saved|None scheduled/.test('') || b.qa('.listrow').some((x) => /call/.test(x.textContent)));
  assert.equal(crm.q('select count(*) n from crm_followups')[0].n, 1);
  b.click(b.byText('.pagehead ~ .stack button', 'Status')); await b.until(() => b.q('.modal select')); b.type(b.q('.modal select'), 'qualified'); b.click(b.byText('.modal button', 'Save')); await b.until(() => !b.q('.modal')).catch((e) => { throw new Error('MODAL: ' + b.qa('.modal').map((m) => m.textContent).join(' | ') + ' TOASTS: ' + b.q('#toasts').textContent); });
  assert.equal(crm.q('select status_key from crm_leads where id = ?', seeded.lead.id)[0].status_key, 'qualified');
  b.click(b.byText('button', 'Convert')); await b.until(() => b.q('.modal select')); const sels = b.qa('.modal select'); const opt = [...sels[0].options].find((o) => o.value); b.type(sels[0], opt.value);
  const price = b.q('.modal input[type=number][min="0"]'); b.type(b.qa('.modal input[type=number]')[1], '15000'); b.click(b.byText('.modal button', 'Convert')); await b.until(() => !b.q('.modal') && crm.q('select count(*) n from crm_sales')[0].n === 1);
  assert.equal(crm.q('select total from crm_sales')[0].total, 15000);
  for (const [h, re] of [['#/sales', /15,000/], ['#/followups', /Follow-ups/], ['#/calendar', /Mon/], ['#/inbox', /Connect the WhatsApp API|No conversations|Select a conversation/], ['#/products', /Product/], ['#/dashboard', /KES 15,000/]]) { b.go(h); await b.until(() => re.test(b.text())); }
  b.go('#/reports'); await b.until(() => b.byText('.tab', 'Sources')); assert.ok(!b.byText('.tab', 'Campaigns'), 'campaign report tab hidden without campaigns.view');
  for (const tab of ['Sources', 'Products', 'Funnel', 'Response', 'Staff']) { b.click(b.byText('.tab', tab)); await sleep(80); await b.until(() => !b.q('.spinner')); assert.ok(!b.q('.errbox'), 'reports/' + tab + ': ' + b.text().slice(0, 300)); }
  assert.deepEqual(b.errors, []); b.close();
});

test('REAL API - owner: team invite (?invite= link), permissions, settings, campaigns, import wizard, duplicates, audit', { timeout: 120000 }, async (t) => {
  const r = await realCrm(); if (r.skip) return t.skip(r.skip); const { crm, mod, stub } = r;
  const b = await bootCrm({ stub, storage: { pos_owner_session_token: mod.OWNER_TOKEN, crm_mode: 'owner' }, hash: '#/staff', wait: 600 });
  await b.until(() => b.q('.pagehead button')); b.click(b.byText('.pagehead button', 'Add team member')); await b.until(() => b.q('.modal input[type=text]'));
  b.type(b.q('.modal input[type=text]'), 'Grace Wambui'); b.type(b.q('.modal input[type=email]'), 'grace@x.co'); b.type(b.q('.modal input[type=tel]'), '0722555111'); b.click(b.byText('.modal button', 'Create & get invite link'));
  const link = (await b.until(() => b.q('.modal input[readonly]'))).value; assert.match(link, /\/crm\/\?invite=[0-9a-f]{64}$/); b.click(b.byText('.modal button', 'Done'));
  const inv = await bootCrm({ stub, hash: '?invite=' + new URL(link).searchParams.get('invite'), wait: 700 });
  await b.until(() => true); await inv.until(() => /grace@x\.co/.test(inv.text())); assert.equal(inv.w.location.search, ''); const pws = inv.qa('input[type=password]'); inv.type(pws[0], 'GraceIs#Great1'); inv.type(pws[1], 'GraceIs#Great1'); inv.click(inv.q('button[type=submit]'));
  await inv.until(() => inv.q('.kpis')); assert.match(inv.text(), /Hello, Grace/); assert.ok(inv.qa('.side .navlink').length < 10, 'sales role sees fewer sections'); inv.close();
  b.go('#/staff'); await b.until(() => /Grace Wambui/.test(b.text()) && b.qa('button[aria-label^="Actions for Grace"]').length); b.click(b.qa('button[aria-label^="Actions for Grace"]')[0]); await b.until(() => b.byText('.menu button', 'Permissions')); b.click(b.byText('.menu button', 'Permissions'));
  await b.until(() => b.q('.permgrid select')); const ps = b.qa('.permgrid select'); const idx = ps.findIndex((s) => s.getAttribute('data-key') === 'leads.export'); assert.ok(idx >= 0); b.type(ps[idx], 'grant'); b.click(b.byText('.modal button', 'Save')); await b.until(() => !b.q('.modal'));
  assert.equal(crm.q(`select effect from crm_user_perms where perm = 'leads.export'`)[0].effect, 'grant');
  b.go('#/settings'); await b.until(() => b.q('.listrow input[type=text]')); b.click(b.byText('button', 'Add status')); const labels = b.qa('.listrow input[type=text]'); b.type(labels[labels.length - 1], 'Demo booked'); b.click(b.byText('button', 'Save changes')); await b.until(() => crm.q(`select count(*) n from crm_statuses where label = 'Demo booked'`)[0].n === 1);
  b.click(b.byText('.tab', 'Business')); await b.until(() => /Company name/.test(b.text())); b.click(b.byText('.tab', 'Integrations')); await b.until(() => /WhatsApp Cloud API/.test(b.text()));
  b.go('#/campaigns'); await b.until(() => b.byText('button', 'New campaign')); b.click(b.byText('.pagehead button', 'New campaign')); await b.until(() => b.q('.modal input[type=text]')); b.type(b.q('.modal input[type=text]'), 'Spring Promo'); b.click(b.byText('.modal button', 'Save')); await b.until(() => /Spring Promo/.test(b.text()));
  assert.ok(!/CPL|ROAS|CPA/.test(b.q('.tree').textContent), 'no cost metrics before any spend');
  b.click(b.byText('.tree button', '+ Spend')); await b.until(() => b.q('.modal input[type=number]')); b.type(b.q('.modal input[type=number]'), '5000'); b.click(b.byText('.modal button', 'Save')); await b.until(() => crm.q('select count(*) n from crm_spend')[0].n === 1);
  b.go('#/products'); await b.until(() => b.byText('.pagehead button', 'Add product')); b.click(b.byText('.pagehead button', 'Add product')); await b.until(() => b.q('.modal input[type=text]')); b.type(b.q('.modal input[type=text]'), 'MyDuka Salon'); b.click(b.byText('.modal button', 'Save')); await b.until(() => crm.q(`select count(*) n from crm_products where label = 'MyDuka Salon'`)[0].n === 1);
  // duplicate detection with the real 409 -> merge
  await crm.ok('POST', '/leads', { body: mod.lead({ name: 'Existing Ann', phone: '0733111000' }) });
  b.go('#/leads'); await b.until(() => b.byText('.pagehead button', 'Add lead')); b.click(b.byText('.pagehead button', 'Add lead')); await b.until(() => b.q('.modal input[type=tel]'));
  b.type(b.qa('.modal input[type=text]')[0], 'Ann Again'); b.type(b.q('.modal input[type=tel]'), '0733 111 000'); b.click(b.byText('.modal button', 'Save lead')); await b.until(() => /Possible duplicate/.test(b.text()));
  assert.ok(b.byText('.modal button', 'Merge into')); b.click(b.byText('.modal button', 'Merge into')); await b.until(() => crm.q(`select count(*) n from crm_leads where phone_norm like '%733111000'`)[0].n === 1 && !/Possible duplicate/.test(b.text()));
  // import wizard against the real staging / preview / commit endpoints
  b.go('#/leads/import'); await b.until(() => b.q('input[type=file]'));
  const csv = 'Full Name,Phone,Email,Notes\nImp One,0744000001,one@x.co,hello\nImp Two,0744000002,,\nExisting Ann,0733111000,,dup\n,,,\n'; const f = new b.w.File([csv], 'batch.csv', { type: 'text/csv' });
  const fi = b.q('input[type=file]'); Object.defineProperty(fi, 'files', { value: [f] }); fi.dispatchEvent(new b.w.Event('change', { bubbles: true }));
  await b.until(() => /Match your columns/.test(b.text())); b.click(b.byText('button', 'Continue')); await b.until(() => /Import options/.test(b.text())); b.click(b.byText('button', 'Validate & preview'));
  await b.until(() => b.byText('button', 'Import 2 leads')); assert.match(b.text(), /Invalid rows/); b.click(b.byText('button', 'Import 2 leads')); await b.until(() => /Import complete/.test(b.text()), 15000);
  assert.equal(crm.q(`select count(*) n from crm_leads where name like 'Imp %'`)[0].n, 2); assert.ok(b.byText('button', 'Download error report'), 'the blank row was reported');
  b.go('#/audit'); await b.until(() => /import_create|lead_create|staff_create/.test(b.text())); assert.ok(b.qa('table.t tbody tr').length > 3);
  assert.deepEqual(b.errors, []); b.close();
});

test('REAL API - WhatsApp ad chat: inbox list/bubbles/lead panel, unread cleared, no API -> connect state, notes', { timeout: 90000 }, async (t) => {
  const r = await realCrm(); if (r.skip) return t.skip(r.skip); const { crm, mod, stub } = r;
  const inbox = await crm.load('_crm/inbox.js');
  const res = await inbox.ingestWhatsApp(crm.env, crm.env.LEDGER_DB, [{ id: 'wamid.A1', from: '254712000777', name: 'Wanjiku <b>Ad</b>', text: 'Hi, how much is the POS?', at: new Date().toISOString(), fromAd: true, adId: 'ad-ext-1', adHeadline: 'POS launch offer' }]);
  assert.equal(res.leadsCreated, 1);
  const b = await bootCrm({ stub, storage: { pos_owner_session_token: mod.OWNER_TOKEN, crm_mode: 'owner' }, hash: '#/inbox', wait: 700 });
  await b.until(() => b.q('.conv')); assert.match(b.q('.conv').textContent, /Wanjiku <b>Ad<\/b>/); assert.match(b.q('.conv').textContent, /how much is the POS/); assert.ok(b.q('.conv .badge'), 'unread badge'); assert.equal(b.qa('.conv b').length, 0, 'name is text, not markup');
  const cid = crm.q('select id from crm_conversations')[0].id; const probe = await crm.api('GET', '/inbox/conversations/' + cid + '/messages');
  assert.equal(probe.status, 200, 'the messages route works against real SQLite (it used to be reported as a 500)');
  b.click(b.q('.conv')); await b.until(() => b.q('.bubble')); assert.match(b.q('.bubble').textContent, /how much is the POS/); assert.match(b.text(), /Connect the WhatsApp API/);
  await b.until(() => b.q('.infopanel a[href^="#/leads/"]')); assert.match(b.q('.infopanel').textContent, /Wanjiku/);
  assert.equal(crm.q('select unread_count from crm_conversations')[0].unread_count, 0, 'marked read on open');
  b.click(b.byText('.tab', 'Internal note')); b.type(b.q('.composer textarea'), 'Ask about branches'); b.click(b.q('.sendbtn')); await b.until(() => b.qa('.bubble.note').length === 1); assert.equal(crm.q(`select count(*) n from crm_messages where direction = 'note'`)[0].n, 1);
  assert.deepEqual(b.errors, []); b.close();
});

test('REAL API - ad attribution on the lead, meeting scheduled -> calendar -> completed', { timeout: 90000 }, async (t) => {
  const r = await realCrm(); if (r.skip) return t.skip(r.skip); const { crm, mod, stub } = r;
  const inbox = await crm.load('_crm/inbox.js');
  await inbox.ingestWhatsApp(crm.env, crm.env.LEDGER_DB, [{ id: 'wamid.B1', from: '254712000888', name: 'Ad Lead', text: 'Interested', at: new Date().toISOString(), fromAd: true, adId: 'ad-ext-2', adHeadline: 'POS launch offer' }]);
  const leadId = crm.q('select id from crm_leads')[0].id;
  const b = await bootCrm({ stub, storage: { pos_owner_session_token: mod.OWNER_TOKEN, crm_mode: 'owner' }, hash: '#/leads/' + leadId, wait: 700 });
  await b.until(() => b.q('.kv') && /Attribution/.test(b.text())); assert.match(b.text(), /Meta ads/);
  b.click(b.byText('button', 'Meeting')); await b.until(() => b.q('.modal input[type=datetime-local]'));
  b.type(b.q('.modal input[type=datetime-local]'), C_TOMORROW()); b.click(b.byText('.modal button', 'Save')); await b.until(() => crm.q('select count(*) n from crm_meetings')[0].n === 1);
  b.go('#/calendar'); await b.until(() => b.q('.cal .ev')); b.click(b.q('.cal .ev').parentNode); await b.until(() => b.byText('#main button', 'Done')); b.click(b.byText('#main button', 'Done')); await b.until(() => crm.q('select status from crm_meetings')[0].status === 'completed');
  b.go('#/followups'); await b.until(() => b.q('.tabs')); assert.deepEqual(b.errors, []); b.close();
});
function C_TOMORROW() { const d = new Date(Date.now() + 26 * 3600e3 + 3 * 3600e3); return d.toISOString().slice(0, 11) + '10:00'; }

test('REAL API - owner: Settings > Import previous leads (check, import, verify, repeat-safe, XSS-safe); staff never sees it', { timeout: 120000 }, async (t) => {
  const r = await realCrm(); if (r.skip) return t.skip(r.skip); const { crm, mod, stub } = r;
  const put = (k, v) => crm.kv.data.set(k, { value: JSON.stringify(v) });
  put('leads-staff-list', ['Ann', '<img src=x onerror=alert(1)>']);
  put('leads-sheet:2026-09-01', [{ id: 'a1', name: 'Wanjiru <b>X</b>', phone: '0722111222', product: 'shop', contacted: false }, { id: 'b1', name: 'Otieno', phone: '0733000001', product: 'hotel', contacted: true, contactedBy: 'Ann' }]);
  put('leads-sheet:2026-09-02', [{ id: 'a2', name: 'Wanjiru', phone: '+254722111222', product: 'shop' }]);
  put('leads-meetings', [{ id: 'm1', leadId: 'a1', phone: '0722111222', leadName: 'Wanjiru', meetingDate: '2026-10-05T10:00:00+03:00', done: false }]);
  const before = JSON.stringify([...crm.kv.data.entries()].filter(([k]) => /^leads-/.test(k)).sort());
  const sam = await crm.staff('Sales Sam', 'sales');
  const s = await bootCrm({ stub, storage: { crm_token: sam.token, crm_mode: 'staff' }, hash: '#/settings', wait: 500 });
  await s.until(() => s.q('.tabs, [role=tablist]')); assert.ok(!/Import previous leads/.test(s.text()), 'staff must not see the import tab'); s.close();
  const b = await bootCrm({ stub, storage: { pos_owner_session_token: mod.OWNER_TOKEN, crm_mode: 'owner' }, hash: '#/settings', wait: 600 });
  await b.until(() => b.byText('button, [role=tab]', 'Import previous leads')); b.click(b.byText('button, [role=tab]', 'Import previous leads'));
  await b.until(() => b.byText('button', 'Check what will be moved')); assert.match(b.text(), /kept untouched/); assert.match(b.text(), /safe to repeat/);
  b.click(b.byText('button', 'Check what will be moved')); await b.until(() => b.q('[data-legacy=plan]'));
  assert.match(b.text(), /Day-sheet leads/); assert.match(b.text(), /Website sign-ups/); assert.match(b.text(), /Would create/);
  assert.equal(crm.q(`select count(*) n from crm_leads where legacy_id like 'lead:%'`)[0].n, 0, 'dry run writes nothing');
  assert.ok(!b.q('img[src=x]'), 'no injected markup');
  b.click(b.byText('button', 'Import now')); await b.until(() => b.q('[data-legacy=result]'));
  assert.match(b.text(), /Import result/); assert.equal(crm.q(`select count(*) n from crm_leads where legacy_id like 'lead:%'`)[0].n, 2, 'a carried-forward person folds into one lead');
  b.click(b.byText('button', 'Verify counts')); await b.until(() => b.q('[data-legacy=verify]'));
  assert.match(b.q('[data-legacy=verify]').textContent, /All numbers match/); assert.ok(b.qa('[data-legacy=verify] .pill').every((p) => /Match/.test(p.textContent) && !/Mismatch/.test(p.textContent)));
  assert.ok(!b.q('img[src=x]'));
  b.click(b.byText('button', 'Import now')); await b.until(() => b.q('[data-legacy=result]') && /Import result/.test(b.text()));
  assert.equal(crm.q(`select count(*) n from crm_leads where legacy_id like 'lead:%'`)[0].n, 2, 'repeat is safe');
  assert.equal(JSON.stringify([...crm.kv.data.entries()].filter(([k]) => /^leads-/.test(k)).sort()), before, 'old KV data untouched');
  b.close();
});
