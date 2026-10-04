// functions/api/_pesapal.js — shared helper, NOT a route (zip 210).
// Pesapal API 3.0 (https://developer.pesapal.com): RequestToken -> RegisterIPN -> SubmitOrderRequest -> GetTransactionStatus.
// Pesapal is a HOSTED checkout: we create an order and get a payment page link (redirect_url); the customer opens it and pays by M-Pesa,
// Airtel Money, card or bank. It is not a phone-prompt API, so the till shows the link and waits for the result.
// A result is never believed from an incoming notification's own words: the IPN only says "something changed for order X" and we then ask
// Pesapal itself (GetTransactionStatus) — so nobody can forge a "paid".

export function pesapalBase(cfg) {
  return String(cfg.pesapalEnv || 'sandbox').toLowerCase() === 'production' ? 'https://pay.pesapal.com/v3' : 'https://cybqa.pesapal.com/pesapalv3';
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { throw new Error(`Pesapal returned an unexpected response (HTTP ${res.status}): ${text.slice(0, 200)}`); }
}

export async function pesapalToken(cfg) {
  const res = await fetch(`${pesapalBase(cfg)}/api/Auth/RequestToken`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ consumer_key: cfg.pesapalConsumerKey, consumer_secret: cfg.pesapalConsumerSecret }),
  });
  const data = await readJson(res);
  if (!res.ok || !data.token) throw new Error((data && data.error && (data.error.message || data.error.code)) || data.message || 'Pesapal rejected the Consumer Key / Secret.');
  return data.token;
}

// The IPN URL is registered once per shop + environment + URL; Pesapal's ipn_id is kept in KV and reused.
export async function pesapalIpnId(env, cfg, clientId, token, ipnUrl) {
  const key = `pesapal-ipn:${clientId}:${String(cfg.pesapalEnv || 'sandbox').toLowerCase()}`;
  try {
    const raw = await env.mydukapos_kv.get(key);
    if (raw) { const rec = JSON.parse(raw); if (rec && rec.url === ipnUrl && rec.ipnId) return rec.ipnId; }
  } catch (e) { /* register again */ }
  const res = await fetch(`${pesapalBase(cfg)}/api/URLSetup/RegisterIPN`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ url: ipnUrl, ipn_notification_type: 'GET' }),
  });
  const data = await readJson(res);
  if (!res.ok || !data.ipn_id) throw new Error((data && data.error && (data.error.message || data.error.code)) || 'Pesapal would not register the notification (IPN) address.');
  try { await env.mydukapos_kv.put(key, JSON.stringify({ url: ipnUrl, ipnId: data.ipn_id })); } catch (e) { /* registered next time */ }
  return data.ipn_id;
}

export async function pesapalSubmitOrder(cfg, token, order) {
  const res = await fetch(`${pesapalBase(cfg)}/api/Transactions/SubmitOrderRequest`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(order),
  });
  const data = await readJson(res);
  if (!res.ok || !data.order_tracking_id || !data.redirect_url) throw new Error((data && data.error && (data.error.message || data.error.code)) || data.message || 'Pesapal did not create the payment page.');
  return data;
}

export async function pesapalStatus(cfg, orderTrackingId) {
  const token = await pesapalToken(cfg);
  const res = await fetch(`${pesapalBase(cfg)}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return readJson(res);
}

// Turns Pesapal's answer into this app's record fields; null = still waiting. 1 = completed, 2 = failed, 3 = reversed, 0 = not paid yet.
export function applyPesapalStatus(record, data) {
  if (!data) return null;
  const code = Number(data.status_code);
  if (code === 1) {
    const paid = Number(data.amount) || 0;
    if (record.amount && paid && paid + 0.5 < Number(record.amount)) {
      return { ...record, status: 'failed', resultDesc: `Pesapal reports KES ${paid} paid but KES ${record.amount} was due.` };
    }
    return { ...record, status: 'success', resultDesc: data.payment_status_description || 'Payment received.', receiptNumber: data.confirmation_code || data.merchant_reference || record.merchantReference, amount: paid || record.amount, paymentMethod: data.payment_method || '', transactionDate: data.created_date, completedAt: Date.now() };
  }
  if (code === 2 || code === 3) return { ...record, status: 'failed', resultDesc: data.description || data.payment_status_description || (code === 3 ? 'Payment was reversed.' : 'Payment was not completed.') };
  return null;
}

// A confirmed Pesapal payment is indexed by its confirmation code exactly as an STK result is (mpesa-callback.js), so the till's receipt
// check (mpesa-verify.js) finds it from any device and one payment can never pay for two sales.
export async function indexPesapalReceipt(env, clientId, record, trackingId) {
  const code = String(record.receiptNumber || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{8,14}$/.test(code)) return;
  try { await env.mydukapos_kv.put(`mpesa-receipt:${clientId}:${code}`, JSON.stringify({ source: 'stk', amount: Number(record.amount) || 0, phone: record.phone || '', at: Date.now(), checkoutRequestId: trackingId }), { expirationTtl: 400 * 86400 }); } catch (e) { /* the till's own confirmation still holds */ }
}
