// wildcard-router/shop-store.js — the per-shop database (SQLite-backed Durable Object).
//
// WHY: until now a shop was ONE JSON value in KV. Every push had to read, parse, merge and rewrite the WHOLE shop, which puts
// a hard ceiling on how big a shop can be (measured: ~6-8x its size in memory per push, 128 MB limit -> ~12 MB) and is why
// old history had to be archived away. Here a shop is ROWS in its own SQLite database, owned by exactly one Durable Object
// (one writer, so no lost updates):
//
//   core    (k, v)                          small scalar settings (businessName, password hashes, receipt text, ...)
//   records (col, rk, ts, upd, pos, seq,    every merge-by-id collection (inventory, staff, customers, salesLog,
//            code, json)                    stockMovementLog, ...): one row per record
//
// A push touches only the rows it carries, so its cost follows the size of the PUSH, not the size of the shop. History is
// never archived away: it stays in the database (a Durable Object may hold up to 10 GB), and a device asks only for what it
// needs (`state` = recent "hot window" of the big logs + everything else; `changes` = only rows changed since a cursor;
// `history` = any date range, paged).
//
// The merge rules are NOT re-implemented: they are the same functions the KV backend uses (functions/api/_merge.js), so the
// two backends must give identical results — tests/shop-store.test.mjs runs both side by side to prove it.
//
// Talks to the Pages Function (functions/api/pos-sync.js) over fetch(): POST /push /state /changes /history /import /export /stats.

import {
  MERGE_BY_ID_FIELDS, NEVER_BLANK_FIELDS, isBlank, recordKey, correctClockDrift, reconcileQuantities,
} from '../functions/api/_merge.js';
import { ARCHIVE_LOG_FIELDS, recordTime } from '../functions/api/_state-store.js';

const LOGS = new Set(ARCHIVE_LOG_FIELDS);
const QTY_COLLECTIONS = ['inventory', 'products'];
const DEFAULT_HOT_DAYS = 120;

export class ShopStore {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
    this.sql = state.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS core (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS records (
      col TEXT NOT NULL, rk TEXT NOT NULL, ts INTEGER NOT NULL DEFAULT 0, upd INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL, seq INTEGER NOT NULL, code TEXT, json TEXT NOT NULL, PRIMARY KEY (col, rk))`);
    // `del` = 1 for a tombstone (a record a device deleted): kept so a stale copy can't bring it back, but never sent to devices.
    // Databases created before this column existed get it added in place.
    if (!this.q('PRAGMA table_info(records)').some((c) => c.name === 'del')) {
      this.sql.exec('ALTER TABLE records ADD COLUMN del INTEGER NOT NULL DEFAULT 0');
    }
    this.sql.exec('CREATE INDEX IF NOT EXISTS records_time ON records (col, ts)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS records_seq ON records (seq)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS records_code ON records (col, code)');
    const m = this.q('SELECT MAX(seq) AS s, MAX(pos) AS p FROM records')[0] || {};
    this.seq = m.s || 0;
    this.pos = m.p || 0;
  }

  q(sql, ...binds) { return this.sql.exec(sql, ...binds).toArray(); }
  tx(fn) { return this.state.storage.transactionSync ? this.state.storage.transactionSync(fn) : fn(); }

  /* ---------- core ---------- */
  getCoreText() {
    const out = {};
    for (const r of this.q('SELECT k, v FROM core')) out[r.k] = r.v;
    return out;                                        // key -> JSON text
  }
  getCore() {
    const out = {};
    for (const [k, v] of Object.entries(this.getCoreText())) { try { out[k] = JSON.parse(v); } catch (e) { /* skip */ } }
    return out;
  }
  setCore(k, val, existingText) {
    const text = JSON.stringify(val === undefined ? null : val);
    if (existingText === text) return;
    this.sql.exec('INSERT INTO core (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, text);
  }

  /* ---------- records ---------- */
  timeOf(col, r) {
    if (!LOGS.has(col)) return 0;
    const t = recordTime(r);
    return Number.isFinite(t) ? Math.floor(t) : 0;
  }
  getRow(col, rk) { return this.q('SELECT rk, upd, json FROM records WHERE col = ? AND rk = ?', col, rk)[0]; }

  // Same rule as mergeRecordsById: an incoming record replaces the stored one unless the stored one is strictly newer.
  upsert(col, rk, rec) {
    const upd = Number(rec && rec.updatedAt) || 0;
    const json = JSON.stringify(rec);
    const code = rec && rec.code != null ? String(rec.code) : null;
    const row = this.getRow(col, rk);
    if (!row) {
      this.sql.exec('INSERT INTO records (col, rk, ts, upd, pos, seq, code, json, del) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        col, rk, this.timeOf(col, rec), upd, ++this.pos, ++this.seq, code, json, rec && rec._deleted === true ? 1 : 0);
      return true;
    }
    if (upd >= (row.upd || 0) && row.json !== json) {
      this.sql.exec('UPDATE records SET ts = ?, upd = ?, seq = ?, code = ?, json = ?, del = ? WHERE col = ? AND rk = ?',
        this.timeOf(col, rec), upd, ++this.seq, code, json, rec && rec._deleted === true ? 1 : 0, col, rk);
      return true;
    }
    return false;
  }

  /* ---------- push ---------- */
  // body: the device's payload. Returns { updatedAt }.
  push(body, serverNow = Date.now(), { preserveUpdatedAt = false } = {}) {
    if (!preserveUpdatedAt) body = correctClockDrift(body, serverNow);
    return this.tx(() => {
      const prev = this.updatedAt() || 0;              // what the shop's record said BEFORE this push (the device uses it to know if it missed anything)
      const coreText = this.getCoreText();
      const existingCore = {};
      for (const [k, v] of Object.entries(coreText)) { try { existingCore[k] = JSON.parse(v); } catch (e) { /* skip */ } }

      // 1. scalar settings: last write wins, except that a push can never BLANK the protected ones, and a field that carries a
      //    stamp (`_fieldTimes`) is only replaced by an equal-or-newer stamp — the same rule as the single-record backend (_merge.js)
      const storedTimes = existingCore._fieldTimes || {};
      const sentTimes = body._fieldTimes || {};
      const times = { ...storedTimes };
      for (const [k, v] of Object.entries(body)) {
        if (k === 'updatedAt' || k === '_fieldTimes') continue;
        if (MERGE_BY_ID_FIELDS.includes(k) && Array.isArray(v)) continue;
        if (NEVER_BLANK_FIELDS.includes(k) && isBlank(v) && !isBlank(existingCore[k])) continue;
        const stored = storedTimes[k], sent = sentTimes[k];
        if (typeof stored === 'number' && !(typeof sent === 'number' && sent >= stored)) continue;
        if (typeof sent === 'number') times[k] = sent;
        this.setCore(k, v, coreText[k]);
      }
      if (Object.keys(times).length) this.setCore('_fieldTimes', times, coreText._fieldTimes);

      // 2. which stock codes does this push touch? (needed to reconcile quantities, see below)
      const codes = new Set();
      for (const col of QTY_COLLECTIONS) for (const r of body[col] || []) if (r && r.code != null) codes.add(String(r.code));
      for (const e of body.stockMovementLog || []) if (e && e.code != null && typeof e.delta === 'number' && e.delta) codes.add(String(e.code));
      const before = {};
      for (const col of QTY_COLLECTIONS) {
        before[col] = new Map();
        for (const code of codes) for (const row of this.q('SELECT json FROM records WHERE col = ? AND code = ?', col, code)) { const r = JSON.parse(row.json); before[col].set(String(r.code), r); }
      }

      // 3. merge every by-id collection, record by record
      for (const col of MERGE_BY_ID_FIELDS) {
        const arr = body[col];
        if (!Array.isArray(arr)) continue;
        let keyless = null;
        arr.forEach((rec, i) => {
          const k = recordKey(rec);
          if (k == null) { (keyless ||= []).push(rec); return; }
          this.upsert(col, k, rec);
        });
        if (keyless) {                                  // records with no id/code/token: the incoming ones replace the stored ones
          this.sql.exec("DELETE FROM records WHERE col = ? AND rk LIKE 'k:%'", col);
          keyless.forEach((rec, i) => this.upsert(col, 'k:' + i, rec));
        }
      }

      // 4. quantities: two tills each selling one unit while offline must remove TWO (see reconcileQuantities)
      if (codes.size) {
        for (const col of QTY_COLLECTIONS) {
          const existingArr = [...before[col].values()];
          const mergedArr = [];
          const log = [];
          for (const code of codes) {
            for (const row of this.q('SELECT rk, json FROM records WHERE col = ? AND code = ?', col, code)) mergedArr.push(JSON.parse(row.json));
            const prior = before[col].get(code);
            const cursor = prior && typeof prior._qtySyncedAt === 'number' ? prior._qtySyncedAt : null;
            const rows = cursor == null
              ? this.q('SELECT json FROM records WHERE col = ? AND code = ?', 'stockMovementLog', code)
              : this.q('SELECT json FROM records WHERE col = ? AND code = ? AND ts > ?', 'stockMovementLog', code, cursor);
            for (const r of rows) log.push(JSON.parse(r.json));
          }
          if (!mergedArr.length) continue;
          const reconciled = reconcileQuantities(existingArr, mergedArr, log);
          reconciled.forEach((rec, i) => { if (rec !== mergedArr[i]) this.upsert(col, recordKey(rec), { ...rec, updatedAt: mergedArr[i].updatedAt }); });
        }
      }

      const updatedAt = preserveUpdatedAt && Number(body.updatedAt) ? Number(body.updatedAt) : serverNow;
      this.setCore('updatedAt', updatedAt, coreText.updatedAt);
      return { updatedAt, prev };
    });
  }

  /* ---------- reads (JSON built from the stored text, never re-parsed: cheap on memory) ---------- */
  updatedAt() { const r = this.q("SELECT v FROM core WHERE k = 'updatedAt'")[0]; return r ? Number(JSON.parse(r.v)) || 0 : 0; }

  // The whole shop as the apps expect it, except that the big logs only carry their recent "hot window".
  // hotDays = null -> everything.
  stateText(hotDays) {
    const parts = [];
    for (const [k, v] of Object.entries(this.getCoreText())) parts.push(JSON.stringify(k) + ':' + v);
    const cutoff = hotDays == null ? null : Date.now() - hotDays * 86400000;
    for (const { col } of this.q('SELECT DISTINCT col FROM records')) {
      const rows = (LOGS.has(col) && cutoff != null)
        ? this.q('SELECT json FROM records WHERE col = ? AND del = 0 AND (ts = 0 OR ts >= ?) ORDER BY pos', col, cutoff)
        : this.q('SELECT json FROM records WHERE col = ? AND del = 0 ORDER BY pos', col);
      parts.push(JSON.stringify(col) + ':[' + rows.map((r) => r.json).join(',') + ']');
    }
    if (!parts.some((x) => x.startsWith('"updatedAt":'))) parts.unshift('"updatedAt":0');
    if (cutoff != null) parts.push('"_hotFrom":' + Math.floor(cutoff));      // the big logs above only start here; older history: /api/history
    return '{' + parts.join(',') + '}';
  }

  // Only what changed after `cursor` (a delta pull). The first call uses cursor 0 and returns everything.
  changesText(cursor) {
    const core = this.getCoreText();
    const cols = {};
    for (const r of this.q('SELECT col, json FROM records WHERE seq > ? ORDER BY seq', Number(cursor) || 0)) (cols[r.col] ||= []).push(r.json);
    const recs = Object.entries(cols).map(([c, rows]) => JSON.stringify(c) + ':[' + rows.join(',') + ']');
    const coreParts = Object.entries(core).map(([k, v]) => JSON.stringify(k) + ':' + v);
    return `{"cursor":${this.seq},"core":{${coreParts.join(',')}},"records":{${recs.join(',')}}}`;
  }

  // Any date range of a log, paged: { records, next }.
  history(col, from, to, limit = 500, after = null) {
    limit = Math.min(Math.max(1, Number(limit) || 500), 2000);
    const a = after ? [Number(after.ts), String(after.rk)] : [-1, ''];
    const rows = this.q(
      'SELECT rk, ts, json FROM records WHERE col = ? AND ts >= ? AND ts < ? AND (ts > ? OR (ts = ? AND rk > ?)) ORDER BY ts, rk LIMIT ?',
      col, Number(from) || 0, Number(to) || Number.MAX_SAFE_INTEGER, a[0], a[0], a[1], limit + 1);
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    return { records: page.map((r) => JSON.parse(r.json)), next: more ? { ts: page[page.length - 1].ts, rk: page[page.length - 1].rk } : null };
  }

  stats() {
    const cols = this.q('SELECT col, COUNT(*) AS n, SUM(LENGTH(json)) AS bytes, MIN(ts) AS oldest, MAX(ts) AS newest FROM records GROUP BY col');
    const core = this.q('SELECT SUM(LENGTH(v)) AS b FROM core')[0] || {};
    const total = cols.reduce((n, c) => n + (c.bytes || 0), 0) + (core.b || 0);
    return { collections: cols, coreBytes: core.b || 0, bytes: total, seq: this.seq, updatedAt: this.updatedAt() };
  }

  /* ---------- self-test ---------- */
  // Runs the whole life of a shop against THIS database using the REAL runtime, so the owner can prove on Cloudflare (one click in
  // the Owner Console) what my Node stand-in could only imitate. Refuses to run on a database that already holds data, and wipes
  // itself afterwards, so it can never touch a real shop (the Owner Console always calls it on a throw-away id).
  async selfTest() {
    if ((this.q('SELECT COUNT(*) AS n FROM records')[0] || {}).n > 0 || Object.keys(this.getCoreText()).length > 0) {
      return { ok: false, steps: [{ name: 'scratch database', ok: false, detail: 'this database already holds data — refusing to test on it' }] };
    }
    const steps = [];
    const step = async (name, fn, { soft = false } = {}) => {
      const t = Date.now();
      try { const detail = await fn(); steps.push({ name, ok: true, ms: Date.now() - t, detail: detail == null ? '' : String(detail) }); }
      catch (e) { steps.push({ name, ok: false, soft, ms: Date.now() - t, detail: String(e && e.message ? e.message : e) }); }
    };
    const must = (cond, msg) => { if (!cond) throw new Error(msg); };
    const day = 86400000, now = Date.now();
    const sale = (id, age) => ({ id, timestamp: new Date(now - age * day).toISOString(), paymentMethod: 'cash', note: 'x'.repeat(120) });

    await step('SQL works', () => { this.sql.exec("INSERT INTO core (k, v) VALUES ('t', '1')"); must(this.q("SELECT v FROM core WHERE k = 't'")[0].v === '1', 'read-back failed'); this.sql.exec("DELETE FROM core WHERE k = 't'"); });
    await step('transactions roll back', () => {
      must(typeof this.state.storage.transactionSync === 'function', 'storage.transactionSync is missing');
      try { this.state.storage.transactionSync(() => { this.sql.exec("INSERT INTO core (k, v) VALUES ('tx', '1')"); throw new Error('abort'); }); } catch (e) { /* expected */ }
      must(this.q("SELECT COUNT(*) AS n FROM core WHERE k = 'tx'")[0].n === 0, 'a failed transaction left its write behind');
    });
    await step('push + read back', () => {
      this.push({ businessName: 'Self-test', pwHash: 'h', inventory: [{ code: 'A', qty: 5, price: 9, updatedAt: 1 }], salesLog: [sale('old', 400), sale('new', 1)], staff: [{ id: 'u1', name: 'X', updatedAt: 1 }] }, now);
      const st = JSON.parse(this.stateText(null));
      must(st.businessName === 'Self-test' && st.inventory.length === 1 && st.salesLog.length === 2 && st.staff.length === 1, 'state read back does not match what was pushed');
      must(JSON.parse(this.stateText(120)).salesLog.length === 1, 'the recent window did not exclude the 400-day-old sale');
    });
    await step('two tills selling offline: stock falls by 2', async () => {
      // a real sale is stamped BEFORE the server sees it, so each movement is created a few ms after the previous push
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const mv = (id, delta) => ({ id, code: 'A', delta, timestamp: new Date().toISOString(), type: 'removed' });
      await sleep(8);
      this.push({ inventory: [{ code: 'A', qty: 4, price: 9, updatedAt: now + 10 }], stockMovementLog: [mv('m1', -1)] }, now + 20);
      await sleep(8);
      this.push({ inventory: [{ code: 'A', qty: 4, price: 9, updatedAt: now + 30 }], stockMovementLog: [mv('m2', -1)] }, now + 40);
      const q = JSON.parse(this.stateText(null)).inventory[0].qty;
      must(q === 3, `expected stock 3 after 5 - 1 - 1, got ${q}`);
    });
    await step('bulk load 5,000 sales, then one more', () => {
      const t0 = Date.now();
      this.push({ salesLog: Array.from({ length: 5000 }, (_, i) => sale('b' + i, i % 300)) }, Date.now());
      const bulk = Date.now() - t0;
      const t1 = Date.now();
      this.push({ salesLog: [sale('one-more', 0)] }, Date.now());
      const one = Date.now() - t1;
      must(one < 500, `one more sale took ${one} ms`);
      return `bulk ${bulk} ms, one more sale ${one} ms`;
    });
    await step('history paging + delta changes', () => {
      const p1 = this.history('salesLog', now - 500 * day, now + day, 1000);
      must(p1.records.length === 1000 && p1.next, 'first page should be full with a next cursor');
      const c = JSON.parse(this.changesText(0)).cursor;
      this.push({ salesLog: [sale('later', 0)] }, Date.now());
      const d = JSON.parse(this.changesText(c));
      must(d.records.salesLog && d.records.salesLog.length === 1 && d.records.salesLog[0].id === 'later', 'the delta should hold only the new sale');
    });
    await step('point-in-time restore is available', async () => {
      const st = this.state.storage;
      must(typeof st.getCurrentBookmark === 'function', 'this runtime has no point-in-time recovery (getCurrentBookmark)');
      const bm = await st.getCurrentBookmark();
      must(bm, 'no bookmark returned');
      must(typeof st.getBookmarkForTime === 'function' && typeof st.onNextSessionRestoreBookmark === 'function', 'restore functions are missing');
      return 'bookmark ok (a real restore was NOT performed)';
    }, { soft: true });
    await step('clean up', () => {
      this.sql.exec('DELETE FROM records'); this.sql.exec('DELETE FROM core');
      this.seq = 0; this.pos = 0;
      must(this.q('SELECT COUNT(*) AS n FROM records')[0].n === 0, 'could not clean up');
    });
    return { ok: steps.every((x) => x.ok || x.soft), steps };
  }

  /* ---------- HTTP entry ---------- */
  async fetch(request) {
    const path = new URL(request.url).pathname;
    let body = {};
    try { body = await request.json(); } catch (e) { /* GET-style calls carry no body */ }
    const text = (s, status = 200) => new Response(s, { status, headers: { 'Content-Type': 'application/json' } });
    const json = (o, status = 200) => text(JSON.stringify(o), status);
    try {
      switch (path) {
        case '/push': return json(this.push(body.body || {}, Number(body.serverNow) || Date.now()));
        case '/import': return json(this.push(body.state || {}, Date.now(), { preserveUpdatedAt: true }));
        case '/state': {
          const since = Number(body.since) || 0;
          const ua = this.updatedAt();
          if (since > 0 && ua && ua <= since) return json({ unchanged: true, updatedAt: ua });
          const hot = body.hotDays === 'all' ? null : (Number(body.hotDays) || Number(this.env.HOT_DAYS) || DEFAULT_HOT_DAYS);
          return text(this.stateText(hot));
        }
        case '/export': return text(this.stateText(null));
        case '/changes': return text(this.changesText(body.cursor));
        case '/history': return json(this.history(body.col, body.from, body.to, body.limit, body.after));
        case '/stats': return json(this.stats());
        case '/selftest': return json(await this.selfTest());
        // Point-in-time recovery (Cloudflare keeps 30 days for SQLite-backed Durable Objects). UNTESTED here — it needs the real
        // runtime; see STAGING_SETUP.md before relying on it. /bookmark reports where "now" is; /restore rewinds to a time.
        case '/bookmark': return json({ bookmark: await this.state.storage.getCurrentBookmark() });
        case '/restore': {
          const st = this.state.storage;
          const bm = await st.getBookmarkForTime(Number(body.time));
          const previous = await st.onNextSessionRestoreBookmark(bm);
          setTimeout(() => { try { this.state.abort('restoring'); } catch (e) { /* the restore applies on the next start */ } }, 50);
          return json({ restoring: true, to: bm, previous });
        }
        default: return json({ error: 'Unknown operation.' }, 404);
      }
    } catch (e) {
      return json({ error: 'Shop database error: ' + (e && e.message ? e.message : e) }, 500);
    }
  }
}
