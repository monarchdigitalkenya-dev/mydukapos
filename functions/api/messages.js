// functions/api/messages.js — the owner's messages for THIS shop (the apps show them). zip 148.
//   GET /api/messages?c=<link>  -> { messages: [...] }   published, in their time window, and addressed to this shop (by its id or its
//                                                          app — both read from the shop's licence record here, never from the request)
import { resolveClientId, getLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { listMessages, messageForShop, shopView } from './_messages.js';

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  const clientId = await resolveClientId(request, env);
  const record = clientId ? await getLicense(env, clientId) : null;
  if (!record) return json({ messages: [] }, 200);          // an unknown link simply has no messages
  const product = record.product || 'shop';
  const now = Date.now();
  const mine = (await listMessages(env)).filter((m) => messageForShop(m, record.id, product, now)).map(shopView);
  return json({ messages: mine, serverNow: now });
}
