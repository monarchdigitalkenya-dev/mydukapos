// functions/api/owner-notice.js — POST: the admin dismissed the owner's payment reminder.
//
// Public in the same way license-status is (the link itself identifies the shop). Only marks THIS reminder as seen (by its id), so a newer
// reminder sent meanwhile is never swallowed. Once seen it stops being returned by license-status on every device, and the owner sees
// "seen" against it in the Bills tab.

import { resolveClientId, getLicense, saveLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';

function jsonResponse(body, status = 200, cors = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid request body.' }, 400, cors); }
  const clientId = await resolveClientId(request, env);
  const record = clientId ? await getLicense(env, clientId) : null;
  if (!record) return jsonResponse({ error: 'Link not found.' }, 404, cors);
  if (record.notice && record.notice.id === body.id && !record.notice.ackAt) {
    record.notice.ackAt = Date.now();
    await saveLicense(env, record);
  }
  return jsonResponse({ ok: true }, 200, cors);
}
