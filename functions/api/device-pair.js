// functions/api/device-pair.js — Cloudflare Pages Function: pairing a device with its shop (see _device-auth.js).
//
//   GET  ?c=<link>                         -> { mode, me: { id, paired }, devices: [...] }  (device list: this shop only)
//   POST { action: 'pair', deviceId, name, proof }   proof = SHA-256 of the shop password or the management password (while the shop is
//        'open' a device may also send the sealed hash it keeps — that is how set-up devices pair themselves in the background)
//   POST { action: 'pair', deviceId, name, code }    code  = a 6-digit pairing code made on a paired device (10 minutes, once)
//   POST { action: 'code' }                          (paired device) -> { code, expiresIn }
//   POST { action: 'rename', name }                  (paired device) renames ITSELF
//   POST { action: 'revoke', deviceId, proof }       (paired device + password) unpairs a device
//   POST { action: 'mode', mode: 'open'|'paired', proof }  (paired device + password) — a device can only switch its shop to
//        'paired' if it is paired itself, so nobody can lock themselves out.
// Pairing attempts are rate-limited per shop (PAIR_HOURLY_LIMIT, default 20 an hour). The shop is the one the link names.

import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { readState, shopMode, shopCall, shopDbOutdated } from './_state-store.js';
import { checkRateLimit, rateLimitResponse } from './_ratelimit.js';
import { readDeviceAuth, writeDeviceAuth, checkDevice, sha256hex, randomToken, proofMatches, isSealedProof } from './_device-auth.js';

const CODE_KEY = (clientId, code) => `pair-code:${clientId}:${code}`;
const clean = (s, n = 60) => String(s || '').replace(/[<>]/g, '').trim().slice(0, n);

async function shopSecrets(env, clientId) {
  if ((await shopMode(env, clientId)) === 'do') {
    const res = await shopCall(env, clientId, 'secrets', {});
    return res.ok ? res.json() : {};
  }
  const st = (await readState(env, 'pos-data:state:' + clientId, {})) || {};
  return { pwHash: st.pwHash || '', adminPwHash: st.adminPwHash || '' };
}
// `typed`: the proof must come from the password itself (its SHA-256), not from a hash a device keeps — used whenever the shop is
// "paired only", and for revoke / mode changes. A stolen or revoked device holds only the SEALED hash (zip 121), which cannot be turned
// back into that proof, so it cannot pair itself again.
async function proofOk(env, clientId, proof, { typed = false } = {}) {
  if (!proof || typeof proof !== 'string' || proof.length < 32 || proof.length > 300) return false;
  if (typed && isSealedProof(proof)) return false;
  const s = await shopSecrets(env, clientId);
  return (!!s.pwHash && (await proofMatches(proof, s.pwHash))) || (!!s.adminPwHash && (await proofMatches(proof, s.adminPwHash)));
}
async function registry(env, clientId) {
  try {
    if ((await shopMode(env, clientId)) === 'do') { const res = await shopCall(env, clientId, 'registry', {}); return res.ok ? (await res.json()) || {} : {}; }
    const st = (await readState(env, 'pos-data:state:' + clientId, {})) || {};
    return st.deviceRegistry || {};
  } catch (e) { return {}; }
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ error: 'This link is not active.', reason: license.reason }, 403);
  const clientId = license.clientId;
  const me = await checkDevice(request, env, clientId);
  const rec = await readDeviceAuth(env, clientId, { fresh: true });
  const base = { mode: rec.mode, me: { id: me.deviceId, paired: me.paired } };
  if (rec.mode === 'paired' && !me.paired) return reply(base);            // an unpaired device only learns that it must pair
  const reg = await registry(env, clientId);
  if ((await shopMode(env, clientId)) === 'do' && !Object.keys(reg).length && (await shopDbOutdated(env, clientId))) base.serverWarning = 'db_outdated';
  const ids = new Set([...Object.keys(rec.devices), ...Object.keys(reg)]);
  const devices = [...ids].map((id) => {
    const d = rec.devices[id] || {}, r = reg[id] || {};
    return { id, name: d.name || r.name || '', paired: !!d.h && !d.revoked, revoked: !!d.revoked, pairedAt: d.pairedAt || null, pairedBy: d.pairedBy || '', lastSeen: r.lastSeen || null, version: r.v || '', till: r.till || null, me: id === me.deviceId };
  }).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  return reply({ ...base, devices });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ error: 'This link is not active.', reason: license.reason }, 403);
  const clientId = license.clientId;
  let body;
  try { body = await request.json(); } catch (e) { return reply({ error: 'Invalid JSON body' }, 400); }
  const action = body && body.action;
  const me = await checkDevice(request, env, clientId);
  const rec = await readDeviceAuth(env, clientId, { fresh: true });

  if (action === 'pair') {
    const rl = await checkRateLimit(env, 'pair', clientId, 1);
    if (!rl.ok) return rateLimitResponse('pairing attempts', rl, cors);
    const deviceId = clean(body.deviceId, 80);
    if (!deviceId) return reply({ error: 'Missing device id.' }, 400);
    let by = '';
    if (body.code) {
      const code = String(body.code).replace(/\D/g, '').slice(0, 6);
      const raw = code.length === 6 ? await env.mydukapos_kv.get(CODE_KEY(clientId, code)) : null;
      if (!raw) return reply({ error: 'That pairing code is wrong or has expired. Make a new one on a paired device.', code: 'bad_code' }, 403);
      await env.mydukapos_kv.delete(CODE_KEY(clientId, code));                // one use only
      by = 'pairing code from ' + (JSON.parse(raw).from || 'a paired device');
    } else if (await proofOk(env, clientId, body.proof, { typed: rec.mode === 'paired' })) {
      by = 'shop password';
    } else {
      return reply({ error: 'Wrong password.', code: 'bad_proof' }, 403);
    }
    const token = randomToken();
    const prev = rec.devices[deviceId] || {};
    rec.devices[deviceId] = { h: await sha256hex(token), name: clean(body.name) || prev.name || '', pairedAt: Date.now(), pairedBy: by, revoked: false };
    await writeDeviceAuth(env, clientId, rec);
    return reply({ ok: true, token, mode: rec.mode });
  }

  if (!me.paired) return reply({ error: 'Pair this device first.', code: 'device_not_paired' }, 401);

  if (action === 'code') {
    let code = '';
    for (let i = 0; i < 5 && !code; i++) {
      const c = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
      if (!(await env.mydukapos_kv.get(CODE_KEY(clientId, c)))) code = c;
    }
    const from = (rec.devices[me.deviceId] && rec.devices[me.deviceId].name) || me.deviceId;
    await env.mydukapos_kv.put(CODE_KEY(clientId, code), JSON.stringify({ from, at: Date.now() }), { expirationTtl: 600 });
    return reply({ ok: true, code, expiresIn: 600 });
  }
  if (action === 'rename') {
    rec.devices[me.deviceId] = { ...rec.devices[me.deviceId], name: clean(body.name) };
    await writeDeviceAuth(env, clientId, rec);
    return reply({ ok: true });
  }
  if (action === 'revoke' || action === 'mode') {
    const rl = await checkRateLimit(env, 'pair', clientId, 1);
    if (!rl.ok) return rateLimitResponse('attempts', rl, cors);
    if (!(await proofOk(env, clientId, body.proof, { typed: true }))) return reply({ error: 'Wrong password.', code: 'bad_proof' }, 403);
    if (action === 'revoke') {
      const id = clean(body.deviceId, 80);
      if (!rec.devices[id]) return reply({ error: 'Unknown device.' }, 404);
      if (id === me.deviceId) return reply({ error: 'This is the device you are using — revoke it from another paired device.' }, 400);
      rec.devices[id] = { ...rec.devices[id], revoked: true, revokedAt: Date.now() };
    } else {
      rec.mode = body.mode === 'paired' ? 'paired' : 'open';
    }
    await writeDeviceAuth(env, clientId, rec);
    return reply({ ok: true, mode: rec.mode });
  }
  return reply({ error: 'Unknown action.' }, 400);
}
