// functions/api/_sha-config.js — shared helper, NOT a route.
//
// Same pattern as _gateway-config.js (M-Pesa/Paystack/KCB), but for a
// hospital's own SHA (Social Health Authority, Kenya) / DHA AfyaConnect
// eClaims credentials. Each facility gets its own client ID and secret from
// SHA after completing DHA certification — this just gives Settings ->
// Insurance / Institutions -> SHA a place to save them, scoped per client
// link so one facility can never see or affect another's credentials.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

const KV_KEY_PREFIX = 'sha-config:v1:';

async function readStored(env, clientId) {
  try {
    const raw = await env.mydukapos_kv.get(KV_KEY_PREFIX + clientId);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

export async function loadShaConfig(env, clientId) {
  const stored = await readStored(env, clientId);
  return {
    shaEnv: stored.shaEnv || env.SHA_ENV || 'sandbox',
    shaBaseUrl: stored.shaBaseUrl || env.SHA_BASE_URL || '',
    shaClientId: stored.shaClientId || env.SHA_CLIENT_ID || '',
    shaClientSecret: stored.shaClientSecret || env.SHA_CLIENT_SECRET || '',
    shaFacilityCode: stored.shaFacilityCode || env.SHA_FACILITY_CODE || '',
  };
}

export async function saveShaConfig(env, clientId, updates) {
  const stored = await readStored(env, clientId);
  const merged = { ...stored };
  const fields = ['shaEnv', 'shaBaseUrl', 'shaClientId', 'shaClientSecret', 'shaFacilityCode'];
  fields.forEach((key) => {
    if (updates[key] !== undefined && updates[key] !== '') merged[key] = updates[key];
  });
  await env.mydukapos_kv.put(KV_KEY_PREFIX + clientId, JSON.stringify(merged));
  return merged;
}

export async function clearShaConfig(env, clientId) {
  await env.mydukapos_kv.delete(KV_KEY_PREFIX + clientId);
}

export function hasShaConfig(cfg) {
  return !!(cfg.shaClientId && cfg.shaClientSecret && cfg.shaFacilityCode);
}

// A short-lived OAuth2 access token, cached in KV so every claim submission
// in the same few minutes doesn't re-authenticate. Standard client_credentials
// grant — the same shape DHA's own docs and the sha-claim SDK both describe,
// but the exact token endpoint path is set by the facility in Settings
// (shaBaseUrl) since it differs between DHA's sandbox and production hosts
// and may change; nothing here hard-codes a DHA URL.
export async function shaAccessToken(env, clientId, cfg) {
  const cacheKey = `sha-token:v1:${clientId}`;
  try {
    const cached = await env.mydukapos_kv.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.expiresAt > Date.now() + 15000) return parsed.token;
    }
  } catch (e) { /* fall through and fetch a fresh one */ }

  if (!cfg.shaBaseUrl) throw new Error('SHA API base URL is not set (Settings → Insurance → SHA).');
  const tokenUrl = cfg.shaBaseUrl.replace(/\/+$/, '') + '/oauth/token';
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.shaClientId,
      client_secret: cfg.shaClientSecret,
    }).toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) {
    throw new Error((data && (data.error_description || data.error)) || `SHA authentication failed (HTTP ${res.status}).`);
  }
  const expiresInMs = (Number(data.expires_in) || 300) * 1000;
  try {
    await env.mydukapos_kv.put(cacheKey, JSON.stringify({ token: data.access_token, expiresAt: Date.now() + expiresInMs }), { expirationTtl: Math.max(60, Math.floor(expiresInMs / 1000)) });
  } catch (e) { /* caching is best-effort */ }
  return data.access_token;
}
