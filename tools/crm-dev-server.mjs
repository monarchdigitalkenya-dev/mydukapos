// zip 161: serves /crm/ (static, the way Cloudflare Pages does: ETag + revalidate, plus whatever /_headers says for /crm/*) and /api/crm/* (the REAL router on a SQLite
// D1 fake filled with the big dataset) so the page can be measured in a real browser.  node tools/crm-dev-server.mjs --port 8901 [--root <dir>] [--latency 0] [--small]
//   --latency N   adds N ms to every D1 round trip (models the network hop to D1; 0 = none). A MODEL, not a measurement of Cloudflare.
//   Gzip is applied to text answers like the Cloudflare edge does. Prints tokens as JSON on the first line (owner-tok, manager, sales).
import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.resolve(opt('root', path.join(HERE, '..'))), PORT = Number(opt('port', 8901)), LAT = Number(opt('latency', 0));
const T = pathToFileURL(path.join(HERE, '..', 'tests')).href + '/';
const { makeD1 } = await import(T + 'd1-fake.mjs'); const { makeKV } = await import(T + 'kv-fake.mjs'); const { bigDataset, countingDb } = await import(T + 'crm-bigdata.mjs');
const router = await import(pathToFileURL(path.join(ROOT, 'functions/api/_crm/router.js')).href);
const kv = makeKV(); kv.data.set('owner-session:owner-tok', { value: '1' });
kv.data.set('owner-account:v1', { value: JSON.stringify({ identifier: 'owner@myduka.test', salt: 'ab'.repeat(8), passwordHash: 'cd'.repeat(32), ownerClientId: 'O', createdAt: 1 }) });
const raw = makeD1(); const db = countingDb(raw);
if (LAT > 0) { const inner = db.prepare; const wrapTimed = (o) => o; /* latency is added per trip below */ }
const env = { LEDGER_DB: db, mydukapos_kv: kv, CRM_SESSION_SECRET: 'dev-secret' };
const call = async (m, p, o = {}) => { const h = { Authorization: 'Bearer ' + (o.token || 'owner-tok') }; let body; if (o.body) { body = JSON.stringify(o.body); h['content-type'] = 'application/json'; } const r = await router.handle({ request: new Request('http://localhost' + '/api/crm' + p, { method: m, headers: h, body }), env }); return { s: r.status, t: await r.text() }; };
await call('GET', '/me'); const toks = { owner: 'owner-tok' };
for (let i = 0; i < 10; i++) { const r = JSON.parse((await call('POST', '/staff', { body: { name: (i ? 'Sales ' : 'Manager ') + i, email: `s${i}@x.test`, phone: '0711' + (100000 + i), role: i ? 'sales' : 'manager' } })).t); const a = JSON.parse((await call('POST', '/auth/invite/accept', { body: { token: new URL(r.inviteLink).searchParams.get('invite'), password: 'Passw0rd-' + i } })).t); if (i === 0) toks.manager = a.token; if (i === 1) toks.sales = a.token; }
const ds = bigDataset({ db: raw, q: (s, ...a) => raw.query(s, ...a) }, args.includes('--small') ? { leads: 300, activities: 1000, conversations: 100, messages: 1000 } : {});
if (LAT > 0) { const origBatch = db.batch; db.batch = async (l) => { await new Promise((r) => setTimeout(r, LAT)); return origBatch(l); }; const op = db.prepare; db.prepare = (sql) => { const s = op(sql); for (const k of ['run', 'all', 'first', 'raw']) { const f = s[k].bind(s); s[k] = async (...a) => { await new Promise((r) => setTimeout(r, LAT)); return f(...a); }; } const b = s.bind.bind(s); s.bind = (...a) => { const s2 = b(...a); for (const k of ['run', 'all', 'first', 'raw']) { const f = s2[k].bind(s2); s2[k] = async (...x) => { await new Promise((r) => setTimeout(r, LAT)); return f(...x); }; } return s2; }; return s; }; }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const headerRules = () => { try { const out = []; let cur = null; for (const line of fs.readFileSync(path.join(ROOT, '_headers'), 'utf8').split('\n')) { if (!line.trim() || line.trim().startsWith('#')) continue; if (!/^\s/.test(line)) { cur = { pat: line.trim(), h: {} }; out.push(cur); } else if (cur) { const i = line.indexOf(':'); cur.h[line.slice(0, i).trim()] = line.slice(i + 1).trim(); } } return out; } catch (e) { return []; } };
const rules = headerRules();
const globMatch = (pat, p) => new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(p);
const send = (req, res, status, headers, body) => {
  const ae = String(req.headers['accept-encoding'] || ''); const ct = String(headers['content-type'] || '');
  if (body && /gzip/.test(ae) && /text|json|javascript|svg|manifest/.test(ct) && body.length > 200) { body = zlib.gzipSync(body); headers['content-encoding'] = 'gzip'; }
  headers['content-length'] = body ? body.length : 0; res.writeHead(status, headers); res.end(body);
};
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/__stats') { const s = db.stats; return send(req, res, 200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ trips: s.trips, stmts: s.stmts })) ); }
    if (u.pathname === '/__tokens') return send(req, res, 200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(toks)));
    if (u.pathname === '/__reset') { db.reset(); return send(req, res, 200, { 'content-type': 'text/plain' }, Buffer.from('ok')); }
    if (u.pathname.startsWith('/api/crm')) {
      let body = ''; for await (const c of req) body += c;
      const t0 = performance.now(); const before = db.stats.trips;
      const r = await router.handle({ request: new Request('http://localhost' + req.url, { method: req.method, headers: { authorization: req.headers.authorization || '', 'content-type': 'application/json' }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env });
      const buf = Buffer.from(await r.arrayBuffer()); const h = { 'content-type': r.headers.get('content-type') || 'application/json', 'cache-control': r.headers.get('cache-control') || 'no-store', 'server-timing': r.headers.get('server-timing') || `app;dur=${(performance.now() - t0).toFixed(0)}`, 'x-d1-trips': String(db.stats.trips - before) };
      return send(req, res, r.status, h, buf);
    }
    let p = u.pathname.replace(/^\/crm\/?/, '') || 'index.html'; if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, 'crm', p);
    if (!u.pathname.startsWith('/crm') || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('not found'); }
    const buf = fs.readFileSync(f); const etag = '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"';
    const h = { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', etag, 'cache-control': 'public, max-age=0, must-revalidate' };
    for (const r of rules) if (globMatch(r.pat, u.pathname)) Object.assign(h, Object.fromEntries(Object.entries(r.h).map(([k, v]) => [k.toLowerCase(), v])));
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': h['cache-control'] }); return res.end(); }
    return send(req, res, 200, h, buf);
  } catch (e) { console.error(e); res.writeHead(500); res.end(String(e && e.stack)); }
}).listen(PORT, () => console.log(JSON.stringify({ port: PORT, tokens: toks, seedMs: ds.ms, root: ROOT })));
