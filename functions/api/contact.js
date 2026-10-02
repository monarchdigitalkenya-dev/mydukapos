// functions/api/contact.js — public contact form (zip 177).
//   POST { name, contact, message, website (honeypot, must be empty), t (page-open time), cfToken? }  -> { ok:true }
//   POST { action:'list' } with the owner's Bearer token                                              -> { messages }
// Bot protection without a third party: a hidden honeypot field, a minimum fill time, an hourly per-IP limit, strict length checks.
// If CF Turnstile is configured (env.TURNSTILE_SECRET) the token is verified too; without it the form still works. Messages are kept in KV
// for 90 days, and e-mailed to env.CONTACT_NOTIFY_EMAIL when that variable and an e-mail service are set.
import { requireOwnerAuth } from './_owner-auth.js';
import { checkRateLimit } from './_ratelimit.js';
import { sendEmail } from './_email.js';

const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (b, s = 200, extra = {}) => new Response(JSON.stringify(b), { status: s, headers: { ...H, ...extra } });
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MSG = 'contact-msg:';

async function turnstileOk(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: String(token), remoteip: ip }) });
    return !!(await r.json()).success;
  } catch (e) { return false; }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let b; try { b = await request.json(); } catch (e) { return json({ error: 'Invalid request.' }, 400); }
  if (b && b.action === 'list') {
    if (!(await requireOwnerAuth(context))) return json({ error: 'Sign in as the owner.' }, 401);
    const l = await env.mydukapos_kv.list({ prefix: MSG, limit: 200 });
    const messages = (await Promise.all(l.keys.map(async (k) => { try { return JSON.parse(await env.mydukapos_kv.get(k.name)); } catch (e) { return null; } }))).filter(Boolean).sort((a, c) => c.at - a.at);
    return json({ messages });
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (b.website) return json({ ok: true });                                        // honeypot filled: pretend success, store nothing
  const name = clean(b.name, 100), contact = clean(b.contact, 120), message = clean(b.message, 2000);
  if (!name || !contact || message.length < 5) return json({ error: 'Please fill in your name, how to reach you, and a message.' }, 400);
  if (Number(b.t) && Date.now() - Number(b.t) < 1500) return json({ ok: true });  // submitted faster than a person can type
  const rl = await checkRateLimit(env, 'contact', 'ip:' + ip);
  if (!rl.ok) return json({ error: 'Too many messages from your network. Please try again later or WhatsApp us.', code: 'rate_limited' }, 429, { 'Retry-After': String(rl.retryAfter) });
  if (!(await turnstileOk(env, b.cfToken, ip))) return json({ error: 'Bot check failed. Please try again.' }, 400);
  const rec = { id: crypto.randomUUID(), at: Date.now(), name, contact, message };
  await env.mydukapos_kv.put(MSG + rec.at + ':' + rec.id, JSON.stringify(rec), { expirationTtl: 90 * 86400 });
  if (env.CONTACT_NOTIFY_EMAIL) {
    try { await sendEmail(env, { to: env.CONTACT_NOTIFY_EMAIL, subject: 'mydukapos contact form: ' + name, html: `<p><b>${esc(name)}</b> (${esc(contact)})</p><p>${esc(message).replace(/\n/g, '<br>')}</p>` }); } catch (e) { /* stored anyway */ }
  }
  return json({ ok: true });
}
export async function onRequestGet() { return json({ error: 'POST only.' }, 405); }
