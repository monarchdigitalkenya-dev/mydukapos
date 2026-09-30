// Shared helpers for the CRM tests: a REAL SQLite-backed D1 (tests/d1-fake.mjs), the fake KV, the real router / public endpoints.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { makeD1 } from './d1-fake.mjs';
import { makeKV } from './kv-fake.mjs';
import { ROOT } from './helpers.mjs';

const load = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
export const OWNER_TOKEN = 'owner-tok';

export function makeEnv(extra = {}) {
  const kv = makeKV();
  kv.data.set('owner-session:' + OWNER_TOKEN, { value: '1' });
  kv.data.set('owner-account:v1', { value: JSON.stringify({ identifier: 'owner@myduka.test', salt: 'ab'.repeat(8), passwordHash: 'cd'.repeat(32), ownerClientId: 'OWNERCLIENT', createdAt: 1 }) });
  return { LEDGER_DB: makeD1(), mydukapos_kv: kv, CRM_SESSION_SECRET: 'test-secret-' + crypto.randomUUID(), ROOT_DOMAIN: 'mydukapos.store', ...extra };
}

export async function makeCrm(extra = {}) {
  const env = makeEnv(extra);
  const router = await load('_crm/router.js');
  const db = env.LEDGER_DB;
  // api(method, path, { token, body, headers, raw }) -> { status, body, res, text }
  const api = async (method, p, o = {}) => {
    const url = 'https://mydukapos.store/api/crm' + p;
    const headers = { ...(o.headers || {}) };
    if (o.token !== null) headers.Authorization = 'Bearer ' + (o.token === undefined ? OWNER_TOKEN : o.token);
    let body;
    if (o.body !== undefined) { body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body); headers['content-type'] = 'application/json'; }
    const res = await router.handle({ request: new Request(url, { method, headers, body }), env });
    const t = await res.text();
    let j = null; try { j = JSON.parse(t); } catch (e) { /* csv */ }
    return { status: res.status, body: j, text: t, res };
  };
  const ok = async (method, p, o) => { const r = await api(method, p, o); if (r.status >= 300) throw new Error(`${method} ${p} -> ${r.status} ${r.text.slice(0, 300)}`); return r.body; };
  let n = 0;
  // creates + activates a staff member, returns { id, token, email, password, user }
  const staff = async (name, role = 'sales', extra2 = {}) => {
    n++;
    const email = `${name.toLowerCase().replace(/\W+/g, '.')}${n}@myduka.test`;
    const r = await ok('POST', '/staff', { body: { name, email, phone: '07' + String(10000000 + n), role, ...extra2 } });
    const tok = new URL(r.inviteLink).searchParams.get('invite');
    const password = 'Passw0rd-' + name;
    const acc = await ok('POST', '/auth/invite/accept', { token: null, body: { token: tok, password } });
    return { id: r.user.id, token: acc.token, email, password, user: acc.user };
  };
  const q = (sql, ...a) => db.query(sql, ...a);
  await api('GET', '/me');                                   // creates the schema + the owner user
  const ownerId = q(`select id from crm_users where owner_ref = 'owner'`)[0].id;
  return { env, db, api, ok, staff, q, kv: env.mydukapos_kv, ownerId, load, router };
}
export const lead = (o = {}) => ({ name: 'Test Lead', phone: '0712345678', ...o });
let ph = 700000000;
export const newPhone = () => '0' + (ph++);
