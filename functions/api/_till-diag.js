// functions/api/_till-diag.js — shared helper, NOT a route. zip 358: Till payment health.
//
// Why: a payment made straight to the Till could vanish with no trace - a callback without the shop id was acknowledged and dropped, and one whose
// key did not match went to a KV bucket no screen showed. Now every callback leaves a short trace the owner sees in Settings > Payment Gateway >
// Till health, and a HELD payment (arrived, but not provably from Safaricom for this shop) can be reviewed and accepted by the owner.
//
// KV keys (all small, all with expiry except the shortcode map):
//   till-diag:<shop>            last 30 events  [{ at, outcome, code, amount, name, sc, via }]
//   till-held:<shop>            held payments   [{ code, amount, paidAt, name, ref, phoneHint, sc, receivedAt, why }]   (max 100, 30 days)
//   c2b-sc:<shortcode>          -> shop id that registered this Till / Store / Paybill number (written by Register Till URLs)
//   c2b-reg:<shop>              the last registration: { at, results:[{ shortCode, ok, version, message }], confirmationUrl (key hidden) }
//   c2b-orphan:<shortcode>      callbacks that named no shop and matched no registered number (last 20, 30 days) - shown to the platform owner

const DAY = 86400;
const readJson = async (env, key, dflt) => { try { const raw = await env.mydukapos_kv.get(key); return raw ? JSON.parse(raw) : dflt; } catch (e) { return dflt; } };

export const OUTCOME_TEXT = {
  accepted: 'Received and listed in Till Payments',
  repeat: 'Repeat of a payment already listed (ignored)',
  held_key: 'HELD - the address Safaricom used has an old or wrong shop key',
  held_nokey: 'HELD - Safaricom called without the shop key (old address registered)',
  pulled: 'Recovered from Safaricom (Pull Transactions)',
  accepted_by_owner: 'Held payment accepted by the owner',
};

export async function logTillEvent(env, clientId, ev) {
  if (!env || !env.mydukapos_kv || !clientId) return;
  try {
    const list = await readJson(env, `till-diag:${clientId}`, []);
    list.unshift({ at: Date.now(), ...ev });
    await env.mydukapos_kv.put(`till-diag:${clientId}`, JSON.stringify(list.slice(0, 30)), { expirationTtl: 60 * DAY });
  } catch (e) { /* diagnostics never break a payment */ }
}

export async function holdTillPayment(env, clientId, p) {
  if (!env || !env.mydukapos_kv || !clientId || !p || !p.code) return;
  try {
    const list = await readJson(env, `till-held:${clientId}`, []);
    if (list.some((x) => x.code === p.code)) return;
    list.unshift(p);
    await env.mydukapos_kv.put(`till-held:${clientId}`, JSON.stringify(list.slice(0, 100)), { expirationTtl: 30 * DAY });
  } catch (e) { /* the per-code rejected record is still written by the caller */ }
}
export async function listHeld(env, clientId) { return readJson(env, `till-held:${clientId}`, []); }
export async function dropHeld(env, clientId, code) {
  const list = await readJson(env, `till-held:${clientId}`, []);
  const hit = list.find((x) => x.code === code) || null;
  if (hit) await env.mydukapos_kv.put(`till-held:${clientId}`, JSON.stringify(list.filter((x) => x.code !== code)), { expirationTtl: 30 * DAY });
  return hit;
}

export const normSc = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(0, 12);
export async function mapShortcodes(env, clientId, codes) {
  for (const sc of codes.map(normSc).filter(Boolean)) { try { await env.mydukapos_kv.put(`c2b-sc:${sc}`, String(clientId)); } catch (e) { /* best effort */ } }
}
export async function shopForShortcode(env, sc) {
  const n = normSc(sc); if (!n) return '';
  try { return (await env.mydukapos_kv.get(`c2b-sc:${n}`)) || ''; } catch (e) { return ''; }
}
export async function noteOrphan(env, sc, ev) {
  const n = normSc(sc) || 'none';
  try {
    const list = await readJson(env, `c2b-orphan:${n}`, []);
    list.unshift({ at: Date.now(), ...ev });
    await env.mydukapos_kv.put(`c2b-orphan:${n}`, JSON.stringify(list.slice(0, 20)), { expirationTtl: 30 * DAY });
  } catch (e) { /* nothing to attribute it to */ }
}
export async function saveRegistration(env, clientId, rec) {
  try { await env.mydukapos_kv.put(`c2b-reg:${clientId}`, JSON.stringify({ at: Date.now(), ...rec })); } catch (e) { /* the result was shown on screen */ }
}
export async function readRegistration(env, clientId) { return readJson(env, `c2b-reg:${clientId}`, null); }
export async function readEvents(env, clientId) { return readJson(env, `till-diag:${clientId}`, []); }
