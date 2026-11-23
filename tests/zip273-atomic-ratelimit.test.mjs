// zip 273: the abuse-sensitive counters are ATOMIC when the ledger D1 is bound. 40 requests fired at once against a limit of 5 let exactly 5
// through (the old KV read-then-write counter lets a burst through), the login-failure lock uses the same counter, and with no database the
// KV fallback still works (and never locks anyone out when KV itself fails).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeKV } from './kv-fake.mjs';
import { makeD1 } from './d1-fake.mjs';
import { checkRateLimit, loginBlocked, noteLoginFailure } from '../functions/api/_ratelimit.js';
import { secLimit } from '../functions/api/_sec-guard.js';
import { atomicHit } from '../functions/api/_atomic-counter.js';

const env = (o = {}) => ({ mydukapos_kv: makeKV(), LEDGER_DB: makeD1(), STAFF_PIN_HOURLY_LIMIT: '5', ...o });

test('40 parallel PIN attempts, limit 5: exactly 5 pass', async () => {
  const e = env();
  const r = await Promise.all(Array.from({ length: 40 }, () => checkRateLimit(e, 'staffPin', 'shopA:staff1')));
  assert.equal(r.filter((x) => x.ok).length, 5);
  const blocked = r.find((x) => !x.ok); assert.ok(blocked.retryAfter >= 1 && blocked.limit === 5);
  assert.equal((await checkRateLimit(e, 'staffPin', 'shopB:staff1')).ok, true, 'another shop is not affected');
});

test('the table is created on first use, counts are exact, and secLimit shares the atomic counter', async () => {
  const e = env();
  assert.equal(await atomicHit(e, 'k1', 1), 1); assert.equal(await atomicHit(e, 'k1', 2), 3);
  const res = await Promise.all(Array.from({ length: 12 }, () => secLimit(e, 'gwcfg', 'shop1', 4, 3600, 'payment-gateway changes')));
  assert.equal(res.filter((x) => x === null).length, 4);
  const hit = res.find((x) => x); assert.equal(hit.status, 429); assert.ok(Number(hit.headers.get('Retry-After')) >= 1);
});

test('login failures lock after the limit, per account, and a success path (no failure noted) is never slowed', async () => {
  const e = env({ LOGIN_FAILS_PER_ACCOUNT: '3' });
  const req = new Request('https://x.test/api/owner-auth', { headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  assert.equal(await loginBlocked(e, req, 'owner@x.co'), null);
  await Promise.all([1, 2, 3].map(() => noteLoginFailure(e, req, 'owner@x.co')));
  const blocked = await loginBlocked(e, req, 'owner@x.co');
  assert.equal(blocked.status, 429); assert.ok(blocked.headers.get('Retry-After'));
  assert.equal(await loginBlocked(e, req, 'someone-else@x.co'), null);
});

test('no database bound: the KV fallback still limits; a failing KV never blocks', async () => {
  const e = { mydukapos_kv: makeKV(), STAFF_PIN_HOURLY_LIMIT: '2' };
  const seq = []; for (let i = 0; i < 4; i++) seq.push((await checkRateLimit(e, 'staffPin', 's:1')).ok);
  assert.deepEqual(seq, [true, true, false, false]);
  const broken = { mydukapos_kv: { get: async () => { throw new Error('kv down'); }, put: async () => { throw new Error('kv down'); } } };
  assert.equal((await checkRateLimit(broken, 'staffPin', 's:1')).ok, true);
  assert.equal(await loginBlocked(broken, new Request('https://x.test/'), 'a@b.co'), null);
});

test('a D1 outage falls back to KV instead of blocking or crashing', async () => {
  const e = env(); e.LEDGER_DB._state.failNext = 50;
  const r = await checkRateLimit(e, 'staffPin', 's:2');
  assert.equal(r.ok, true);
});

// ---- security events + the webhook brake
import { secEvent, listSecEvents } from '../functions/api/_sec-events.js';
import { checkCallback, ensureCallbackKey } from '../functions/api/_callback-key.js';

test('security events: a flood is one counted row, never holds a secret, newest first, and the owner endpoint needs the owner', async () => {
  const e = env({ STAFF_PIN_HOURLY_LIMIT: '1' });
  await Promise.all(Array.from({ length: 6 }, () => checkRateLimit(e, 'staffPin', 'shopZ:staff9')));      // 1 allowed, 5 blocked -> rate_limited events
  const req = new Request('https://x.test/api/owner-auth', { headers: { 'CF-Connecting-IP': '9.9.9.9' } });
  await noteLoginFailure(e, req, 'secret-account@x.co'); await noteLoginFailure(e, req, 'secret-account@x.co');
  const list = await listSecEvents(e, 50);
  const kinds = list.map((x) => x.kind);
  assert.ok(kinds.includes('rate_limited') && kinds.includes('login_failed'));
  const blob = JSON.stringify(list);
  assert.ok(!blob.includes('secret-account') && !blob.includes('9.9.9.9'), 'no account name and no raw address in the log');
  assert.ok(list.find((x) => x.kind === 'login_failed').count >= 1);
  assert.ok(list[0].t >= list[list.length - 1].t, 'newest first');
  const owner = await import('../functions/api/owner-security.js');
  const denied = await owner.onRequestGet({ request: new Request('https://x.test/api/owner-security'), env: e });
  assert.equal(denied.status, 401);
});

test('a rejected payment callback is logged, and a flood of callbacks for one shop + rail is ignored without touching other shops', async () => {
  const e = env({ WEBHOOK_HOURLY_LIMIT: '3' });
  await ensureCallbackKey(e, 'shopW', 'paywave');                         // the shop has a signed URL, so a wrong key is a real rejection
  const url = 'https://x.test/api/paywave-webhook?c=shopW&k=wrong';
  const out = []; for (let i = 0; i < 6; i++) out.push(await checkCallback(e, 'shopW', 'paywave', url));
  assert.equal(out.filter((x) => x.limited).length, 3, 'beyond the limit the callback is refused as limited');
  assert.ok((await listSecEvents(e, 50)).some((x) => x.kind === 'callback_rejected'));
  const other = await checkCallback(e, 'shopOther', 'paywave', 'https://x.test/api/paywave-webhook?c=shopOther');
  assert.notEqual(other.limited, true);
});
