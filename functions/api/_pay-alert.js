// functions/api/_pay-alert.js — shared helper, NOT a route. (zip 247)
//
// Tells the OWNER, at once and by every channel that is set up, when a shop's payment or SMS credentials are changed, reset, or a held change
// is cancelled — so a stolen password or a leaked link cannot quietly move the money. Never contains a key or secret: only WHAT changed (the
// provider names), WHO confirmed it, WHEN, and — for a held change — when it starts and how to stop it.
//
// Channels (all best effort; a failure never blocks the save):
//   * SMS      through the shop's OWN SMS account (sms-config), to the phone on the shop's licence
//   * WhatsApp through the platform's WhatsApp Cloud API when WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ALERT_TEMPLATE are set
//              (Meta only lets a business start a chat with an approved TEMPLATE whose body has ONE {{1}} variable: the text below)
//   * Email    to the licence email, and a copy to PAYMENT_ALERT_EMAIL (else CONTACT_NOTIFY_EMAIL) so the platform owner sees every change
// Every event is also written to a small per-shop log (last 20, no secrets) that Settings shows, so a change is visible even if no alert got through.
import { getLicense } from './_license.js';
import { readSmsConfig } from './_sms-store.js';
import { sendShopSms } from './sms-send.js';
import { sendEmail } from './_email.js';
import { toIntlPhone } from './verify.js';

const LOG_KEY = (c) => `pay-change-log:${c}`;
const LOG_MAX = 20;

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Kenya time (UTC+3, no daylight saving): "07 Oct 22:04"
export function eatStamp(t) {
  const d = new Date(Number(t) + 3 * 3600000);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

const PROVIDER_NAMES = { paystack: 'Paystack', daraja: 'M-Pesa Daraja', kcb: 'KCB Buni', paywave: 'Paywave', pesapal: 'Pesapal', coop: 'Co-op Bank', sms: 'SMS account', provider: 'payment provider choice', mpesaEnv: 'M-Pesa mode', kcbEnv: 'KCB mode', pesapalEnv: 'Pesapal mode' };
export const providerLabel = (p) => PROVIDER_NAMES[p] || String(p);

// ev = { kind: 'changed'|'held'|'reset'|'cancelled'|'sms', providers: [..], who: {kind,name}, effectiveAt?, smsConfig? }
// (smsConfig: for an SMS-account change the alert goes out through the PREVIOUS account, never the one just saved)
export function alertText(shop, ev, now = Date.now()) {
  const names = (ev.providers || []).map(providerLabel).filter(Boolean).join(', ') || 'payment settings';
  const who = ev.who && ev.who.name ? ev.who.name : 'someone';
  const at = eatStamp(now);
  if (ev.kind === 'held') return `MyDuka ALERT: new payment keys were saved for ${shop} (${names}) by ${who} at ${at}. They start at ${eatStamp(ev.effectiveAt)}; until then the OLD keys keep working. NOT YOU? Open Settings > Payment Gateway > Cancel the pending change, then change your password.`;
  if (ev.kind === 'reset') return `MyDuka ALERT: ${names} payment details were REMOVED for ${shop} by ${who} at ${at}. Not you? Change your password now and contact support.`;
  if (ev.kind === 'cancelled') return `MyDuka: the pending payment-key change for ${shop} was cancelled by ${who} at ${at}.`;
  if (ev.kind === 'sms') return `MyDuka ALERT: the SMS account for ${shop} was changed by ${who} at ${at}. Not you? Change your password now and contact support.`;
  return `MyDuka ALERT: payment settings for ${shop} changed (${names}) by ${who} at ${at}. Not you? Change your password now and contact support.`;
}

async function sendWhatsapp(env, phone, text) {
  if (!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ALERT_TEMPLATE)) return false;
  const to = toIntlPhone(phone);
  if (!to) return false;
  try {
    const r = await fetch(`https://graph.facebook.com/${env.META_GRAPH_VERSION || 'v19.0'}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: env.WHATSAPP_ALERT_TEMPLATE, language: { code: env.WHATSAPP_ALERT_LANG || 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: text.slice(0, 900) }] }] } }),
    });
    return r.ok;
  } catch (e) { return false; }
}

async function appendLog(env, clientId, entry) {
  try {
    const raw = await env.mydukapos_kv.get(LOG_KEY(clientId));
    const list = raw ? JSON.parse(raw) : [];
    list.unshift(entry);
    await env.mydukapos_kv.put(LOG_KEY(clientId), JSON.stringify(list.slice(0, LOG_MAX)), { expirationTtl: 400 * 24 * 3600 });
  } catch (e) { /* the alert matters more than the log */ }
}

// What Settings shows: [{ at, kind, providers, by, held }] — no ip, no secrets.
export async function recentPayChanges(env, clientId, n = 5) {
  try {
    const list = JSON.parse((await env.mydukapos_kv.get(LOG_KEY(clientId))) || '[]');
    return list.slice(0, n).map((e) => ({ at: e.at, kind: e.kind, providers: e.providers || [], by: e.by || '', effectiveAt: e.effectiveAt || null, alerted: !!e.alerted }));
  } catch (e) { return []; }
}

// -> { alerted: boolean, channels: { sms, whatsapp, email } }
export async function notifyPayChange(env, clientId, ev, request = null) {
  const now = Date.now();
  let record = null;
  try { record = await getLicense(env, clientId); } catch (e) { /* alert what we can */ }
  const shop = (record && (record.preferredName || record.clientName || record.label)) || 'your shop';
  const text = alertText(shop, ev, now);
  const channels = { sms: false, whatsapp: false, email: false };
  const phone = record && record.phone ? String(record.phone) : '';
  const tasks = [];

  if (phone) {
    tasks.push((async () => {
      try { const cfg = ev.smsConfig || await readSmsConfig(env, clientId); const r = await sendShopSms(env, cfg, phone, text); channels.sms = !!r.ok; } catch (e) { /* none */ }
    })());
    tasks.push((async () => { channels.whatsapp = await sendWhatsapp(env, phone, text); })());
  }
  const html = `<p>${esc(text)}</p><p style="color:#666;font-size:12px">This message never contains a key or password. Time: ${esc(eatStamp(now))} (Kenya).</p>`;
  const subject = ev.kind === 'held' ? 'ALERT: new payment keys saved — starting soon' : 'ALERT: payment settings changed';
  const toOwner = record && record.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(record.email)) && !String(record.email).endsWith('.invalid') ? String(record.email) : '';
  if (toOwner) tasks.push((async () => { try { channels.email = !!(await sendEmail(env, { to: toOwner, subject, html })).ok; } catch (e) { /* none */ } })());
  const copy = String(env.PAYMENT_ALERT_EMAIL || env.CONTACT_NOTIFY_EMAIL || '').trim();
  if (copy && copy !== toOwner) tasks.push((async () => { try { await sendEmail(env, { to: copy, subject: `[${shop}] ${subject}`, html }); } catch (e) { /* none */ } })());

  await Promise.all(tasks);
  const alerted = channels.sms || channels.whatsapp || channels.email;
  await appendLog(env, clientId, {
    at: now, kind: ev.kind, providers: ev.providers || [], by: ev.who && ev.who.name ? ev.who.name : '', effectiveAt: ev.effectiveAt || null, alerted,
    ip: request ? (request.headers.get('CF-Connecting-IP') || '') : '', country: request ? (request.headers.get('CF-IPCountry') || '') : '',
  });
  return { alerted, channels };
}
export const alertable = (x) => Object.prototype.hasOwnProperty.call(PROVIDER_NAMES, x);
