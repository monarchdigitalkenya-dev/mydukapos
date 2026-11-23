// functions/api/_onfon.js — Onfon Media SMS adapter (zip 327). NOT a route. Used by sms-send.js (dispatchSms), sms-config.js and sms-test.js.
//
// CONTRACT USED (from the integration brief; the official pages www.docs.onfonmedia.co.ke/rest/... were NOT reachable from the build environment, so
// everything below that the brief did not state is written tolerantly and is listed in the report as "to verify against a live account"):
//   Send:    POST https://api.onfonmedia.co.ke/v1/sms/SendBulkSMS
//            Header  AccessKey: <access key>          Content-Type: application/json
//            Body    { SenderId, MessageParameters: [ { Number, Text } ... ], ApiKey, ClientId }
//   Balance: GET  https://api.onfonmedia.co.ke/v1/sms/Balance   (AccessKey header; ApiKey and ClientId as query parameters)
//   Reply (both): { ErrorCode: 0 = accepted, ErrorDescription, Data: [ ... ] }; a send's Data rows carry MessageErrorCode / MessageErrorDescription /
//   MobileNumber / MessageId. HTTP 200 alone is NEVER taken as success: the ErrorCode (and each row's MessageErrorCode) is read.
// SAFETY: one attempt only, with a timeout. A timeout or a dropped connection is reported as "uncertain" (the message may have been accepted) and is NEVER
// retried here, so an OTP / notification cannot be sent twice by a network hiccup. Secrets are only ever put in the request to Onfon; they are never logged,
// never returned and are removed from anything echoed back (redact()).
export const ONFON_SEND_URL = 'https://api.onfonmedia.co.ke/v1/sms/SendBulkSMS';
export const ONFON_BALANCE_URL = 'https://api.onfonmedia.co.ke/v1/sms/Balance';
export const ONFON_TIMEOUT_MS = 15000;
export const ONFON_FIELDS = ['onfonAccessKey', 'onfonApiKey', 'onfonClientId', 'onfonSenderId'];

// Onfon wants digits only, country code first: 2547XXXXXXXX. Kenyan local forms are normalised; another country's number is accepted as + and digits.
// -> the number, or '' when it is not a plausible phone number (never guessed).
export function onfonNumber(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const intl = s.startsWith('+') || s.startsWith('00');
  const d = s.replace(/\D/g, '');
  if (!d) return '';
  let n = d;
  if (s.startsWith('00')) n = d.slice(2);
  if (/^254[17]\d{8}$/.test(n)) return n;
  if (!intl && /^0[17]\d{8}$/.test(d)) return '254' + d.slice(1);
  if (!intl && /^[17]\d{8}$/.test(d)) return '254' + d;
  if (intl && /^[1-9]\d{7,14}$/.test(n) && !n.startsWith('254')) return n;
  return '';
}
export function onfonConfigured(c) { return !!(c && c.onfonAccessKey && c.onfonApiKey && c.onfonClientId && c.onfonSenderId); }
export function onfonEnabled(c) { return !(c && c.onfonEnabled === false); }
export function redact(text, c) {
  let t = String(text == null ? '' : text);
  ONFON_FIELDS.forEach((k) => { const v = c && c[k]; if (v && String(v).length >= 4) t = t.split(String(v)).join('***'); });
  return t;
}

// Sorts Onfon's answer into the cases the brief lists. Onfon's numeric codes were not available to verify, so the DESCRIPTION is matched too.
export function classifyOnfon(code, desc) {
  const c = Number(code), d = String(desc || '').toLowerCase();
  if (c === 0 && (!d || /success/.test(d))) return 'ok';
  if (/insufficient|low (bulk )?(sms )?(credit|balance)|no credit|not enough (credit|balance)|top.?up/.test(d)) return 'credits';
  if (/sender/.test(d)) return 'sender';
  if (/(invalid|wrong|incorrect|unknown).*(number|recipient|mobile|msisdn)|(number|recipient|mobile|msisdn).*(invalid|not valid)/.test(d)) return 'recipient';
  if (/(ip|address).*(not|restrict|allow|white)|whitelist|not allowed from/.test(d)) return 'ip';
  if (/(account|client).*(inactive|locked|suspend|disabled|blocked|expired)|inactive|locked|suspend/.test(d)) return 'account';
  if (/(invalid|wrong|incorrect|missing|unauthori[sz]ed|authenticat).*(key|credential|client|access|token)|unauthori[sz]ed|authentication|access ?key|api ?key|client ?id/.test(d)) return 'credentials';
  if (/rate|too many|throttl|limit/.test(d)) return 'rate';
  if (/error|fail|unavailable|timeout|server/.test(d)) return 'service';
  return 'unknown';
}
const FRIENDLY = {
  credentials: 'Onfon did not accept the credentials — check the Access Key, API Key and Client ID saved in Settings.',
  sender: 'Onfon says the Sender ID is invalid or not approved for this account — check the Sender ID in Settings.',
  recipient: 'Onfon says a recipient number is invalid.',
  credits: 'Not enough SMS credits on the Onfon account — top up and try again.',
  account: 'The Onfon account is inactive or locked — contact Onfon.',
  ip: 'Onfon refused this request because of an access / IP restriction on the account — ask Onfon to allow this service.',
  rate: 'Onfon is limiting the request rate — wait a moment and try again.',
  service: 'Onfon reported a service error — try again shortly.',
  unknown: 'Onfon did not accept the request.',
};
export function friendlyOnfon(kind, desc) { return FRIENDLY[kind] + (kind === 'unknown' && desc ? ' (' + String(desc).slice(0, 120) + ')' : ''); }

async function call(url, init, c, fetchImpl, timeoutMs) {
  const f = fetchImpl || globalThis.fetch;
  const ms = timeoutMs || ONFON_TIMEOUT_MS;
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => { try { if (ctl) ctl.abort(); } catch (e) { /* none */ } rej(Object.assign(new Error('timeout'), { name: 'AbortError' })); }, ms); });
  try {
    // the race, not the abort signal alone, ends the wait: a stalled connection can never hang the request
    const work = (async () => { const res = await f(url, { ...init, signal: ctl ? ctl.signal : undefined }); const text = await res.text(); return { res, text }; })();
    work.catch(() => {});
    const { res, text } = await Promise.race([work, timeout]);
    let data = null; try { data = JSON.parse(text); } catch (e) { data = null; }
    return { res, data, text };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort|timeout/i.test(String(e.message)));
    return { failed: true, uncertain: true, error: aborted ? 'Onfon did not answer in time. The message may or may not have been accepted — it was NOT sent again automatically. Check the delivery on your Onfon account before trying again.' : 'The connection to Onfon was lost. The message may or may not have been accepted — it was NOT sent again automatically.' };
  } finally { clearTimeout(timer); }
}

// -> same shape as the other providers: { success, sentCount, failedCount, summary, recipients:[{number,status,messageId}] } or { error, kind?, uncertain?, raw? }
export async function sendViaOnfon(config, recipients, message, opt = {}) {
  const numbers = recipients.map(onfonNumber);
  if (numbers.some((n) => !n)) return { error: friendlyOnfon('recipient'), kind: 'recipient' };
  const body = { SenderId: config.onfonSenderId, MessageParameters: numbers.map((Number_) => ({ Number: Number_, Text: message })), ApiKey: config.onfonApiKey, ClientId: config.onfonClientId };
  const r = await call(ONFON_SEND_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', AccessKey: config.onfonAccessKey }, body: JSON.stringify(body) }, config, opt.fetch, opt.timeoutMs);
  if (r.failed) return { error: r.error, uncertain: true };
  if (!r.data || typeof r.data !== 'object') {
    return { error: r.res.status === 401 || r.res.status === 403 ? friendlyOnfon('credentials') : 'Onfon sent an answer this app does not understand (HTTP ' + r.res.status + '). The message may not have been sent.', kind: r.res.status === 401 || r.res.status === 403 ? 'credentials' : 'unknown', uncertain: r.res.ok };
  }
  const code = r.data.ErrorCode ?? r.data.errorCode, desc = r.data.ErrorDescription ?? r.data.errorDescription;
  const rows = Array.isArray(r.data.Data) ? r.data.Data : (Array.isArray(r.data.data) ? r.data.data : []);
  const batchKind = classifyOnfon(code, desc);
  if (code === undefined || (batchKind !== 'ok')) {
    const kind = code === undefined ? (r.res.status === 401 || r.res.status === 403 ? 'credentials' : 'unknown') : batchKind;
    return { error: friendlyOnfon(kind, desc), kind, code: code === undefined ? undefined : Number(code), raw: JSON.parse(redact(JSON.stringify(r.data), config)) };
  }
  const list = rows.map((x) => {
    const mc = x.MessageErrorCode ?? x.messageErrorCode, md = x.MessageErrorDescription ?? x.messageErrorDescription;
    const k = mc === undefined ? 'ok' : classifyOnfon(mc, md);
    return { number: String(x.MobileNumber ?? x.mobileNumber ?? ''), status: k === 'ok' ? 'Success' : friendlyOnfon(k, md), messageId: x.MessageId ?? x.messageId, ok: k === 'ok' };
  });
  const okRows = list.length ? list.filter((x) => x.ok) : numbers.map((n) => ({ number: n, status: 'Success', ok: true }));
  const bad = list.length ? list.filter((x) => !x.ok) : [];
  return {
    success: okRows.length > 0, sentCount: okRows.length, failedCount: bad.length + Math.max(0, numbers.length - okRows.length - bad.length),
    summary: 'Accepted by Onfon (this is submission, not proof of delivery)', delivery: 'submitted',
    recipients: (list.length ? list : okRows).map(({ ok, ...rest }) => rest),
  };
}

export async function onfonBalance(config, opt = {}) {
  const u = ONFON_BALANCE_URL + '?ApiKey=' + encodeURIComponent(config.onfonApiKey) + '&ClientId=' + encodeURIComponent(config.onfonClientId);
  const r = await call(u, { method: 'GET', headers: { Accept: 'application/json', AccessKey: config.onfonAccessKey } }, config, opt.fetch, opt.timeoutMs);
  if (r.failed) return { error: r.error.replace(/The message may.*$/, '').trim() || 'Onfon could not be reached.' };
  if (!r.data || typeof r.data !== 'object') return { error: r.res.status === 401 || r.res.status === 403 ? friendlyOnfon('credentials') : 'The balance is not available right now (HTTP ' + r.res.status + ').', kind: 'unknown' };
  const code = r.data.ErrorCode ?? r.data.errorCode, desc = r.data.ErrorDescription ?? r.data.errorDescription;
  const kind = code === undefined ? 'unknown' : classifyOnfon(code, desc);
  if (kind !== 'ok') return { error: friendlyOnfon(kind, desc), kind };
  const rows = Array.isArray(r.data.Data) ? r.data.Data : (Array.isArray(r.data.data) ? r.data.data : []);
  const row = rows.find((x) => /sms/i.test(String(x.PluginType ?? x.pluginType ?? 'sms'))) || rows[0];
  const raw = row ? (row.Credits ?? row.credits ?? row.Balance ?? row.balance) : undefined;
  const n = raw === undefined ? NaN : Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n)) return { error: 'Onfon answered, but without a balance figure — nothing is shown rather than a guess.', kind: 'unknown' };
  return { ok: true, balance: n, currency: row && (row.Currency ?? row.currency) ? String(row.Currency ?? row.currency) : undefined, unit: 'SMS credits' };
}
