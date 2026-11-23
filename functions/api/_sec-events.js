// functions/api/_sec-events.js — shared helper, NOT a route (zip 273).
//
// A small security-event log for the Owner Console: blocked requests (rate limits), failed sign-ins, rejected payment callbacks, wrong payment
// passwords. It records WHAT happened, WHERE and how often — never a password, PIN, one-time code, token, key or payment credential, and the
// caller's address only as a short one-way hash (enough to tell "the same caller" from "another", not who). One KV row per kind + shop + minute
// (a flood adds to a counter instead of writing a row per request); rows expire after 30 days. Best effort: it never throws and never slows a request
// noticeably (one KV write), and a failure to log never changes the answer.

const PREFIX = 'secevt:';
const TTL = 30 * 24 * 3600;
const REV = 9999999999999;

async function shortHash(text) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('secevt|' + String(text)));
    return Array.from(new Uint8Array(buf)).slice(0, 4).map((b) => (b < 16 ? '0' : '') + b.toString(16)).join('');
  } catch (e) { return ''; }
}

export const callerIp = (request) => (request && request.headers && (request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For'))) || 'unknown';

// kind: 'rate_limited' | 'login_failed' | 'callback_rejected' | 'pay_proof_failed' | ...   info: { route, shop, ip, detail } — plain short strings only.
export async function secEvent(env, kind, info = {}) {
  try {
    if (!env || !env.mydukapos_kv) return;
    const now = Date.now(), minute = Math.floor(now / 60000);
    const shop = String(info.shop || '').slice(0, 60), route = String(info.route || '').slice(0, 60);
    const who = info.ip ? await shortHash(info.ip) : '';
    const key = `${PREFIX}${String(REV - now).padStart(13, '0')}:${kind}:${shop || route}:${minute}`;
    // one row per kind + shop + minute: look for this minute's row first (deterministic suffix), else write a new one
    const dedupe = `secevt-m:${kind}:${shop || route}:${who}:${minute}`;
    const seen = await env.mydukapos_kv.get(dedupe);
    if (seen) {
      const row = await env.mydukapos_kv.get(seen);
      if (row) { const o = JSON.parse(row); o.count = (o.count || 1) + 1; o.last = now; await env.mydukapos_kv.put(seen, JSON.stringify(o), { expirationTtl: TTL }); return; }
    }
    const rec = { t: now, last: now, kind, route, shop, who, count: 1, detail: String(info.detail || '').slice(0, 120) };
    await env.mydukapos_kv.put(key, JSON.stringify(rec), { expirationTtl: TTL });
    await env.mydukapos_kv.put(dedupe, key, { expirationTtl: 180 });
  } catch (e) { /* logging must never change the answer */ }
}

// Newest first. -> [{ t, last, kind, route, shop, who, count, detail }]
export async function listSecEvents(env, limit = 100) {
  const out = [];
  try {
    let cursor;
    while (out.length < limit) {
      const page = await env.mydukapos_kv.list({ prefix: PREFIX, limit: Math.min(100, limit - out.length), cursor });
      for (const k of page.keys) {
        const raw = await env.mydukapos_kv.get(k.name);
        if (raw) { try { out.push(JSON.parse(raw)); } catch (e) { /* skip */ } }
      }
      if (page.list_complete || !page.keys.length) break;
      cursor = page.cursor;
    }
  } catch (e) { /* empty */ }
  return out.slice(0, limit);
}
