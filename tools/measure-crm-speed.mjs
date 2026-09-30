// zip 161: measures every CRM endpoint on a realistic dataset (5,000 leads, 20,000 activities, 3,000 conversations / 30,000 messages, 300 follow-ups, 50
// meetings, 10 staff, 8 campaigns) against the SQLite-backed D1 fake. Prints D1 round trips, statements, sandbox milliseconds and response bytes.
//   node tools/measure-crm-speed.mjs [--root <dir>] [--json <file>] [--runs 3] [--as owner|sales|manager]
// --root points at another copy of the project (used to measure the "before" code). The numbers are OPERATION COUNTS and milliseconds inside this sandbox
// (node:sqlite in memory): they show how much work a request asks of D1, not what Cloudflare's network and D1 primary will add on top.
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.resolve(opt('root', path.join(HERE, '..')));
const RUNS = Number(opt('runs', 3)), AS = opt('as', 'owner'), OUT = opt('json', '');
const { makeD1 } = await import(pathToFileURL(path.join(HERE, '..', 'tests/d1-fake.mjs')).href);
const { makeKV } = await import(pathToFileURL(path.join(HERE, '..', 'tests/kv-fake.mjs')).href);
const { bigDataset, countingDb } = await import(pathToFileURL(path.join(HERE, '..', 'tests/crm-bigdata.mjs')).href);
const router = await import(pathToFileURL(path.join(ROOT, 'functions/api/_crm/router.js')).href);

const kv = makeKV(); kv.data.set('owner-session:owner-tok', { value: '1' });
kv.data.set('owner-account:v1', { value: JSON.stringify({ identifier: 'owner@myduka.test', salt: 'ab'.repeat(8), passwordHash: 'cd'.repeat(32), ownerClientId: 'OWNERCLIENT', createdAt: 1 }) });
let kvReads = 0; const kvGet = kv.get.bind(kv); kv.get = (...a) => { kvReads++; return kvGet(...a); };
const raw = makeD1(); const db = countingDb(raw);
const env = { LEDGER_DB: db, mydukapos_kv: kv, CRM_SESSION_SECRET: 'measure-secret', ROOT_DOMAIN: 'mydukapos.store' };
const api = async (method, p, o = {}) => {
  const headers = { Authorization: 'Bearer ' + (o.token || 'owner-tok') };
  let body; if (o.body !== undefined) { body = JSON.stringify(o.body); headers['content-type'] = 'application/json'; }
  const res = await router.handle({ request: new Request('https://mydukapos.store/api/crm' + p, { method, headers, body }), env });
  const t = await res.text(); return { status: res.status, text: t, headers: res.headers, bytes: Buffer.byteLength(t) };
};
const crmShim = { db: raw, env, q: (s, ...a) => raw.query(s, ...a) };
await api('GET', '/me');
const tokens = {};
for (let i = 0; i < 10; i++) {                                    // 1 manager + 9 sales, created through the API so the users are real
  const role = i === 0 ? 'manager' : 'sales';
  const r = JSON.parse((await api('POST', '/staff', { body: { name: (role === 'manager' ? 'Manager ' : 'Sales ') + i, email: `s${i}@x.test`, phone: '0711' + String(100000 + i), role } })).text);
  const tok = new URL(r.inviteLink).searchParams.get('invite');
  const acc = JSON.parse((await api('POST', '/auth/invite/accept', { body: { token: tok, password: 'Passw0rd-' + i } })).text);
  if (i === 0) tokens.manager = acc.token; if (i === 1) tokens.sales = acc.token;
}
const ds = bigDataset(crmShim);
const token = AS === 'owner' ? undefined : tokens[AS];
const sample = { lead: ds.leadIds[42], conv: ds.convIds[5], lead2: ds.leadIds[4100] };
const someStaff = raw.query(`SELECT id FROM crm_users WHERE role='sales' LIMIT 1`)[0].id;
const nowD = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
const E = [
  ['boot', 'GET /me', 'GET', '/me'], ['boot', 'GET /staff', 'GET', '/staff'], ['boot', 'GET /notifications (poll)', 'GET', '/notifications'], ['boot', 'GET /inbox/conversations?unread=1 (poll)', 'GET', '/inbox/conversations?unread=1'],
  ['dashboard', 'GET /dashboard today', 'GET', '/dashboard?range=today'], ['dashboard', 'GET /dashboard month', 'GET', '/dashboard?range=month'],
  ['leads', 'GET /leads (default)', 'GET', '/leads?sort=created_at&dir=desc&page=1&pageSize=50'], ['leads', 'GET /leads page 60', 'GET', '/leads?page=60&pageSize=50'],
  ['leads', 'GET /leads sort=name', 'GET', '/leads?sort=name&dir=asc&pageSize=50'], ['leads', 'GET /leads sort=staff', 'GET', '/leads?sort=staff&dir=asc&pageSize=50'],
  ['leads', 'GET /leads sort=next_followup', 'GET', '/leads?sort=next_followup&dir=asc&pageSize=50'], ['leads', 'GET /leads sort=revenue', 'GET', '/leads?sort=revenue&dir=desc&pageSize=50'],
  ['leads', 'GET /leads?q=name', 'GET', '/leads?q=wanjiru&pageSize=50'], ['leads', 'GET /leads?q=phone digits', 'GET', '/leads?q=0712345&pageSize=50'], ['leads', 'GET /leads?q=email', 'GET', '/leads?q=example.co.ke&pageSize=50'],
  ['leads', 'GET /leads?status=new', 'GET', '/leads?status=new&pageSize=50'], ['leads', 'GET /leads?staff=me', 'GET', '/leads?staff=me&pageSize=50'], ['leads', 'GET /leads?pool=1', 'GET', '/leads?pool=1&pageSize=50'],
  ['leads', 'GET /leads?follow=overdue', 'GET', '/leads?follow=overdue&pageSize=50'], ['leads', 'GET /leads?follow=none', 'GET', '/leads?follow=none&pageSize=50'], ['leads', 'GET /leads?campaign=', 'GET', '/leads?campaign=camp1&pageSize=50'],
  ['leads', 'GET /leads/:id (detail)', 'GET', '/leads/' + sample.lead], ['leads', 'GET /leads/export.csv', 'GET', '/leads/export.csv'],
  ['leads', 'POST /leads/:id/note', 'POST', '/leads/' + sample.lead2 + '/note', { text: 'measured note' }], ['leads', 'POST /leads/:id/status', 'POST', '/leads/' + sample.lead2 + '/status', { status: 'contacted' }],
  ['inbox', 'GET /inbox/status', 'GET', '/inbox/status'], ['inbox', 'GET /inbox/conversations', 'GET', '/inbox/conversations'], ['inbox', 'GET /inbox/conversations?q=', 'GET', '/inbox/conversations?q=wanjiru'], ['inbox', 'GET /inbox/conversations/:id/messages', 'GET', '/inbox/conversations/' + sample.conv + '/messages'],
  ['inbox', 'POST /inbox/conversations/:id/read', 'POST', '/inbox/conversations/' + sample.conv + '/read', {}],
  ['followups', 'GET /followups today', 'GET', '/followups?bucket=today'], ['followups', 'GET /followups overdue', 'GET', '/followups?bucket=overdue'], ['followups', 'GET /meetings (month)', 'GET', `/meetings?from=${nowD.slice(0, 8)}01&to=${nowD}`],
  ['config', 'GET /config', 'GET', '/config'], ['config', 'GET /products', 'GET', '/products'], ['config', 'GET /campaigns', 'GET', '/campaigns'], ['config', 'GET /settings', 'GET', '/settings'],
  ['reports', 'GET /sales', 'GET', '/sales'], ['reports', 'GET /reports/staff', 'GET', '/reports/staff?from=' + nowD.slice(0, 8) + '01&to=' + nowD], ['reports', 'GET /reports/sources', 'GET', '/reports/sources'], ['reports', 'GET /reports/campaigns', 'GET', '/reports/campaigns'],
  ['reports', 'GET /reports/products', 'GET', '/reports/products'], ['reports', 'GET /reports/funnel', 'GET', '/reports/funnel'], ['reports', 'GET /reports/response', 'GET', '/reports/response'],
  ['admin', 'GET /staff/:id', 'GET', '/staff/' + someStaff], ['admin', 'GET /audit', 'GET', '/audit'], ['admin', 'GET /automation', 'GET', '/automation'],
];
const rows = [];
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
for (const [group, label, method, p, body] of E) {
  const opts = { token, body };
  let r = await api(method, p, opts);                                   // warm-up: module caches, once-a-minute throttles
  if (r.status >= 400 && !(method === 'GET' && r.status === 403)) { rows.push({ group, label, status: r.status }); continue; }
  const ms = []; let trips, stmts, dbms, bytes, kvr, st;
  for (let i = 0; i < RUNS; i++) {
    db.reset(); kvReads = 0; const t0 = performance.now();
    r = await api(method, p, opts); ms.push(performance.now() - t0);
    trips = db.stats.trips; stmts = db.stats.stmts; dbms = db.stats.ms; bytes = r.bytes; kvr = kvReads; st = r.status;
  }
  rows.push({ group, label, status: st, trips, stmts, kv: kvr, ms: +med(ms).toFixed(1), dbms: +dbms.toFixed(1), bytes, timing: r.headers.get('server-timing') || '' });
}
const line = (r) => r.trips == null ? `${r.label.padEnd(44)} status ${r.status}` : `${r.label.padEnd(44)} ${String(r.trips).padStart(4)} trips ${String(r.stmts).padStart(4)} stmts ${String(r.kv).padStart(2)} kv ${String(r.ms).padStart(8)} ms ${String(r.bytes).padStart(8)} B  ${r.status}`;
console.log(`# root ${ROOT}\n# as ${AS}, dataset ${JSON.stringify(ds.N)} (seed ${ds.ms} ms), median of ${RUNS} warm runs; sandbox ms, not Cloudflare latency\n`);
for (const r of rows) console.log(line(r));
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ root: ROOT, as: AS, rows }, null, 1));
