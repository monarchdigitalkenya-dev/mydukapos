// Measures (does not estimate) what ONE demo visitor costs in KV and D1 operations, before (a private demo shop per visitor) and after (the shared demo).
//   node tools/measure-demo-usage.mjs
// Both flows run the REAL server code (demo-account.js / shared-demos / pos-sync / license-status) over an in-memory KV and a SQLite-backed D1 stand-in,
// and every get/put/delete/list and every D1 statement is counted. A "session" = open the demo, pull the shop once, ring up 20 sales (20 pushes).
import { makeKV, seedShop } from '../tests/kv-fake.mjs';
import { makeD1 } from '../tests/d1-fake.mjs';
import { onRequestPost as accountPost } from '../functions/api/demo-account.js';
import { onRequestPost as syncPost, onRequestGet as syncGet } from '../functions/api/pos-sync.js';
import { onRequestGet as statusGet } from '../functions/api/license-status.js';
import { SHARED_DEMOS, ensureSharedDemo } from '../functions/api/_shared-demos.js';

function counted(kv) { const c = { get: 0, put: 0, del: 0, list: 0 }; const w = { ...kv, data: kv.data };
  w.get = async (k, o) => { c.get++; return kv.get(k, o); }; w.getWithMetadata = async (k, o) => { c.get++; return kv.getWithMetadata(k, o); };
  w.put = async (k, v, o) => { c.put++; return kv.put(k, v, o); }; w.delete = async (k) => { c.del++; return kv.delete(k); }; w.list = async (o) => { c.list++; return kv.list(o); };
  return { kv: w, c, reset() { c.get = c.put = c.del = c.list = 0; } }; }
const sale = (i) => ({ id: 'm' + i, refNumber: 'R-' + i, timestamp: new Date().toISOString(), paid: true, paymentMethod: 'cash', cashAmount: 500, items: [{ code: '00001', name: 'Item', qty: 1, price: 500 }] });
const req = (p, id, method = 'GET', body, ip = '9.9.9.9') => new Request('https://x.pages.dev' + p + (p.includes('?') ? '&' : '?') + 'c=' + id, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip } });
async function d1Stmts(d1) { return d1._state.calls; }

async function oldFlow() {
  const k = counted(makeKV()); const d1 = makeD1(); const env = { mydukapos_kv: k.kv, LEDGER_DB: d1 };
  const r = await accountPost({ request: req('/api/demo-account', 'x', 'POST', { action: 'register', channel: 'app', acceptTerms: true, fullName: 'Visitor One', phone: '0712345678', password: 'Tr1cky-pass', confirmPassword: 'Tr1cky-pass', product: 'shop', businessName: 'Visitor Duka' }), env });
  const j = await r.json(); const id = new URL(j.link).searchParams.get('c');
  const provision = { ...k.c }; k.reset(); const d0 = await d1Stmts(d1);
  await syncGet({ request: req('/api/pos-sync', id), env, waitUntil() {} });
  for (let i = 0; i < 20; i++) await syncPost({ request: req('/api/pos-sync', id, 'POST', { salesLog: [sale(i)], updatedAt: Date.now() + i }), env, waitUntil() {} });
  return { provision, session: { ...k.c }, d1: (await d1Stmts(d1)) - d0 };
}
async function newFlow() {
  const base = makeKV(); const k = counted(base); const d1 = makeD1(); const env = { mydukapos_kv: k.kv, LEDGER_DB: d1 };
  const spec = SHARED_DEMOS.find((d) => d.key === 'retail');
  await ensureSharedDemo(env, spec);                               // the one-off creation / fortnightly refresh (not per visitor)
  const seeding = { ...k.c }; k.reset(); const d0 = await d1Stmts(d1);
  await ensureSharedDemo(env, spec);                               // what a visitor's click costs once the demo exists
  await statusGet({ request: req('/api/license-status', spec.id), env });
  await syncGet({ request: req('/api/pos-sync', spec.id), env, waitUntil() {} });
  for (let i = 0; i < 20; i++) await syncPost({ request: req('/api/pos-sync', spec.id, 'POST', { salesLog: [sale(i)], updatedAt: Date.now() + i }), env, waitUntil() {} });
  return { seeding, session: { ...k.c }, d1: (await d1Stmts(d1)) - d0 };
}
const o = await oldFlow(), n = await newFlow();
const row = (l, c) => `${l.padEnd(34)} reads ${String(c.get).padStart(4)}  writes ${String(c.put).padStart(4)}  deletes ${String(c.del).padStart(3)}  lists ${String(c.list).padStart(3)}`;
console.log('PER VISITOR - before (a private demo shop for every visitor)');
console.log(row('  creating their shop + account', o.provision)); console.log(row('  one session (open, 20 sales)', o.session)); console.log('  D1 statements in that session     ' + o.d1);
console.log('PER VISITOR - after (the shared demo)');
console.log(row('  creating anything', { get: 0, put: 0, del: 0, list: 0 })); console.log(row('  one session (open, 20 sales)', n.session)); console.log('  D1 statements in that session     ' + n.d1);
console.log('ONE-OFF (not per visitor): creating + loading the demo   writes ' + n.seeding.put + ', reads ' + n.seeding.get + '  (repeats at most once a fortnight)');
