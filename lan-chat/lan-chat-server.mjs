// Cherish Healthcare - LAN chat server (works with NO internet)
// Run on ONE computer in the clinic:  node lan-chat\lan-chat-server.mjs      (or double-click lan-chat\START_LAN_CHAT.cmd)
// Other computers/phones on the same Wi-Fi or cable open  http://<this-computer's-address>:8787/hospital/
// Staff chat then works inside the building even when the internet is down. Messages are kept for 14 days
// in lan-chat-data.json next to this file (the lan-chat folder is never uploaded to the website). No packages to install - only Node.js.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');   // the app folder (hospital/, icons/ ...) one level up
const PORT = Number(process.env.PORT) || 8787;
const DATA = path.join(HERE, 'lan-chat-data.json');
const KEEP = 14 * 864e5, FIRST = 3 * 864e5, MAX_TEXT = 1000;
const CH_RE = /^(all|d:[a-z0-9-]{2,24}|dm:[A-Za-z0-9_-]{1,40}\|[A-Za-z0-9_-]{1,40})$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };

let db = { seq: 0, msgs: [], files: {} };
try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { /* first run */ }
if (!db.files) db.files = {};
let dirty = false;
const save = () => { if (!dirty) return; dirty = false; try { fs.writeFileSync(DATA, JSON.stringify(db)); } catch (e) { console.log('Could not save chat file:', e.message); } };
setInterval(save, 3000).unref();
const sweep = () => { const cut = Date.now() - KEEP, n = db.msgs.length; db.msgs = db.msgs.filter((m) => m.ts > cut); if (db.msgs.length !== n) dirty = true; Object.keys(db.files).forEach((k) => { if (db.files[k].ts < cut) { delete db.files[k]; dirty = true; } }); };
sweep(); setInterval(sweep, 3600e3).unref();

const json = (res, code, obj, req) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': (req && req.headers['access-control-request-headers']) || '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600' }); res.end(code === 204 ? undefined : JSON.stringify(obj)); };
const allowed = (ch, me) => CH_RE.test(ch) && (!ch.startsWith('dm:') || ch.slice(3).split('|').includes(me));
const rate = new Map();

function chat(body) {
  const w = body.who || {}, me = String(w.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40), name = String(w.name || 'Staff').replace(/[<>]/g, '').slice(0, 60) || 'Staff';
  if (!me) return [400, { error: 'Open the app and sign in first.' }];
  if (body.action === 'send') {
    const ch = String(body.channel || ''), text = String(body.text || '').replace(/\s+$/g, '').slice(0, MAX_TEXT);
    if (!text) return [400, { error: 'Type a message first.' }];
    if (!allowed(ch, me)) return [403, { error: 'You cannot post in that conversation.' }];
    const now = Date.now(), r = (rate.get(me) || []).filter((t) => now - t < 60e3);
    if (r.length >= 40) return [429, { error: 'Slow down a little - too many messages in a minute.' }];
    r.push(now); rate.set(me, r);
    const m = { id: ++db.seq, ch, fromId: me, from: name, text, ts: now };
    db.msgs.push(m); dirty = true;
    return [200, { ok: true, id: m.id, ts: m.ts }];
  }
  if (body.action === 'poll') {
    const since = Math.max(0, Number(body.since) || 0);
    const chans = new Set((Array.isArray(body.channels) ? body.channels : []).map(String).filter((c) => allowed(c, me)).slice(0, 60)); chans.add('all');
    let rows = db.msgs.filter((m) => chans.has(m.ch) && (since ? m.id > since : m.ts > Date.now() - FIRST));
    if (!since) rows = rows.slice(-300);
    return [200, { ok: true, msgs: rows.slice(0, 300), max: rows.length ? rows[rows.length - 1].id : since, me, lan: true }];
  }
  if (body.action === 'upload') {
    const name = String(body.name || 'document').replace(/[\u0000-\u001f<>|\\/]/g, '').slice(0, 120) || 'document', mime = String(body.mime || 'application/octet-stream').replace(/[^A-Za-z0-9.+\/-]/g, '').slice(0, 80), data = String(body.data || '');
    if (!/^[A-Za-z0-9+/=]+$/.test(data) || data.length < 8) return [400, { error: 'That file could not be read.' }];
    if (data.length > 1250000) return [413, { error: 'That file is too big to share (limit about 900 KB).' }];
    const fid = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    db.files[fid] = { name, mime, data, ts: Date.now() }; dirty = true;
    return [200, { ok: true, fid }];
  }
  if (body.action === 'file') {
    const f = db.files[String(body.fid || '')];
    return f ? [200, { ok: true, name: f.name, mime: f.mime, data: f.data }] : [404, { error: 'That file is no longer available.' }];
  }
  return [400, { error: 'Unknown request.' }];
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return json(res, 204, {}, req);
  if (url.pathname === '/api/hmis-chat') {
    if (req.method !== 'POST') return json(res, 200, { ok: true, lan: true });
    let raw = ''; req.on('data', (c) => { raw += c; if (raw.length > 1400000) req.destroy(); });
    req.on('end', () => { let b = {}; try { b = JSON.parse(raw || '{}'); } catch (e) { /* ignore */ } const [c, o] = chat(b); json(res, c, o); });
    return;
  }
  if (url.pathname.startsWith('/api/')) return json(res, 503, { error: 'offline', lan: true });   // the internet services are not reachable from here
  // static files from the app folder
  let p = decodeURIComponent(url.pathname); if (p.endsWith('/')) p += 'index.html';
  let f = path.normalize(path.join(ROOT, p));
  if (!f.startsWith(ROOT) || /node_modules|[\\/]\.git|lan-chat|[\\/]functions[\\/]|[\\/]migrations|[\\/]tools[\\/]|wrangler|\.env/i.test(f)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(f, (e, st) => {
    if (!e && st.isDirectory()) f = path.join(f, 'index.html');
    fs.readFile(f, (e2, buf) => {
      if (e2) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      const ext = path.extname(f).toLowerCase();
      if (ext === '.html' && /[\\/]hospital[\\/]index\.html$/.test(f)) buf = Buffer.from(buf.toString('utf8').replace('<head>', '<head><script>window.__HMIS_LAN=1;</script>'));
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(buf);
    });
  });
});
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  CHERISH HEALTHCARE - LAN CHAT SERVER IS RUNNING\n  Keep this window open. On any computer or phone on the same network open:\n');
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((k) => (nets[k] || []).forEach((n) => { if (n.family === 'IPv4' && !n.internal) console.log('     http://' + n.address + ':' + PORT + '/hospital/'); }));
  console.log('\n  (this computer: http://localhost:' + PORT + '/hospital/ )\n');
});
server.on('error', (e) => { console.log(e.code === 'EADDRINUSE' ? 'Port ' + PORT + ' is already in use - is the LAN chat server already running?' : e.message); process.exit(1); });
process.on('SIGINT', () => { save(); process.exit(0); });
