// functions/api/pesapal-ipn.js — Cloudflare Pages Function (zip 210)
// Pesapal calls this (GET) when an order's payment status changes: ?OrderTrackingId=..&OrderMerchantReference=..&OrderNotificationType=IPNCHANGE
// The shop is in ?c=. Nothing in the request is believed on its own: the order must be one THIS shop created, and the outcome is read from
// Pesapal itself (GetTransactionStatus). Pesapal expects the same three fields echoed back with status 200.
import { shopKnown } from './_callback-key.js';
import { loadGatewayConfig } from './_gateway-config.js';
import { pesapalStatus, applyPesapalStatus, indexPesapalReceipt } from './_pesapal.js';
import { recordGatewayTxn } from './_ledger.js';

const txKey = (clientId, id) => `mpesa-tx:${clientId}:${id}`;

function reply(trackingId, ref) {
  return new Response(JSON.stringify({ orderNotificationType: 'IPNCHANGE', orderTrackingId: trackingId || '', orderMerchantReference: ref || '', status: 200 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function handle(request, env) {
  const url = new URL(request.url);
  const clientId = url.searchParams.get('c') || '';
  let trackingId = url.searchParams.get('OrderTrackingId') || '';
  let ref = url.searchParams.get('OrderMerchantReference') || '';
  if (!trackingId && request.method === 'POST') {
    try { const b = await request.json(); trackingId = String(b.OrderTrackingId || b.orderTrackingId || ''); ref = String(b.OrderMerchantReference || b.orderMerchantReference || ref); } catch (e) { /* nothing usable */ }
  }
  if (!clientId || !trackingId || trackingId.length > 100) return reply(trackingId, ref);
  if (!(await shopKnown(env, clientId))) return reply(trackingId, ref);
  const kvKey = txKey(clientId, trackingId);
  const raw = await env.mydukapos_kv.get(kvKey);
  if (!raw) return reply(trackingId, ref);                       // not an order this shop created
  const existing = JSON.parse(raw);
  if (existing.provider !== 'pesapal' || existing.status === 'success') return reply(trackingId, ref);
  try {
    const cfg = await loadGatewayConfig(env, clientId);
    const updated = applyPesapalStatus(existing, await pesapalStatus(cfg, trackingId));
    if (updated) {
      await env.mydukapos_kv.put(kvKey, JSON.stringify(updated));
      if (updated.status === 'success') await indexPesapalReceipt(env, clientId, updated, trackingId);
      if (updated.status === 'success') await recordGatewayTxn(env, clientId, { provider: 'pesapal', txnId: trackingId, code: updated.receiptNumber, amount: Number(updated.amount) || 0, phone: updated.phone, status: 'RECEIVED' });
    }
  } catch (e) { /* the till's own status check asks Pesapal again */ }
  return reply(trackingId, ref);
}

export async function onRequestGet(context) { return handle(context.request, context.env); }
export async function onRequestPost(context) { return handle(context.request, context.env); }
