// functions/api/verify.js — email OR WhatsApp one-time-code verification for a website account (zip 177).
//   POST { action:'send',  token, channel:'email'|'whatsapp' }  -> { ok, sentTo (masked), expiresIn }
//   POST { action:'check', token, channel, code }               -> { ok, emailVerified, phoneVerified }
//   POST { action:'status', token }                             -> { emailVerified, phoneVerified, required, channels }
// The account's session token identifies who is verifying. A code is 6 digits, valid 10 minutes, 5 tries, one resend a minute, 6 sends an hour
// (OTP_HOURLY_LIMIT). Only a salted hash of the code is stored. Verifying EITHER channel is enough to count as verified.
// Providers (nothing is faked): e-mail uses the Resend key saved in the Owner Console; WhatsApp needs WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID and an
// APPROVED authentication template named in WHATSAPP_OTP_TEMPLATE (Meta only allows business-started messages through templates). A channel
// whose provider is not set up answers 503 { code:'channel_unavailable' } instead of pretending.
// VERIFICATION_REQUIRED=1 makes generate-demo refuse unverified accounts (default off, so nobody already signed up is locked out).
import { emailFromToken, getAccount, saveAccount, sha256Hex, randomToken } from './_account.js';
import { sendEmail } from './_email.js';
import { checkRateLimit } from './_ratelimit.js';

const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (b, s = 200, x = {}) => new Response(JSON.stringify(b), { status: s, headers: { ...H, ...x } });
const KEY = (email, ch) => `otp:${ch}:${email}`;
const TTL = 600, MAX_TRIES = 5, COOLDOWN_MS = 60000;

export const verificationRequired = (env) => String(env && env.VERIFICATION_REQUIRED) === '1';
export const isVerified = (a) => !!(a && (a.emailVerified || a.phoneVerified));
const whatsappReady = (env) => !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_OTP_TEMPLATE);
const emailReady = async (env) => { try { const { getEmailConfig } = await import('./email-config.js'); return !!(await getEmailConfig(env)).resendApiKey; } catch (e) { return false; } };
const maskEmail = (e) => e.replace(/^(.).*(@.*)$/, '$1•••$2');
const maskPhone = (p) => p.replace(/\d(?=\d{3})/g, '•');
export function toIntlPhone(p) {                         // Kenyan numbers: 07xx / 01xx / 7xx / +2547xx -> 2547xxxxxxxx ; anything else must already carry a country code
  const d = String(p || '').replace(/[^\d]/g, '');
  if (/^0[17]\d{8}$/.test(d)) return '254' + d.slice(1);
  if (/^[17]\d{8}$/.test(d)) return '254' + d;
  if (/^254[17]\d{8}$/.test(d)) return d;
  return /^\d{10,15}$/.test(d) && String(p).trim().startsWith('+') ? d : '';
}
const newCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');

export async function onRequestPost(context) {
  const { request, env } = context;
  let b; try { b = await request.json(); } catch (e) { return json({ error: 'Invalid request.' }, 400); }
  const email = await emailFromToken(env, b.token);
  if (!email) return json({ error: 'Session expired — please sign in again.' }, 401);
  const account = await getAccount(env, email);
  if (!account) return json({ error: 'Account not found.' }, 404);
  const channel = b.channel === 'whatsapp' ? 'whatsapp' : 'email';
  const noEmail = String(email).endsWith('@phone.mydukapos.invalid');       // zip 179: signed up with only a WhatsApp number
  if (noEmail && channel === 'email' && b.action !== 'status') return json({ error: 'This account has no email address. Verify with WhatsApp instead.', code: 'no_email' }, 400);

  if (b.action === 'status') return json({ emailVerified: !!account.emailVerified, phoneVerified: !!account.phoneVerified, required: verificationRequired(env), channels: { email: await emailReady(env), whatsapp: whatsappReady(env) } });

  if (b.action === 'send') {
    const phone = toIntlPhone(account.phone);
    if (channel === 'whatsapp' && !phone) return json({ error: 'Your phone number needs a country code (for example +2547…) to use WhatsApp verification.', code: 'bad_phone' }, 400);
    if (channel === 'whatsapp' ? !whatsappReady(env) : !(await emailReady(env))) return json({ error: `${channel === 'whatsapp' ? 'WhatsApp' : 'Email'} verification is not available right now. Try the other option.`, code: 'channel_unavailable' }, 503);
    const prev = await env.mydukapos_kv.get(KEY(email, channel)).then((r) => (r ? JSON.parse(r) : null)).catch(() => null);
    if (prev && Date.now() - prev.sentAt < COOLDOWN_MS) return json({ error: 'Please wait a minute before asking for another code.', code: 'cooldown', retryAfter: Math.ceil((COOLDOWN_MS - (Date.now() - prev.sentAt)) / 1000) }, 429);
    const rl = await checkRateLimit(env, 'otp', email);
    if (!rl.ok) return json({ error: 'Too many codes requested. Try again later.', code: 'rate_limited' }, 429, { 'Retry-After': String(rl.retryAfter) });
    const code = newCode(), salt = randomToken(8);
    let sent;
    if (channel === 'email') {
      sent = await sendEmail(env, { to: email, subject: 'Your mydukapos verification code', html: `<p>Your verification code is <b style="font-size:20px;letter-spacing:3px">${code}</b>.</p><p>It expires in 10 minutes. If you did not ask for it, ignore this email.</p>` });
    } else {
      try {
        const r = await fetch(`https://graph.facebook.com/${env.META_GRAPH_VERSION || 'v19.0'}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, { method: 'POST', headers: { Authorization: 'Bearer ' + env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'template', template: { name: env.WHATSAPP_OTP_TEMPLATE, language: { code: env.WHATSAPP_OTP_LANG || 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }, { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }] } }) });
        sent = { ok: r.ok };
      } catch (e) { sent = { ok: false }; }
    }
    if (!sent || !sent.ok) return json({ error: 'We could not send the code. Please try again, or use the other option.', code: 'send_failed' }, 502);
    await env.mydukapos_kv.put(KEY(email, channel), JSON.stringify({ h: await sha256Hex(salt + code + email), salt, sentAt: Date.now(), tries: 0 }), { expirationTtl: TTL });
    return json({ ok: true, sentTo: channel === 'email' ? maskEmail(email) : maskPhone(phone), expiresIn: TTL });
  }

  if (b.action === 'check') {
    const rec = await env.mydukapos_kv.get(KEY(email, channel)).then((r) => (r ? JSON.parse(r) : null)).catch(() => null);
    if (!rec) return json({ error: 'That code has expired. Ask for a new one.', code: 'expired' }, 400);
    if (rec.tries >= MAX_TRIES) { await env.mydukapos_kv.delete(KEY(email, channel)); return json({ error: 'Too many wrong tries. Ask for a new code.', code: 'too_many_tries' }, 429); }
    const code = String(b.code || '').replace(/\D/g, '');
    if (code.length !== 6 || (await sha256Hex(rec.salt + code + email)) !== rec.h) {
      rec.tries += 1; await env.mydukapos_kv.put(KEY(email, channel), JSON.stringify(rec), { expirationTtl: TTL });
      return json({ error: 'That code is not right.', code: 'bad_code', triesLeft: Math.max(0, MAX_TRIES - rec.tries) }, 400);
    }
    await env.mydukapos_kv.delete(KEY(email, channel));
    if (channel === 'email') { account.emailVerified = true; account.emailVerifiedAt = Date.now(); } else { account.phoneVerified = true; account.phoneVerifiedAt = Date.now(); }
    await saveAccount(env, account);
    return json({ ok: true, emailVerified: !!account.emailVerified, phoneVerified: !!account.phoneVerified });
  }
  return json({ error: 'Unknown action.' }, 400);
}
