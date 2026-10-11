// functions/api/daraja-check.js — Cloudflare Pages Function (zip 255)
//
// "Test Daraja connection" (Settings > Payment Gateway, Option B). It changes NOTHING and sends NO money and NO prompt: it walks through the
// steps a Daraja payment needs, one at a time, and says which one stops and why, using Safaricom's own words.
//
//   1. the saved details (and whether new keys are still waiting out the change hold)
//   2. do the environment, the shortcode and the Till number make sense together
//   3. log in to Safaricom with the Consumer Key + Secret
//   4. are the shortcode + passkey accepted (a harmless "status of prompt" question about an invented prompt number)
//   5. the address Safaricom is told to send results to (words Safaricom's production system refuses; where it points; does it answer)
//   6. the shop's recent prompts (prompts that were sent but never got a result = results are not arriving)
//
// Same people as "Save Daraja credentials": the Admin / a manager. The answer never contains a key, a secret or a passkey.

import { loadGatewayConfig, getPendingChange } from './_gateway-config.js';
import { requireValidLicense } from './_license.js';
import { deviceGuard } from './_device-auth.js';
import { corsHeadersFor } from './_cors.js';
import { managerGuard, secLimit, secNum } from './_sec-guard.js';
import { ensureCallbackKey, withKey, callbackOrigin } from './_callback-key.js';

const FORBIDDEN_IN_CALLBACK = /(m-?pesa|safaricom|exe|exec|cmd|sql|query)/i;     // the words Safaricom's production system refuses in a callback address

const json = (body, status = 200, cors = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });

function baseUrl(cfg) { return String(cfg.mpesaEnv || 'sandbox').toLowerCase() === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke'; }

// Nairobi time, as the STK password needs (same as mpesa-stkpush.js)
function timestamp(now = Date.now()) {
  const d = new Date(now + 3 * 3600 * 1000), p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

async function timedFetch(url, init, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { ok: true, status: res.status, text, data, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? `no answer within ${Math.round(ms / 1000)} seconds` : String((e && e.message) || e), ms: Date.now() - t0 };
  } finally { clearTimeout(t); }
}

const clip = (s, n = 220) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const step = (id, title, status, detail, fix) => ({ id, title, status, detail: detail || '', fix: fix || '' });

/* exported for tests: Safaricom's words for a failed payment -> what it means for the settings */
export function explainFailure(desc) {
  const t = String(desc || '');
  if (/agent number and store number|store number/i.test(t)) return 'The Store / Head Office number (Shortcode box) and the Till number (Till box) do not belong together. For a Till: Shortcode = the Store number, Till box = the Till under that store. If the number is a Paybill, set Type to Paybill instead.';
  if (/merchant does not exist/i.test(t)) return 'Safaricom does not know the number it was sent as the receiver for this Type. Usual causes: Type is Paybill but the number is a Till/Store, or Type is Till and the Till box holds a number that is not a Till.';
  if (/unresolved reason/i.test(t)) return 'Safaricom gave no reason. It is a generic refusal, often the Type / shortcode / Till combination again, or the shortcode is not yet switched on for STK push.';
  if (/cancel|1032/i.test(t)) return 'The customer cancelled the prompt on their phone.';
  if (/insufficient|balance|2001|wrong pin|initiator/i.test(t)) return 'A customer-side problem (balance or wrong PIN), not a setting.';
  if (/timeout|timed out|1037/i.test(t)) return 'The customer did not respond to the prompt in time.';
  return '';
}

/* exported for tests: what Safaricom's answer to the login means */
export function explainToken(r, env) {
  if (!r.ok) return step('login', 'Log in to Safaricom', 'fail', `The server could not reach Safaricom: ${r.error}.`, 'Safaricom may be down for a moment — try again in a few minutes. If it keeps happening, ask Safaricom (apisupport@safaricom.co.ke) whether they block requests from Cloudflare.');
  const d = r.data || {};
  if (r.status === 200 && d.access_token) return step('login', 'Log in to Safaricom', 'ok', `Safaricom accepted the Consumer Key and Secret (${env} app) in ${r.ms} ms.`);
  const html = /^\s*</.test(r.text);
  const said = d.errorMessage || d.error_description || d.error || (html ? 'an error web page instead of an answer' : clip(r.text, 160));
  if (html || r.status === 403) return step('login', 'Log in to Safaricom', 'fail', `Safaricom did not answer like its API does (HTTP ${r.status}: ${clip(said, 120)}).`, 'This usually means the request was blocked before reaching the login. Email apisupport@safaricom.co.ke with your app name and say that requests from Cloudflare Workers get HTTP ' + r.status + '.');
  if (r.status === 400 || r.status === 401) return step('login', 'Log in to Safaricom', 'fail', `Safaricom refused the Consumer Key / Secret (HTTP ${r.status}: ${clip(said, 140)}). The Environment here is ${env.toUpperCase()}.`, env === 'production'
    ? 'Production keys exist only after Safaricom approves your go-live. Copy the PRODUCTION app\'s Consumer Key and Secret (not the sandbox ones) from developer.safaricom.co.ke > My Apps, and save them again.'
    : 'Use the Consumer Key and Secret of a SANDBOX app (My Apps on developer.safaricom.co.ke). If these are your live keys, change the Environment to Production.');
  return step('login', 'Log in to Safaricom', 'fail', `Unexpected answer from Safaricom (HTTP ${r.status}): ${clip(said, 160)}.`, 'Try again; if it repeats, send this report to Safaricom API support.');
}

/* exported for tests: what Safaricom's answer to the "status of an invented prompt" question means */
export function explainShortcode(r, cfg) {
  const title = 'Shortcode and passkey';
  if (!r.ok) return step('shortcode', title, 'warn', `No answer from Safaricom for this check (${r.error}).`);
  const d = r.data || {};
  const said = d.errorMessage || d.ResponseDescription || d.ResultDesc || d.CustomerMessage || clip(r.text, 160);
  const code = d.errorCode ? ` [${d.errorCode}]` : '';
  const txt = `${said}${code}`;
  if (/wrong credentials|invalid (pass|password)|password|passkey/i.test(String(said))) return step('shortcode', title, 'fail', `Safaricom says: ${clip(txt)}. The passkey does not belong to this shortcode.`, 'Use the passkey Safaricom gave for THIS shortcode (production: from your go-live email / the Daraja portal; sandbox: the long public test passkey with shortcode 174379). For a Till, the Shortcode box must hold the Store / Head Office number.');
  if (/shortcode|short code|merchant (does not|doesn't) exist|invalid (business|org)/i.test(String(said)) || d.errorCode === '400.002.02') return step('shortcode', title, 'fail', `Safaricom says: ${clip(txt)}. Shortcode ${cfg.mpesaShortcode} was not recognised.`, 'Check the number: a Paybill or the Store / Head Office number of your Till, exactly as in your Safaricom go-live email.');
  if (/access token|404\.001\.03|not (authori[sz]ed|allowed|subscribed)|no (permission|access)/i.test(txt)) return step('shortcode', title, 'fail', `Safaricom says: ${clip(txt)}. The login worked, but this app is not allowed to use M-Pesa Express (STK push) for this shortcode.`, 'In the Daraja portal, open the app and make sure the "Lipa na M-Pesa / M-Pesa Express" product is added to it. If it is, ask apisupport@safaricom.co.ke to enable STK push on the shortcode.');
  if (r.status === 200 || d.ResultCode !== undefined || d.CheckoutRequestID || /checkout|transaction|processed|request id|not found|invalid request/i.test(String(said))) return step('shortcode', title, 'ok', `Safaricom accepted the shortcode ${cfg.mpesaShortcode} and passkey (it only complained that the test prompt number does not exist, which is expected). Safaricom said: ${clip(txt, 140)}`);
  return step('shortcode', title, 'warn', `Safaricom's answer was not one this check knows (HTTP ${r.status}): ${clip(txt, 200)}`, 'If STK prompts also fail, send this line to Safaricom API support.');
}

export async function onRequestOptions(context) { return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env, { methods: 'POST, OPTIONS' }) }); }

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env, { methods: 'POST, OPTIONS', headers: 'Content-Type, X-Device-Id, X-Device-Token, X-Staff-Token' });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return json({ error: 'This link is not active.', reason: license.reason }, 403, cors);
  const clientId = license.clientId;
  const deviceDenied = await deviceGuard(request, env, clientId, cors);
  if (deviceDenied) return deviceDenied;
  const mgrDenied = await managerGuard(request, env, clientId, cors);
  if (mgrDenied) return mgrDenied;
  const capped = await secLimit(env, 'dcheck', clientId, secNum(env.DARAJA_CHECK_HOURLY_LIMIT, 30), 3600, 'connection tests', cors);
  if (capped) return capped;

  const cfg = await loadGatewayConfig(env, clientId);
  if (cfg.secretsUnreadable) return json({ error: 'The saved payment keys cannot be read right now — contact support.', code: 'secrets_unreadable' }, 503, cors);

  const steps = [];
  const envName = String(cfg.mpesaEnv || 'sandbox').toLowerCase();
  const isTill = cfg.mpesaTransactionType === 'CustomerBuyGoodsOnline';

  /* 1 — what is saved */
  const missing = [['Consumer Key', cfg.mpesaConsumerKey], ['Consumer Secret', cfg.mpesaConsumerSecret], ['Shortcode', cfg.mpesaShortcode], ['Passkey', cfg.mpesaPasskey]].filter((x) => !x[1]).map((x) => x[0]);
  let pending = null; try { pending = await getPendingChange(env, clientId); } catch (e) { /* none */ }
  const heldDaraja = pending && Array.isArray(pending.providers) && pending.providers.includes('daraja');
  if (missing.length) steps.push(step('saved', 'Saved details', 'fail', `Not saved yet: ${missing.join(', ')}.`, 'Fill all four boxes in Option B and press Save Daraja Credentials (it asks for your Admin password).'));
  else steps.push(step('saved', 'Saved details', 'ok', `Consumer Key, Secret, Shortcode ${cfg.mpesaShortcode} and Passkey are saved. Environment: ${envName.toUpperCase()}; type: ${isTill ? 'Till (Buy Goods)' : 'Paybill'}.`));
  const till = String(cfg.mpesaPartyB || '').trim();
  const effParty = isTill && till ? till : sc0();
  function sc0() { return String(cfg.mpesaShortcode || '').trim(); }
  steps.push(step('sent', 'What is sent to Safaricom', 'info', `Type: ${isTill ? 'Till (Buy Goods)' : 'Paybill'} - BusinessShortCode: ${sc0() || '(empty)'} - receiver (PartyB): ${effParty || '(empty)'}${isTill && !till ? ' (the Till box is empty, so the Shortcode is used for both)' : ''}${!isTill && till ? ' (a Till number is saved but ignored because the Type is Paybill)' : ''}.`, isTill ? 'For a Till, Safaricom wants the Store / Head Office number as BusinessShortCode and the Till under it as the receiver. Different numbers are normal.' : ''));
  if (heldDaraja) steps.push(step('held', 'Keys waiting to start', 'warn', `New Daraja keys were saved but are held until ${new Date(pending.effectiveAt + 3 * 3600000).toISOString().replace('T', ' ').slice(0, 16)} (Nairobi time) — until then the OLD values are the ones being tested and used${pending.fieldNames && pending.fieldNames.length ? ' (waiting: ' + pending.fieldNames.map((n) => n.replace(/^mpesa/, '')).join(', ') + ')' : ''}.`, 'Wait for that time, or cancel the waiting change in Settings and save again.'));

  /* 2 — do the settings agree */
  const sc = String(cfg.mpesaShortcode || '').trim();
  const sanity = [];
  if (envName === 'production' && sc === '174379') sanity.push('Shortcode 174379 is Safaricom\'s SANDBOX test shortcode, but the Environment is PRODUCTION. Use your real Paybill / Store number, or switch the Environment to Sandbox.');
  if (envName === 'sandbox' && sc && sc !== '174379') sanity.push(`The Environment is SANDBOX but the shortcode is ${sc}. Sandbox only works with the test shortcode 174379 and the test passkey. For real money use Production.`);
  if (isTill && !cfg.mpesaPartyB) sanity.push('The type is Till (Buy Goods) but no Till number is saved. The Shortcode box must hold the Store / Head Office number and the Till number box your Till (if both are the same number you can leave it empty).');
  if (sc && !/^\d{5,7}$/.test(sc)) sanity.push(`The shortcode "${sc}" should be 5 to 7 digits only.`);
  steps.push(sanity.length ? step('sanity', 'Settings agree with each other', 'warn', sanity.join(' ')) : step('sanity', 'Settings agree with each other', 'ok', 'Environment, shortcode and type fit together.'));

  /* 3 — login */
  let token = '';
  if (!cfg.mpesaConsumerKey || !cfg.mpesaConsumerSecret) {
    steps.push(step('login', 'Log in to Safaricom', 'skip', 'Needs the Consumer Key and Secret first.'));
  } else {
    const r = await timedFetch(`${baseUrl(cfg)}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${btoa(`${cfg.mpesaConsumerKey}:${cfg.mpesaConsumerSecret}`)}` } });
    steps.push(explainToken(r, envName));
    if (r.ok && r.data && r.data.access_token) token = r.data.access_token;
  }

  /* 4 — shortcode + passkey */
  if (!token) steps.push(step('shortcode', 'Shortcode and passkey', 'skip', 'Needs a successful login first.'));
  else if (!sc || !cfg.mpesaPasskey) steps.push(step('shortcode', 'Shortcode and passkey', 'skip', 'Needs the shortcode and passkey first.'));
  else {
    const ts = timestamp();
    const r = await timedFetch(`${baseUrl(cfg)}/mpesa/stkpushquery/v1/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ BusinessShortCode: sc, Password: btoa(`${sc}${cfg.mpesaPasskey}${ts}`), Timestamp: ts, CheckoutRequestID: 'ws_CO_00000000000000000000000000000000' }),
    });
    steps.push(explainShortcode(r, cfg));
  }

  /* 5 — the result address */
  try {
    const origin = callbackOrigin(request, env);
    const cb = withKey(`${origin}/api/pay-cb-stk?c=${encodeURIComponent(clientId)}`, await ensureCallbackKey(env, clientId, 'stk'));
    const u = new URL(cb);
    const bad = (u.hostname + u.pathname).match(FORBIDDEN_IN_CALLBACK);
    const notes = [];
    if (bad) notes.push(`The address contains "${bad[1]}", a word Safaricom's production system refuses in callback addresses, so results would never arrive.`);
    if (u.protocol !== 'https:') notes.push('The address is not https.');
    let reach = null;
    const probe = await timedFetch(`${u.origin}${u.pathname}?c=${encodeURIComponent(clientId)}`, { method: 'GET' }, 6000);
    if (probe.ok) reach = probe.status; else notes.push(`The server could not open its own result address (${probe.error}).`);
    if (reach !== null && reach >= 500) notes.push(`The result address answered HTTP ${reach}.`);
    steps.push(notes.length
      ? step('callback', 'Where Safaricom sends the result', 'fail', `${u.origin}${u.pathname} — ${notes.join(' ')}`, bad ? 'Change the name of the site (the domain) used for results: set PAY_CALLBACK_ORIGIN in Cloudflare to a plain address such as https://yourbusiness.co.ke and deploy again.' : 'Check the site is online and deployed.')
      : step('callback', 'Where Safaricom sends the result', 'ok', `${u.origin}${u.pathname} — https, no refused words, and it answers (HTTP ${reach}).${/\.pages\.dev$/i.test(u.hostname) ? ' It is on a pages.dev address; if prompts are sent but their result never arrives, set PAY_CALLBACK_ORIGIN to your own domain.' : ''}`));
  } catch (e) { steps.push(step('callback', 'Where Safaricom sends the result', 'warn', `Could not check: ${clip(e && e.message)}`)); }

  /* 6 — what happened to recent prompts */
  try {
    const list = await env.mydukapos_kv.list({ prefix: `mpesa-tx:${clientId}:`, limit: 100 });
    const rows = [];
    for (const k of (list.keys || []).slice(-30)) { try { const v = JSON.parse(await env.mydukapos_kv.get(k.name)); if (v && v.provider !== 'paystack') rows.push(v); } catch (e) { /* skip */ } }
    const now = Date.now();
    const reasons = Array.from(new Set(rows.filter((x) => x.status === 'failed' && x.resultDesc).map((x) => clip(x.resultDesc, 120)))).slice(-3);
    const done = rows.filter((x) => x.status === 'success').length, failed = rows.filter((x) => x.status === 'failed').length;
    const stuck = rows.filter((x) => x.status === 'pending' && now - (x.createdAt || now) > 3 * 60 * 1000).length;
    if (!rows.length) steps.push(step('history', 'Recent prompts', 'skip', 'No prompt has been sent from this shop yet.'));
    else if (stuck && !done) steps.push(step('history', 'Recent prompts', 'fail', `${rows.length} prompt(s) sent, ${stuck} still waiting for a result after 3+ minutes, none ever succeeded.`, 'The prompt reaches Safaricom but the result does not come back: check step "Where Safaricom sends the result", and that the Daraja app\'s production callback is allowed.'));
    else steps.push(step('history', 'Recent prompts', stuck || (failed && !done) ? 'warn' : 'ok', `${rows.length} recent prompt(s): ${done} paid, ${failed} failed or cancelled, ${stuck} waiting for a result.${reasons.length ? ' Safaricom said: ' + reasons.map((r) => '"' + r + '"').join('; ') + '.' : ''}`, reasons.map((r) => explainFailure(r)).filter(Boolean).join(' ')));
  } catch (e) { steps.push(step('history', 'Recent prompts', 'skip', 'Could not read the history.')); }

  const firstBad = steps.find((s) => s.status === 'fail') || steps.find((s) => s.status === 'warn');
  return json({
    ok: true, env: envName, at: Date.now(),
    summary: firstBad ? (firstBad.status === 'fail' ? `Stopped at: ${firstBad.title}` : `Works, but check: ${firstBad.title}`) : 'Every step passed',
    steps,
  }, 200, cors);
}
