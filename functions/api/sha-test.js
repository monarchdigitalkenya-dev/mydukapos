// functions/api/sha-test.js — Cloudflare Pages Function
//
// "Test Connection" button next to the SHA credentials in Settings. Does
// ONLY the OAuth2 token exchange (client_credentials grant against the
// facility's own shaBaseUrl) and reports whether that succeeded — it does
// NOT submit or query any real claim, so a green result here confirms the
// credentials and base URL are valid, not that claim submission itself is
// fully working (see the caveat on sha-claim-submit.js).
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { loadShaConfig, shaAccessToken, hasShaConfig } from './_sha-config.js';
import { requireValidLicense } from './_license.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const license = await requireValidLicense(request, env);
  if (!license.valid) return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);

  const cfg = await loadShaConfig(env, license.clientId);
  if (!hasShaConfig(cfg)) return jsonResponse({ ok: false, error: 'Fill in the client ID, client secret and facility code first.' });
  if (!cfg.shaBaseUrl) return jsonResponse({ ok: false, error: 'Enter the SHA API base URL first (given to you with your credentials).' });

  try {
    await shaAccessToken(env, license.clientId, cfg);
    return jsonResponse({ ok: true, env: cfg.shaEnv });
  } catch (e) {
    return jsonResponse({ ok: false, error: String(e && e.message || e) });
  }
}
