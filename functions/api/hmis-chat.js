// functions/api/hmis-chat.js - in-facility staff chat (zip 359). Staff only (licence, device and staff-session guards).
//   POST {action:'poll', since, channels[]} -> {ok, msgs[], max}      POST {action:'send', channel, text} -> {ok, id}
//   POST {action:'upload', name, mime, data(base64)} -> {ok, fid}      POST {action:'file', fid} -> {ok, name, mime, data}   (shared documents, zip 367)
// Channels: 'all' (everyone), 'd:<desk>' (a department, e.g. d:laboratory), 'dm:<idA>|<idB>' (two staff; only those two can read it).
// Messages live in the ledger database (table is created on first use; migrations/0020_chat.sql is only a safety net). With no database bound
// it falls back to one KV list. Nothing patient-clinical is required in a message; staff are reminded to send only what the other desk needs.
import { requireValidLicense } from './_license.js';
import { corsHeadersFor } from './_cors.js';
import { deviceGuard } from './_device-auth.js';
import { staffGuard } from './_staff-auth.js';

const DDL = ['CREATE TABLE IF NOT EXISTS chat_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, ch TEXT NOT NULL, from_id TEXT NOT NULL, from_name TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL)', 'CREATE INDEX IF NOT EXISTS idx_chat_ch ON chat_msgs (ch, id)', 'CREATE INDEX IF NOT EXISTS idx_chat_from ON chat_msgs (from_id, ts)'];
const KEEP_MS = 14 * 864e5, FIRST_MS = 3 * 864e5, MAX_TEXT = 1000;
const db = (env) => (env && env.LEDGER_DB) || null;
const kv = (env) => env && env.mydukapos_kv;
const CH_RE = /^(all|d:[a-z0-9-]{2,24}|dm:[A-Za-z0-9_-]{1,40}\|[A-Za-z0-9_-]{1,40})$/;

export async function onRequestOptions(context) { return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) }); }

function allowed(ch, me) { if (!CH_RE.test(ch)) return false; if (ch.startsWith('dm:')) return ch.slice(3).split('|').includes(me); return true; }
async function ensure(d) { for (const s of DDL) await d.exec(s); }

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  const license = await requireValidLicense(request, env);
  if (!license.valid) return reply({ error: 'This link is not active.' }, 403);
  const denied = await deviceGuard(request, env, license.clientId, cors); if (denied) return denied;
  const sg = await staffGuard(request, env, license.clientId, null, cors); if (sg.denied) return sg.denied;
  const me = String((sg.claims && sg.claims.sid) || 'admin'), myName = String((sg.claims && sg.claims.name) || 'Admin').slice(0, 60);
  let body; try { body = await request.json(); } catch (e) { return reply({ error: 'Invalid JSON body' }, 400); }
  const d = db(env), a = body && body.action;

  if (a === 'send') {
    const ch = String(body.channel || ''), text = String(body.text || '').replace(/\s+$/g, '').slice(0, MAX_TEXT);
    if (!allowed(ch, me)) return reply({ error: 'That conversation is not available.' }, 403);
    if (!text.trim()) return reply({ error: 'Type a message first.' }, 400);
    const now = Date.now();
    if (d) {
      const run = async () => {
        const recent = await d.prepare('SELECT COUNT(*) AS n FROM chat_msgs WHERE from_id = ?1 AND ts > ?2').bind(me, now - 60000).first();
        if (recent && Number(recent.n) >= 40) return reply({ error: 'Too many messages in a minute. Please wait a moment.' }, 429);
        const r = await d.prepare('INSERT INTO chat_msgs (ch, from_id, from_name, text, ts) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id').bind(ch, me, myName, text, now).first();
        if (Math.random() < 0.03) { try { await d.prepare('DELETE FROM chat_msgs WHERE ts < ?1').bind(now - KEEP_MS).run(); } catch (e) { /* later */ } }
        return reply({ ok: true, id: r && r.id, ts: now });
      };
      try { return await run(); } catch (e) { if (!/no such table/i.test(String(e && e.message))) return reply({ error: 'Could not send.' }, 500); try { await ensure(d); return await run(); } catch (e2) { return reply({ error: 'Could not send.' }, 500); } }
    }
    if (!kv(env)) return reply({ error: 'Chat is not available.' }, 503);
    let st; try { st = JSON.parse(await kv(env).get('chat:log') || 'null'); } catch (e) { st = null; }
    st = st || { seq: 0, msgs: [] }; st.seq += 1; st.msgs.push({ id: st.seq, ch, fromId: me, from: myName, text, ts: now });
    st.msgs = st.msgs.filter((m) => m.ts > now - KEEP_MS).slice(-400);
    await kv(env).put('chat:log', JSON.stringify(st));
    return reply({ ok: true, id: st.seq, ts: now });
  }

  if (a === 'poll') {
    const since = Math.max(0, Number(body.since) || 0);
    const chans = (Array.isArray(body.channels) ? body.channels : []).map(String).filter((c) => allowed(c, me)).slice(0, 60);
    if (!chans.includes('all')) chans.push('all');
    if (d) {
      const q = async () => {
        const ph = chans.map((_, i) => '?' + (i + 3)).join(',');
        const sql = since ? `SELECT id, ch, from_id, from_name, text, ts FROM chat_msgs WHERE id > ?1 AND ts > ?2 AND ch IN (${ph}) ORDER BY id LIMIT 300` : `SELECT id, ch, from_id, from_name, text, ts FROM chat_msgs WHERE id > ?1 AND ts > ?2 AND ch IN (${ph}) ORDER BY id DESC LIMIT 300`;
        const rs = await d.prepare(sql).bind(since, Date.now() - (since ? KEEP_MS : FIRST_MS), ...chans).all();
        let rows = (rs && rs.results) || []; if (!since) rows = rows.reverse();
        return rows.map((r) => ({ id: r.id, ch: r.ch, fromId: r.from_id, from: r.from_name, text: r.text, ts: r.ts }));
      };
      let msgs;
      try { msgs = await q(); } catch (e) { if (!/no such table/i.test(String(e && e.message))) return reply({ error: 'Chat is unavailable.' }, 500); try { await ensure(d); msgs = []; } catch (e2) { return reply({ error: 'Chat is unavailable.' }, 500); } }
      return reply({ ok: true, msgs, max: msgs.length ? msgs[msgs.length - 1].id : since, me });
    }
    if (!kv(env)) return reply({ error: 'Chat is not available.' }, 503);
    let st; try { st = JSON.parse(await kv(env).get('chat:log') || 'null'); } catch (e) { st = null; }
    st = st || { seq: 0, msgs: [] };
    const msgs = st.msgs.filter((m) => m.id > since && chans.includes(m.ch)).slice(-300);
    return reply({ ok: true, msgs, max: msgs.length ? msgs[msgs.length - 1].id : since, me });
  }
  /* ---- shared documents (zip 367): a file is stored once, the message carries only its id. Up to ~900 KB each, kept 14 days. ---- */
  if (a === 'upload') {
    const name = String(body.name || 'document').replace(/[\u0000-\u001f<>|\\/]/g, '').slice(0, 120) || 'document';
    const mime = String(body.mime || 'application/octet-stream').replace(/[^A-Za-z0-9.+\/-]/g, '').slice(0, 80) || 'application/octet-stream';
    const data = String(body.data || '');
    if (!/^[A-Za-z0-9+/=]+$/.test(data) || data.length < 8) return reply({ error: 'That file could not be read.' }, 400);
    if (data.length > 1250000) return reply({ error: 'That file is too big to share (limit about 900 KB). Send a smaller or compressed copy.' }, 413);
    const fid = Array.from(crypto.getRandomValues(new Uint8Array(12))).map((x) => (x % 36).toString(36)).join('') + Date.now().toString(36), now = Date.now();
    if (d) {
      const run = async () => {
        const recent = await d.prepare('SELECT COUNT(*) AS n FROM chat_files WHERE from_id = ?1 AND ts > ?2').bind(me, now - 60000).first();
        if (recent && Number(recent.n) >= 10) return reply({ error: 'Too many files in a minute. Please wait a moment.' }, 429);
        await d.prepare('INSERT INTO chat_files (id, from_id, name, mime, data, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(fid, me, name, mime, data, now).run();
        if (Math.random() < 0.05) { try { await d.prepare('DELETE FROM chat_files WHERE ts < ?1').bind(now - KEEP_MS).run(); } catch (e) { /* later */ } }
        return reply({ ok: true, fid });
      };
      const mk = 'CREATE TABLE IF NOT EXISTS chat_files (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL)';
      try { return await run(); } catch (e) { if (!/no such table/i.test(String(e && e.message))) return reply({ error: 'Could not share the file.' }, 500); try { await d.exec(mk); return await run(); } catch (e2) { return reply({ error: 'Could not share the file.' }, 500); } }
    }
    if (!kv(env)) return reply({ error: 'Chat is not available.' }, 503);
    await kv(env).put('chat:file:' + fid, JSON.stringify({ name, mime, data }), { expirationTtl: 14 * 86400 });
    return reply({ ok: true, fid });
  }
  if (a === 'file') {
    const fid = String(body.fid || '');
    if (!/^[a-z0-9]{10,40}$/.test(fid)) return reply({ error: 'File not found.' }, 404);
    if (d) {
      try { const r = await d.prepare('SELECT name, mime, data FROM chat_files WHERE id = ?1').bind(fid).first(); if (r) return reply({ ok: true, name: r.name, mime: r.mime, data: r.data }); } catch (e) { /* not there */ }
      return reply({ error: 'That file is no longer available (files are kept for 14 days).' }, 404);
    }
    if (!kv(env)) return reply({ error: 'Chat is not available.' }, 503);
    let f; try { f = JSON.parse(await kv(env).get('chat:file:' + fid) || 'null'); } catch (e) { f = null; }
    return f ? reply({ ok: true, name: f.name, mime: f.mime, data: f.data }) : reply({ error: 'That file is no longer available (files are kept for 14 days).' }, 404);
  }
  return reply({ error: 'Unknown action' }, 400);
}
