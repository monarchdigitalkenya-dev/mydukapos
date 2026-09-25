// functions/api/sha-claim-submit.js — Cloudflare Pages Function
//
// Submits ONE existing claim (already tracked in Insurance / Institutions ->
// claims, keyed by claimId from the hospital app's own claim record) to the
// facility's own SHA/DHA AfyaConnect eClaims endpoint, using the credentials
// saved in sha-config.js.
//
// IMPORTANT — read before relying on this in production:
// The payload below is a best-effort FHIR R4 Claim inside a Bundle, built
// from the public Kenya eClaims Implementation Guide
// (build.fhir.org/ig/IntelliSOFT-Consulting/Kenya-eClaims-FHIR-IG). It has
// NOT been validated against DHA's live schema or run through their
// required sandbox/UAT certification. DHA certification is mandatory before
// a facility can submit live claims at all, and that certification process
// is exactly where payload shape gets confirmed — so treat this as a
// starting point to test and adjust once the facility has real sandbox
// access, not as a finished, certified integration.
//
// This endpoint NEVER decides the claim was approved/rejected/paid on the
// caller's behalf — it only records what SHA's own API literally returned
// (including the raw response body) and leaves the claim's status to be
// moved by hand, through the existing claim-status buttons, exactly as
// before. A 200 from this endpoint means "SHA accepted the submission for
// processing", not "the claim was approved".
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { loadShaConfig, shaAccessToken, hasShaConfig } from './_sha-config.js';
import { requireValidLicense } from './_license.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function buildClaimBundle(claim, patient, cfg) {
  const now = new Date().toISOString();
  const patientIdentifiers = [];
  if (patient && patient.shaNumber) patientIdentifiers.push({ system: 'https://dha.go.ke/identifiers/sha-number', value: patient.shaNumber });
  if (patient && patient.nationalId) patientIdentifiers.push({ system: 'https://dha.go.ke/identifiers/national-id', value: patient.nationalId });

  const claimResource = {
    resourceType: 'Claim',
    identifier: [{ system: 'https://mydukapos.example/claim-no', value: claim.claimNo }],
    status: 'active',
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'institutional' }] },
    use: 'claim',
    patient: { identifier: patientIdentifiers[0] || undefined, display: claim.patientName || undefined },
    created: now,
    provider: { identifier: { system: 'https://dha.go.ke/identifiers/facility-code', value: cfg.shaFacilityCode } },
    priority: { coding: [{ code: 'normal' }] },
    insurance: [{ sequence: 1, focal: true, coverage: { display: 'SHA / SHIF' } }],
    item: [{
      sequence: 1,
      productOrService: { text: claim.description || 'Hospital services' },
      unitPrice: { value: Number(claim.amount) || 0, currency: 'KES' },
      net: { value: Number(claim.amount) || 0, currency: 'KES' },
    }],
    total: { value: Number(claim.amount) || 0, currency: 'KES' },
  };
  if (claim.policyNo) claimResource.insurance[0].preAuthRef = [claim.policyNo];
  if (claim.preAuthCode) claimResource.insurance[0].preAuthRef = [...(claimResource.insurance[0].preAuthRef || []), claim.preAuthCode];

  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{ resource: claimResource }],
  };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const license = await requireValidLicense(request, env);
  if (!license.valid) return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403);

  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
  const { claim, patient } = body || {};
  if (!claim || !claim.claimNo || !(Number(claim.amount) > 0)) return jsonResponse({ error: 'A claim with a claim number and amount is required.' }, 400);

  const cfg = await loadShaConfig(env, license.clientId);
  if (!hasShaConfig(cfg)) return jsonResponse({ ok: false, error: 'SHA credentials are not set up yet (Settings → Insurance → SHA).' });
  if (!cfg.shaBaseUrl) return jsonResponse({ ok: false, error: 'Enter the SHA API base URL first (given to you with your credentials).' });

  let token;
  try {
    token = await shaAccessToken(env, license.clientId, cfg);
  } catch (e) {
    return jsonResponse({ ok: false, error: String(e && e.message || e) });
  }

  const bundle = buildClaimBundle(claim, patient, cfg);
  const submitUrl = cfg.shaBaseUrl.replace(/\/+$/, '') + '/fhir/Bundle';
  let res, text;
  try {
    res = await fetch(submitUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/fhir+json' },
      body: JSON.stringify(bundle),
    });
    text = await res.text();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'Could not reach the SHA API — check the base URL and connection.' });
  }

  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { /* not JSON — keep the raw text */ }
  const dhaClaimResponseId = parsed && parsed.id;
  const rawSnippet = (text || '').slice(0, 2000);

  if (!res.ok) {
    return jsonResponse({ ok: false, error: `SHA rejected the submission (HTTP ${res.status}).`, raw: rawSnippet });
  }
  return jsonResponse({ ok: true, dhaClaimResponseId: dhaClaimResponseId || null, raw: rawSnippet, submittedAt: Date.now() });
}
