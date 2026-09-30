import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
export const WA_SECRET = 'app-secret-123';
export const sign = (body, secret = WA_SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
export const payload = (msgs, names = {}) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { contacts: Object.entries(names).map(([wa_id, name]) => ({ wa_id, profile: { name } })), messages: msgs } }] }] });
export const msg = (id, from, body, ts, referral) => ({ id, from, timestamp: String(Math.floor((ts || Date.now()) / 1000)), type: 'text', text: { body }, ...(referral ? { referral } : {}) });
export const adRef = (id, headline = 'POS for your shop') => ({ source_type: 'ad', source_id: id, source_url: 'https://fb.me/x', headline, body: 'b', ctwa_clid: 'clid-' + id });
export async function waHook(env, msgs, names, { secret = WA_SECRET, badSig = false } = {}) {
  const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/whatsapp-webhook.js')).href);
  const body = JSON.stringify(payload(msgs, names));
  return m.onRequestPost({ request: new Request('https://x.pages.dev/api/whatsapp-webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': badSig ? 'sha256=' + '0'.repeat(64) : sign(body, secret) } }), env });
}
