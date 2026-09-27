import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boot, ROOT } from './helpers.mjs';

// Zip 127: "I'm signed in as the owner, but the Owner Console says 'Sign in as the owner to see this'".
// Causes found: (1) an owner session existed only as a KV record, and KV takes up to a minute to reach other Cloudflare locations
// (and caches "not found"), so requests right after signing in were refused; (2) a network hiccup at start-up DELETED the saved
// session; (3) opening a staff link deleted it too, and the console then opened quietly as staff.
const mod = (f) => import(pathToFileURL(path.join(ROOT, 'functions/api', f)).href);
function kvStore() {
  const store = new Map();
  return { store, kv: { async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } } };
}

test('TEST 10 (server): a signed-in owner is recognised at once — even where the session record has not arrived yet', async () => {
  const { store, kv } = kvStore();
  const env = { mydukapos_kv: kv };
  const auth = await mod('owner-auth.js');
  const log = await mod('client-log.js');
  const post = (body, token) => auth.onRequestPost({ request: new Request('https://x.pages.dev/api/owner-auth', { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: JSON.stringify(body) }), env });
  const errors = (token) => log.onRequestGet({ request: new Request('https://x.pages.dev/api/client-log', { headers: token ? { Authorization: 'Bearer ' + token } : {} }), env });
  const signup = await (await post({ action: 'signup', identifier: 'me@shop.ke', password: 'secret123' })).json();
  assert.match(signup.token, /^o2\./);
  const login = await (await post({ action: 'login', identifier: 'me@shop.ke', password: 'secret123' })).json();
  const rand = login.token.split('.')[1];
  store.delete('owner-session:' + rand);                      // this server location has not received the session record yet
  assert.equal((await errors(login.token)).status, 200, 'recognised anyway');
  const me = await (await auth.onRequestGet({ request: new Request('https://x.pages.dev/api/owner-auth', { headers: { Authorization: 'Bearer ' + login.token } }), env })).json();
  assert.equal(me.authenticated, true);
  // TEST 11 (server): not the owner -> still refused
  assert.equal((await errors()).status, 401, 'no token');
  assert.equal((await errors('o2.' + rand + '.abc.' + '0'.repeat(64))).status, 401, 'a forged signature');
  assert.equal((await errors('random-guess')).status, 401, 'a guessed token');
  // signing out ends it everywhere (revocation), older plain sessions still work
  await post({ action: 'logout' }, login.token);
  assert.equal((await errors(login.token)).status, 401, 'signed out');
  store.set('owner-session:legacytok', '1');
  assert.equal((await errors('legacytok')).status, 200, 'a session from before this release still works');
  assert.equal((await errors(signup.token)).status, 200, 'another device\'s session is unaffected');
});

function ownerFetch(handlers) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, auth: new Headers(opts.headers || {}).get('Authorization') });
    for (const [re, h] of handlers) if (re.test(u)) return h(u, opts, calls);
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

test('TEST 10 (console): an owner whose request is refused by a lagging server is checked, not told to sign in', async () => {
  let logCalls = 0;
  const fetch = ownerFetch([
    [/\/api\/owner-auth/, () => json({ hasAccount: true, authenticated: true, ownerClientId: 'OWN1' })],
    [/\/api\/client-log/, () => (++logCalls === 1 ? json({ error: 'Unauthorized' }, 401) : json({ errors: [{ app: 'hotel', kind: 'error', message: 'boom', count: 2, shopCount: 1, last: Date.now() }] }))],
  ]);
  const t = await boot('owner/index.html', { storage: { pos_owner_session_token: 'o2.tok', pos_owner_client_id: 'OWN1' }, fetch, wait: 1200 });
  t.w.__ownerVerifyWaitMs = 5;
  await t.w.eval('loadClientErrors()');
  const list = t.d.getElementById('errors-list').textContent;
  assert.doesNotMatch(list, /Sign in as the owner/);
  assert.match(list, /boom/, 'the owner sees the errors');
  assert.equal(t.w.localStorage.getItem('pos_owner_session_token'), 'o2.tok');
  t.close();
});

test('TEST 10 (console): no connection at start-up does NOT sign the owner out', async () => {
  const fetch = ownerFetch([[/\/api\/owner-auth/, () => { throw new Error('offline'); }]]);
  const t = await boot('owner/index.html', { storage: { pos_owner_session_token: 'o2.tok', pos_owner_client_id: 'OWN1' }, fetch, wait: 6000 });
  assert.equal(t.w.localStorage.getItem('pos_owner_session_token'), 'o2.tok', 'the session is kept');
  assert.equal(t.w.eval('ownerSignedIn'), true);
  assert.notEqual(t.d.getElementById('owner-auth-screen').style.display, 'flex', 'no sign-in form over the console');
  t.close();
});

test('TEST 11 (console): a staff page never sends the owner session, and says "owner only" — without deleting the owner\'s session', async () => {
  const fetch = ownerFetch([
    [/\/api\/owner-auth/, () => json({ hasAccount: true, authenticated: true, ownerClientId: 'OWN1' })],
    [/\/api\/client-log/, (u, o) => (new Headers(o.headers || {}).get('Authorization') ? json({ errors: [] }) : json({ error: 'Unauthorized' }, 401))],
  ]);
  const t = await boot('owner/index.html', { url: 'https://demo.mydukapos.store/owner/?staff=abc&c=OWN1', storage: { pos_owner_session_token: 'o2.tok', pos_owner_client_id: 'OWN1' }, fetch, wait: 1200 });
  assert.deepEqual(JSON.parse(t.w.eval('JSON.stringify(ownerAuthHeaders())')), {}, 'staff page: no owner token on requests');
  await t.w.eval('loadClientErrors()');
  assert.match(t.d.getElementById('errors-list').textContent, /Owner only/);
  assert.equal(t.w.localStorage.getItem('pos_owner_session_token'), 'o2.tok', "the owner's own session on this device is kept");
  t.close();
});

test('an owner session that really ended shows the sign-in form (not a dead message)', async () => {
  let n = 0;
  const fetch = ownerFetch([
    [/\/api\/owner-auth/, () => json({ hasAccount: true, authenticated: ++n <= 1 })],     // valid at start-up, then signed out elsewhere
    [/\/api\/client-log/, () => json({ error: 'Unauthorized' }, 401)],
  ]);
  const t = await boot('owner/index.html', { storage: { pos_owner_session_token: 'o2.tok', pos_owner_client_id: 'OWN1' }, fetch, wait: 1200 });
  t.w.__ownerVerifyWaitMs = 5;
  await t.w.eval('loadClientErrors()');
  assert.equal(t.d.getElementById('owner-auth-screen').style.display, 'flex');
  assert.match(t.d.getElementById('owner-auth-error').textContent, /session has ended/);
  t.close();
});

test('website / demo account sessions (zip 130): recognised at once even where the session record has not arrived yet; forged ones refused', async () => {
  const { store, kv } = kvStore();
  const env = { mydukapos_kv: kv };
  const acc = await mod('_account.js');
  const salt = 'abc';
  store.set('demo-account:me@shop.ke', JSON.stringify({ email: 'me@shop.ke', salt, passwordHash: await acc.sha256Hex(salt + 'pw123456') }));
  const token = await acc.createSession(env, 'me@shop.ke');
  assert.match(token, /^d2\./);
  store.delete('demo-account-session:' + token.split('.')[2]);            // this location has not received the session record yet
  assert.equal(await acc.emailFromToken(env, token), 'me@shop.ke');
  const p = token.split('.'); p[4] = '0'.repeat(64);
  assert.equal(await acc.emailFromToken(env, p.join('.')), '', 'a forged signature');
  store.set('demo-account-session:oldtok', 'me@shop.ke');
  assert.equal(await acc.emailFromToken(env, 'oldtok'), 'me@shop.ke', 'sessions from before still work');
});
