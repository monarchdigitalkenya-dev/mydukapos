// functions/api/_sms-store.js — shared helper, NOT a route. (zip 247) The one place a shop's SMS gateway account (API keys) is read / written.
// Sealed with AES-GCM when the PAYMENT_SECRETS_KEY secret is set (see _secret-box.js); plain records are read as before and sealed when next touched.
import { openRecord, sealRecord } from './_secret-box.js';

const KEY = (clientId) => `sms-config:${clientId}`;
const aadOf = (clientId) => 'sms|' + clientId;

// -> { config, ok }   ok:false = sealed and unreadable (key missing): `config` is {} and the record must not be written over.
export async function readSmsConfigFull(env, clientId) {
  let raw = null;
  try { raw = await env.mydukapos_kv.get(KEY(clientId)); } catch (e) { return { config: {}, ok: true }; }
  const r = await openRecord(env, aadOf(clientId), raw);
  if (r.ok && r.needsSeal) { try { await writeSmsConfig(env, clientId, r.value); } catch (e) { /* sealed next time */ } }
  return { config: r.ok ? r.value : {}, ok: r.ok };
}
export async function readSmsConfig(env, clientId) { return (await readSmsConfigFull(env, clientId)).config; }
export async function writeSmsConfig(env, clientId, obj) {
  await env.mydukapos_kv.put(KEY(clientId), await sealRecord(env, aadOf(clientId), obj));
}
