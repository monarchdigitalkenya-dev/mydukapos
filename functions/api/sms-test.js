// functions/api/sms-test.js — Cloudflare Pages Function (zip 327)
// Onfon Media "Send test SMS" and "Check balance" for the calling shop, using ONLY the credentials already saved (and sealed) for that shop - the browser never
// sends a secret here and never receives one. Admin / manager only (the same rule as changing the SMS account), rate-limited, and every attempt is written to a small
// per-shop log (no secrets, no message text, the number masked). Nothing is sent when settings are saved: a test is always a deliberate click.
import { requireValidLicense } from './_license.js';
import { deviceGuard } from './_device-auth.js';
import { corsHeadersFor } from './_cors.js';
import { readSmsConfigFull } from './_sms-store.js';
import { managerGuard, secLimit, secNum } from './_sec-guard.js';
import { sendViaOnfon, onfonBalance, onfonConfigured, onfonEnabled, onfonNumber, redact } from './_onfon.js';

const CORS_OPTS = { methods: 'GET, POST, OPTIONS', headers: 'Content-Type, X-Device-Id, X-Device-Token, X-Staff-Token, X-Pay-Proof' };
const json = (body, status, cors) => new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json', ...(cors || {}) } });
const mask = (n) => (n ? String(n).slice(0, 5) + '****' + String(n).slice(-2) : '');
const LOG = (c) => 'sms-log:' + c;

async function note(env, clientId, entry) {
  try {
    const raw = await env.mydukapos_kv.get(LOG(clientId));
    const list = raw ? JSON.parse(raw) : [];
    list.unshift({ at: Date.now(), ...entry });
    await env.mydukapos_kv.put(LOG(clientId), JSON.stringify(list.slice(0, 20)));
    return list.slice(0, 5);
  } catch (e) { return []; }
}

async function gate(context, what) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env, CORS_OPTS);
  const license = await requireValidLicense(request, env);
  if (!license.valid) return { denied: json({ error: 'This link is not active.', reason: license.reason }, 403, cors) };
  const clientId = license.clientId;
  const dd = await deviceGuard(request, env, clientId, cors); if (dd) return { denied: dd };
  const md = await managerGuard(request, env, clientId, cors); if (md) return { denied: md };
  const capped = await secLimit(env, 'smstest', clientId, secNum(env.SMS_TEST_HOURLY_LIMIT, 10), 3600, what, cors); if (capped) return { denied: capped };
  const full = await readSmsConfigFull(env, clientId);
  if (!full.ok) return { denied: json({ error: 'The saved SMS account cannot be read right now — contact support.', code: 'secrets_unreadable' }, 503, cors) };
  const c = full.config;
  if (c.provider !== 'onfon') return { denied: json({ error: 'Onfon Media is not the selected SMS provider. Choose it and save first.' }, 400, cors) };
  if (!onfonConfigured(c)) return { denied: json({ error: 'Save the Onfon Access Key, API Key, Client ID and Sender ID first.' }, 400, cors) };
  return { clientId, config: c, cors };
}

export async function onRequestOptions(context) { return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env, CORS_OPTS) }); }

// GET /api/sms-test?action=balance
export async function onRequestGet(context) {
  const g = await gate(context, 'Onfon balance checks');
  if (g.denied) return g.denied;
  const r = await onfonBalance(g.config, { fetch: context.fetchImpl });
  const recent = await note(context.env, g.clientId, { kind: 'balance', provider: 'onfon', ok: !!r.ok, ...(r.error ? { error: redact(r.error, g.config).slice(0, 160) } : { balance: r.balance }) });
  if (!r.ok) return json({ ok: false, error: redact(r.error, g.config), recent }, 502, g.cors);
  return json({ ok: true, balance: r.balance, currency: r.currency || null, unit: r.unit, recent }, 200, g.cors);
}

// POST /api/sms-test   { to: "07..." }  - sends ONE short test message
export async function onRequestPost(context) {
  const g = await gate(context, 'Onfon test messages');
  if (g.denied) return g.denied;
  let body; try { body = await context.request.json(); } catch (e) { return json({ error: 'Invalid request body.' }, 400, g.cors); }
  if (!onfonEnabled(g.config)) return json({ error: 'Onfon Media is turned off in Settings. Turn it on to send a test.' }, 400, g.cors);
  const to = onfonNumber(body && body.to);
  if (!to) return json({ error: 'Enter a valid phone number for the test (for example 0712 345 678).' }, 400, g.cors);
  const text = 'MyDuka POS test message. Your Onfon SMS settings work.';
  // a double tap sends once: the same number within 30 seconds is refused
  const key = 'sms-testlock:' + g.clientId + ':' + to;
  try { if (await context.env.mydukapos_kv.get(key)) return json({ ok: false, error: 'A test was just sent to this number. Wait a few seconds before sending another.' }, 429, g.cors); await context.env.mydukapos_kv.put(key, '1', { expirationTtl: 60 }); } catch (e) { /* the hourly limit still applies */ }
  const r = await sendViaOnfon(g.config, [to], text, { fetch: context.fetchImpl });
  const recent = await note(context.env, g.clientId, { kind: 'test', provider: 'onfon', ok: !!r.success, to: mask(to), ...(r.success ? { messageId: r.recipients && r.recipients[0] && r.recipients[0].messageId } : { error: redact(r.error || (r.recipients && r.recipients[0] && r.recipients[0].status) || 'failed', g.config).slice(0, 160) }) });
  if (!r.success) return json({ ok: false, error: redact(r.error || (r.recipients && r.recipients[0] && r.recipients[0].status) || 'Onfon did not accept the test message.', g.config), ...(r.uncertain ? { uncertain: true } : {}), recent }, 502, g.cors);
  const first = (r.recipients && r.recipients[0]) || {};
  return json({ ok: true, messageId: first.messageId || null, to: mask(to), note: 'Onfon accepted the message for sending. That is submission, not proof the phone received it.', recent }, 200, g.cors);
}
