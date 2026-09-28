// functions/api/owner-messages.js — Owner Console ▸ 📣 Messages. Owner only. zip 148.
//   GET                                          -> { messages: [...] }
//   POST { action: 'save', message }             -> create (no id, as a draft) or edit
//   POST { action: 'publish' | 'archive' | 'delete', id }
import { requireOwnerAuth } from './_owner-auth.js';
import { listMessages, saveMessages, cleanMessage } from './_messages.js';

const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function onRequestGet(context) {
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  return json({ messages: await listMessages(context.env) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid request body.' }, 400); }
  const list = await listMessages(env);
  if (body.action === 'save') {
    const input = body.message || {};
    if (input.id) {
      const i = list.findIndex((m) => m.id === input.id);
      if (i < 0) return json({ error: 'That message no longer exists.' }, 404);
      list[i] = { ...cleanMessage(input, list[i]), updatedAt: Date.now() };
      if (!list[i].title.trim() && !list[i].body.trim()) return json({ error: 'Write a title or a message.' }, 400);
      await saveMessages(env, list);
      return json({ message: list[i] });
    }
    const m = { ...cleanMessage(input), id: 'msg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16), status: 'draft', createdAt: Date.now(), updatedAt: Date.now() };
    if (!m.title.trim() && !m.body.trim()) return json({ error: 'Write a title or a message.' }, 400);
    list.push(m);
    await saveMessages(env, list);
    return json({ message: m });
  }
  const i = list.findIndex((m) => m.id === body.id);
  if (i < 0) return json({ error: 'That message no longer exists.' }, 404);
  const m = list[i];
  if (body.action === 'publish') { m.status = 'published'; m.publishedAt = Date.now(); }
  else if (body.action === 'archive') { m.status = 'archived'; m.archivedAt = Date.now(); }
  else if (body.action === 'delete') {
    if (m.status === 'published') return json({ error: 'Archive it first (it is being shown now).' }, 409);
    list.splice(i, 1);
    await saveMessages(env, list);
    return json({ ok: true });
  } else return json({ error: 'Unknown action.' }, 400);
  m.updatedAt = Date.now();
  await saveMessages(env, list);
  return json({ message: m });
}
