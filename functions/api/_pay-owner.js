// functions/api/_pay-owner.js — shared helper, NOT a route (zip 267). Taking payment INTO the owner's own gateway (the owner account's Settings -> Payment
// Gateway): used by "Get my own link" (new links) and by renewals / add-ons. One place for: the gateway lookup, the STK prompt, and reading its result.
//
// A result counts as paid only when the callback (or Safaricom's / Paywave's own answer to our question) says so; the amount is checked by the caller.

import { getOwnerAccount } from './_owner-auth.js';
import { loadGatewayConfig, resolveProvider } from './_gateway-config.js';
import { sendStk } from './mpesa-stkpush.js';
import { refreshFromDaraja, refreshFromPaywaveExpress } from './mpesa-status.js';

export function normalizePhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1); else if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  return p;
}
export const validPhone = (p) => /^254(7|1)\d{8}$/.test(p);

export async function ownerGateway(env) {
  const acct = await getOwnerAccount(env);
  if (!acct || !acct.ownerClientId) return null;
  const cfg = await loadGatewayConfig(env, acct.ownerClientId);
  if (cfg.secretsUnreadable) return null;
  const provider = resolveProvider(cfg);
  return provider ? { clientId: acct.ownerClientId, cfg, provider } : null;
}

// Send the prompt. -> { checkoutId, provider, paymentUrl }  (throws with a plain message when the gateway refuses)
export async function sendOwnerStk(env, request, gw, { phone, amount, accountRef = 'MyDukaPOS', description = 'MyDukaPOS' }) {
  const r = await sendStk(env, request, gw.clientId, gw.cfg, gw.provider, { phone, amount, accountRef, description });
  return { checkoutId: r.id || r.transactionRequestId, provider: gw.provider, paymentUrl: r.paymentUrl };
}

// The stored result of a prompt (what the callback wrote), asking the gateway itself when it is slow: after 15 s pending, at most every 10 s, for Paywave Express and Daraja.
// -> the tx record ({ status: pending|success|failed, amount, receiptNumber, ... }) or null
export async function readOwnerTx(env, gw, checkoutId) {
  if (!gw || !checkoutId) return null;
  const txk = `mpesa-tx:${gw.clientId}:${checkoutId}`;
  let tx = null; try { tx = JSON.parse((await env.mydukapos_kv.get(txk)) || 'null'); } catch (e) { tx = null; }
  if (tx && tx.status === 'pending' && Date.now() - (tx.createdAt || 0) > 15000 && Date.now() - (tx.checkedAt || 0) > 10000 && (gw.provider === 'paywave' || gw.provider === 'daraja')) {
    try {
      const asked = gw.provider === 'paywave' ? await refreshFromPaywaveExpress(tx, checkoutId, gw.cfg) : await refreshFromDaraja(tx, checkoutId, gw.cfg);
      // money RECEIVED only: a Paywave answer counts as paid only with its M-Pesa receipt (a gateway can say "request accepted" while the customer has not paid)
      const up = gw.provider === 'paywave' && asked && asked.status === 'success' && !asked.receiptNumber ? null : asked;
      tx = up || { ...tx, checkedAt: Date.now() };
      await env.mydukapos_kv.put(txk, JSON.stringify(tx));
    } catch (e) { /* asked again on the next check */ }
  }
  return tx;
}
