// functions/api/sha-config.js — Cloudflare Pages Function
//
// Backs Settings -> Insurance / Institutions -> SHA in hospital/index.html.
// Each hospital pastes in its own SHA/DHA client ID, client secret and
// facility code (issued once the facility has completed SHA registration
// and DHA certification — see afyastack.co.ke/resources/how-to-make-hospital-sha-compliant
// for what that process involves) and clicks Save, exactly like the
// existing M-Pesa Daraja panel.
//
// GET    -> tells the Settings panel what's configured so far. Never sends
//           the client secret back — only a boolean plus the non-secret
//           fields (environment, base URL, facility code, masked client ID).
// POST   -> saves whichever fields were sent; a field left out is untouched.
// DELETE -> clears this facility's saved SHA credentials.
//
// Blocked with 403 if this link's license isn't currently valid.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { loadShaConfig, saveShaConfig, clearShaConfig, hasShaConfig } from './_sha-config.js';
import { requireValidLicense } from './_license.js';
import { deviceGuard } from './_device-auth.js';
import { corsHeadersFor } from './_cors.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function maskId(id) {
  if (!id) return '';
  return id.length <= 4 ? '••••' : id.slice(0, 2) + '••••' + id.slice(-2);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const license = await requireValidLicense(request, env);
  if (!license.valid) return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  // PAIRED DEVICES ONLY when the shop has switched that on (see _device-auth.js); otherwise no change
  const deviceDenied = await deviceGuard(request, env, license.clientId, corsHeadersFor(request, env));
  if (deviceDenied) return deviceDenied;

  const cfg = await loadShaConfig(env, license.clientId);
  return jsonResponse({
    configured: hasShaConfig(cfg),
    shaEnv: cfg.shaEnv,
    shaBaseUrl: cfg.shaBaseUrl,
    shaFacilityCode: cfg.shaFacilityCode,
    shaClientIdMasked: maskId(cfg.shaClientId),
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const license = await requireValidLicense(request, env);
  if (!license.valid) return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  // PAIRED DEVICES ONLY when the shop has switched that on (see _device-auth.js); otherwise no change
  const deviceDenied = await deviceGuard(request, env, license.clientId, corsHeadersFor(request, env));
  if (deviceDenied) return deviceDenied;

  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

  await saveShaConfig(env, license.clientId, body);
  return jsonResponse({ ok: true });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const license = await requireValidLicense(request, env);
  if (!license.valid) return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);
  // PAIRED DEVICES ONLY when the shop has switched that on (see _device-auth.js); otherwise no change
  const deviceDenied = await deviceGuard(request, env, license.clientId, corsHeadersFor(request, env));
  if (deviceDenied) return deviceDenied;

  await clearShaConfig(env, license.clientId);
  return jsonResponse({ ok: true });
}
