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
  businessSig, bookingConflict, MERGE_BY_ID_FIELDS, FINAL_TOMBSTONE_FIELDS, compareBillProgress, mergeProductRecords, NEVER_BLANK_FIELDS, isBlank, recordKey, correctClockDrift,
  allocateTill, noteDevice, NESTED_MERGE, mergeBillRecords, mergeDebtRecords, mergeProgressRecord, PROGRESS_FIELDS, mergeLoyaltyFields, mergeInventoryRecord, SETTINGS_NEED_STAMP_FIELDS, mergeNestedRecord, LEDGER_COLLECTION, applyStockLedger, newLedgerMoves, restoreLedgerStock, stampLedgerEcho, CELL_SPECS, cellLedgerPush, applyCellLedger, newCellMoves, sameCell,
} from '../functions/api/_merge.js';
import { ARCHIVE_LOG_FIELDS, recordTime } from '../functions/api/_state-store.js';

const LOGS = new Set(ARCHIVE_LOG_FIELDS);
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
  getRow(col, rk) { return this.q('SELECT rk, upd, del, json FROM records WHERE col = ? AND rk = ?', col, rk)[0]; }

  // Same rule as mergeRecordsById: an incoming record replaces the stored one unless the stored one is strictly newer.
  upsert(col, rk, rec) {
    let upd = Number(rec && rec.updatedAt) || 0;
    let json = JSON.stringify(rec);
    const code = rec && rec.code != null ? String(rec.code) : null;
    const row = this.getRow(col, rk);
    if (!row) {
      if (this._ledgerOn && col === LEDGER_COLLECTION && rec && rec._deleted !== true) { rec = { ...rec }; if (Array.isArray(rec.variants)) rec.variants = rec.variants.map((v) => (v && typeof v === 'object' ? { ...v } : v)); stampLedgerEcho(rec); json = JSON.stringify(rec); }
      this.sql.exec('INSERT INTO records (col, rk, ts, upd, pos, seq, code, json, del) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        col, rk, this.timeOf(col, rec), upd, ++this.pos, ++this.seq, code, json, rec && rec._deleted === true ? 1 : 0);
      return true;
    }
    // Same rule as mergeRecordsById: a stock movement is immutable once stored (its `_srv` stamp is the audit truth).
    if (col === 'stockMovementLog' && row.del !== 1) return false;
    // Same rule as mergeRecordsById: for the lists in FINAL_TOMBSTONE_FIELDS (unique ids, never re-created) a tombstone is final.
    if (row.del === 1 && !(rec && rec._deleted === true) && rk.startsWith('id:') && FINAL_TOMBSTONE_FIELDS.includes(col)) return false;
    // Bills only move forward (see billProgress in _merge.js): the more advanced record wins whatever the times say.
    let forceReplace = false;
    let forceNested = false;
    // Inventory (same rule as mergeRecordsById): the newest record decides what it states, but a photo / pour setup it leaves EMPTY is kept.
    if (col === 'inventory' && row.del !== 1 && !(rec && rec._deleted === true)) {
      let stored = null; try { stored = JSON.parse(row.json); } catch (e) { /* unreadable: ordinary rule */ }
      if (stored) {
        rec = mergeInventoryRecord(stored, rec);
        upd = Number(rec && rec.updatedAt) || 0;
        json = JSON.stringify(rec);
      }
    }
    // Aqua POS products: each site's stock is merged by its own change time, not by the whole record (see mergeProductRecords).
    if (col === 'products' && row.del !== 1 && !(rec && rec._deleted === true)) {
      let stored = null; try { stored = JSON.parse(row.json); } catch (e) { /* unreadable: ordinary rule */ }
      if (stored) {
        rec = mergeProductRecords(stored, rec);
        upd = Number(rec && rec.updatedAt) || 0;
        json = JSON.stringify(rec);
      }
    }
    // STOCK LEDGER, cheaply: an inventory record from a device keeps the SERVER's stock figures (see restoreLedgerStock) — decided
    // here, per row, so a push carrying the whole inventory costs no more than before; items with new movements are then settled
    // by ledgerAfter. Only parsed when this row would otherwise be written.
    if (this._ledgerOn && col === LEDGER_COLLECTION && row.del !== 1 && !(rec && rec._deleted === true) && upd >= (row.upd || 0) && row.json !== json) {
      let stored = null; try { stored = JSON.parse(row.json); } catch (e) { /* unreadable: ordinary rule */ }
      if (stored) {
        rec = { ...rec };
        if (Array.isArray(rec.variants)) rec.variants = rec.variants.map((v) => (v && typeof v === 'object' ? { ...v } : v));
        restoreLedgerStock(stored, rec);
        stampLedgerEcho(rec);
        json = JSON.stringify(rec);
      }
    }
    // tabs / cash shifts: orders & adjustments unioned, status only forward (same rule as mergeRecordsById)
    if (NESTED_MERGE[col] && row.del !== 1 && !(rec && rec._deleted === true)) {
      let stored = null; try { stored = JSON.parse(row.json); } catch (e) { /* unreadable: ordinary rule */ }
      if (stored) {
        rec = mergeNestedRecord(col, stored, rec);
        upd = Math.max(Number(rec && rec.updatedAt) || 0, row.upd || 0);
        json = JSON.stringify(rec);
        if (json === row.json) return false;
        forceNested = true;
      }
    }
    // Bills and debts (same rules as mergeRecordsById): the payments of BOTH copies are kept, a bill only moves forward (see mergeBillRecords).
    if ((col === 'bills' || col === 'debts') && row.del !== 1 && !(rec && rec._deleted === true)) {
      let stored = null; try { stored = JSON.parse(row.json); } catch (e) { /* unreadable: ordinary rule */ }
      if (stored) {
        const m = col === 'bills' ? mergeBillRecords(stored, rec) : mergeDebtRecords(stored, rec);
        if (m === stored) return false;                    // the stored copy is the winner and the incoming one adds nothing
        rec = m;
        upd = Number(rec && rec.updatedAt) || 0;
        json = JSON.stringify(rec);
        forceReplace = true;
      }
    }
    // Customers: the winner by time decides the record, but loyalty tokens are merged (each till's awards add up - see mergeLoyaltyFields in _merge.js).
    if (col === 'customers' && row.del !== 1 && !(rec && rec._deleted === true)) {
      let stored = null; try { stored = JSON.parse(row.json); } catch (e) { /* unreadable: ordinary rule */ }
      if (stored) {
        const lf = mergeLoyaltyFields(stored, rec);
        if (lf) {
          const win = upd >= (row.upd || 0) ? rec : stored;
          rec = { ...win, ...lf };
          upd = Number(win.updatedAt) || 0;
          json = JSON.stringify(rec);
          if (json === row.json) return false;
          forceReplace = true;
        }
      }
    }
    // Trade credits and shifts only move forward (see mergeProgressRecord in _merge.js): the more advanced copy wins whatever the times say.
    if (PROGRESS_FIELDS.includes(col) && row.del !== 1 && !(rec && rec._deleted === true)) {
      let stored = null; try { stored = JSON.parse(row.json); } catch (e) { /* unreadable: ordinary rule */ }
      if (stored) {
        const m = mergeProgressRecord(col, stored, rec);
        if (m === stored) return false;
        rec = m;
        upd = Number(rec && rec.updatedAt) || 0;
        json = JSON.stringify(rec);
        forceReplace = true;
      }
    }
    if ((forceReplace || forceNested || upd >= (row.upd || 0)) && row.json !== json) {
      this.sql.exec('UPDATE records SET ts = ?, upd = ?, seq = ?, code = ?, json = ?, del = ? WHERE col = ? AND rk = ?',
        this.timeOf(col, rec), upd, ++this.seq, code, json, rec && rec._deleted === true ? 1 : 0, col, rk);
      return true;
    }
    return false;
  }

  /* ---------- push ---------- */
  // body: the device's payload. Returns { updatedAt }.
  push(body, serverNow = Date.now(), { preserveUpdatedAt = false, ledger = !preserveUpdatedAt } = {}) {
    if (!preserveUpdatedAt) body = correctClockDrift(body, serverNow);
    return this.tx(() => {
      // STOCK LEDGER (see applyStockLedger in _merge.js): note, BEFORE anything is written, which of this push's movements are new
      // and what the touched items look like now — an /import (moving a shop in) is taken as-is and skips this.
      this._ledgerOn = !!ledger;
      const led = ledger ? this.ledgerBefore(body) : null;
      const cells = ledger ? this.cellsBefore(body) : null;
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
        if (k === 'updatedAt' || k === '_fieldTimes' || k === '_cells' || k === '_till' || k === 'tillNumbers' || k === '_dev' || k === 'deviceRegistry') continue;
        if (MERGE_BY_ID_FIELDS.includes(k) && Array.isArray(v)) continue;
        // a null / {} / '' where a list belongs never replaces the stored list (same as the single-record backend)
        if (MERGE_BY_ID_FIELDS.includes(k) && this.q('SELECT 1 AS x FROM records WHERE col = ? LIMIT 1', k).length > 0) continue;
        if (NEVER_BLANK_FIELDS.includes(k) && isBlank(v) && !isBlank(existingCore[k])) continue;
        // receipt / branding / payment settings: a BLANK value that carries no change stamp is a fresh device's default and never replaces a
        // stored value (same rule as mergeIncomingState in _merge.js). A filled-in value, or a stamped one, is a real change.
        if (SETTINGS_NEED_STAMP_FIELDS.includes(k) && k in existingCore && !isBlank(existingCore[k]) && !(Array.isArray(existingCore[k]) && existingCore[k].length === 0)
            && typeof sentTimes[k] !== 'number' && (v === '' || v == null || (Array.isArray(v) && v.length === 0))) continue;
        const stored = storedTimes[k], sent = sentTimes[k];
        if (typeof stored === 'number' && !(typeof sent === 'number' && sent >= stored)) continue;
        if (typeof sent === 'number') times[k] = sent;
        this.setCore(k, v, coreText[k]);
      }
      if (Object.keys(times).length) this.setCore('_fieldTimes', times, coreText._fieldTimes);
      // till numbers: handed out here only (see allocateTill in _merge.js)
      const tills = allocateTill(existingCore.tillNumbers, body._till);
      if (Object.keys(tills.map).length) this.setCore('tillNumbers', tills.map, coreText.tillNumbers);
      const reg = noteDevice(existingCore.deviceRegistry, body._till, body._dev, tills.till);
      if (reg) this.setCore('deviceRegistry', reg, coreText.deviceRegistry);

      // 2. merge every by-id collection, record by record
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

      if (led) this.ledgerAfter(led, serverNow);
      this._ledgerOn = false;
      if (cells) this.cellsAfter(cells, serverNow);

      const updatedAt = preserveUpdatedAt && Number(body.updatedAt) ? Number(body.updatedAt) : serverNow;
      this.setCore('updatedAt', updatedAt, coreText.updatedAt);
      return { updatedAt, prev, ledger: 1, ...(tills.till ? { till: tills.till } : {}) };
    });
  }

  /* ---------- stock ledger (same rules as the KV backend: applyStockLedger) ---------- */
  inChunks(list, fn, size = 200) { const out = []; for (let i = 0; i < list.length; i += size) out.push(...fn(list.slice(i, i + size))); return out; }
  ledgerBefore(body) {
    const col = LEDGER_COLLECTION;
    if (!Array.isArray(body[col]) && !Array.isArray(body.stockMovementLog)) return null;
    const ids = [...new Set((Array.isArray(body.stockMovementLog) ? body.stockMovementLog : []).filter((m) => m && m.id != null).map((m) => 'id:' + m.id))];
    const stored = new Set(this.inChunks(ids, (c) => this.q(`SELECT rk FROM records WHERE col = 'stockMovementLog' AND rk IN (${c.map(() => '?').join(',')})`, ...c)).map((r) => r.rk));
    const newMoves = newLedgerMoves(body.stockMovementLog, (id) => stored.has('id:' + id));
    // same rule as the single-record backend: only a shop that keeps an `inventory` list has an inventory ledger (Aqua keeps
    // `products` — see cellsBefore), so an Aqua movement is never marked "item not found" here
    if (!Array.isArray(body[col]) && this.q('SELECT 1 AS x FROM records WHERE col = ? LIMIT 1', col).length === 0) return null;
    // only the items that have NEW movements need the full ledger: every other record's stock was already kept by upsert()
    const codes = new Set();
    newMoves.forEach((m) => codes.add(String(m.code)));
    if (codes.size === 0) return null;
    const list = [...codes];
    const rows = this.inChunks(list, (c) => this.q(`SELECT rk, json FROM records WHERE col = ? AND del = 0 AND code IN (${c.map(() => '?').join(',')})`, col, ...c));
    const found = new Set(rows.map((r) => { try { return String(JSON.parse(r.json).code); } catch (e) { return ''; } }));
    // a movement can name a VARIANT's code, which lives inside its parent's record: bring in the variant-bearing records too
    if (newMoves.some((m) => !found.has(String(m.code)))) {
      const have = new Set(rows.map((r) => r.rk));
      this.q("SELECT rk, json FROM records WHERE col = ? AND del = 0 AND json LIKE '%\"variants\":[{%'", col).forEach((r) => { if (!have.has(r.rk)) rows.push(r); });
    }
    return { existing: rows.map((r) => JSON.parse(r.json)), codes: list, rks: rows.map((r) => r.rk), newMoves, newIds: new Set(newMoves.map((m) => String(m.id))) };
  }
  // Aqua stock cells (see applyCellLedger): same before/after pattern, per collection, records addressed by their key (= rk).
  cellsBefore(body) {
    if (!cellLedgerPush(body)) return null;           // an older Aqua app: previous merge rules (see cellLedgerPush in _merge.js)
    if (!Array.isArray(body.stockMovementLog) && !Object.keys(CELL_SPECS).some((c) => Array.isArray(body[c]))) return null;
    const ids = [...new Set((Array.isArray(body.stockMovementLog) ? body.stockMovementLog : []).filter((m) => m && m.id != null && m.cell).map((m) => 'id:' + m.id))];
    const stored = new Set(this.inChunks(ids, (c) => this.q(`SELECT rk FROM records WHERE col = 'stockMovementLog' AND rk IN (${c.map(() => '?').join(',')})`, ...c)).map((r) => r.rk));
    const moves = newCellMoves(body.stockMovementLog, (id) => stored.has('id:' + id));
    const jobs = [];
    for (const col of Object.keys(CELL_SPECS)) {
      const keys = new Set();
      (Array.isArray(body[col]) ? body[col] : []).forEach((r) => { const k = recordKey(r); if (k != null) keys.add(k); });
      const mine = moves.filter((m) => m.cell.c === col);
      mine.forEach((m) => keys.add(String(m.cell.k)));
      if (keys.size === 0) continue;
      const rks = [...keys];
      const rows = this.inChunks(rks, (c) => this.q(`SELECT rk, json FROM records WHERE col = ? AND del = 0 AND rk IN (${c.map(() => '?').join(',')})`, col, ...c));
      jobs.push({ col, rks, existing: rows.map((r) => JSON.parse(r.json)), moves: mine });
    }
    return jobs.length ? { jobs, newIds: new Set(moves.map((m) => String(m.id))) } : null;
  }
  cellsAfter(cells, serverNow) {
    for (const job of cells.jobs) {
      const rows = this.inChunks(job.rks, (c) => this.q(`SELECT rk, json FROM records WHERE col = ? AND del = 0 AND rk IN (${c.map(() => '?').join(',')})`, job.col, ...c));
      const res = applyCellLedger({
        col: job.col, existingArr: job.existing, mergedArr: rows.map((r) => JSON.parse(r.json)), newMoves: job.moves, serverNow,
        laterMoves: (cell, T) => this.q("SELECT json FROM records WHERE col = 'stockMovementLog' AND del = 0 AND ts > ? AND json LIKE '%\"cell\":%'", Math.floor(T))
          .map((r) => JSON.parse(r.json)).filter((m) => !cells.newIds.has(String(m.id)) && m.cell && sameCell(m.cell, cell)),
      });
      res.arr.forEach((rec, i) => {
        const json = JSON.stringify(rec);
        if (json !== rows[i].json) this.sql.exec('UPDATE records SET seq = ?, json = ? WHERE col = ? AND rk = ?', ++this.seq, json, job.col, rows[i].rk);
      });
      res.notes.forEach((srv, id) => {
        const row = this.getRow('stockMovementLog', 'id:' + id);
        if (!row) return;
        this.sql.exec('UPDATE records SET seq = ?, json = ? WHERE col = ? AND rk = ?', ++this.seq, JSON.stringify({ ...JSON.parse(row.json), _srv: srv }), 'stockMovementLog', 'id:' + id);
      });
    }
  }
  ledgerAfter(led, serverNow) {
    const col = LEDGER_COLLECTION;
    // every record the push could have touched: the ones it named (new ones included) and the ones read before it
    const rows = this.inChunks(led.codes, (c) => this.q(`SELECT rk, json FROM records WHERE col = ? AND del = 0 AND code IN (${c.map(() => '?').join(',')})`, col, ...c));
    const have = new Set(rows.map((r) => r.rk));
    const extra = led.rks.filter((rk) => !have.has(rk));
    rows.push(...this.inChunks(extra, (c) => this.q(`SELECT rk, json FROM records WHERE col = ? AND del = 0 AND rk IN (${c.map(() => '?').join(',')})`, col, ...c)));
    const merged = rows.map((r) => JSON.parse(r.json));
    const res = applyStockLedger({
      existingInv: led.existing, mergedInv: merged, newMoves: led.newMoves, serverNow,
      laterMoves: (code, unit, T) => this.q("SELECT json FROM records WHERE col = 'stockMovementLog' AND del = 0 AND code = ? AND ts > ?", code, Math.floor(T))
        .map((r) => JSON.parse(r.json))
        .filter((m) => !led.newIds.has(String(m.id)) && (m.unit === 'pieceQty' ? 'pieceQty' : 'qty') === unit),
    });
    res.inventory.forEach((rec, i) => {
      const json = JSON.stringify(rec);
      if (json !== rows[i].json) this.sql.exec('UPDATE records SET seq = ?, json = ? WHERE col = ? AND rk = ?', ++this.seq, json, col, rows[i].rk);
    });
    res.notes.forEach((srv, id) => {
      const row = this.getRow('stockMovementLog', 'id:' + id);
      if (!row) return;
      const m = JSON.parse(row.json);
      this.sql.exec('UPDATE records SET seq = ?, json = ? WHERE col = ? AND rk = ?', ++this.seq, JSON.stringify({ ...m, _srv: srv }), 'stockMovementLog', 'id:' + id);
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
    parts.push('"_ledger":1');                                                // stock movements are applied once here (see applyStockLedger)
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
      'SELECT rk, ts, json FROM records WHERE col = ? AND del = 0 AND ts >= ? AND ts < ? AND (ts > ? OR (ts = ? AND rk > ?)) ORDER BY ts, rk LIMIT ?',
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
    await step('two tills selling offline: both sales come off, a retry changes nothing (stock ledger)', async () => {
      // a real sale is stamped BEFORE the server sees it, so each movement is created a few ms after the previous push
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const mv = (id, delta) => ({ id, code: 'A', delta, timestamp: new Date().toISOString(), type: 'removed' });
      await sleep(8);
      this.push({ inventory: [{ code: 'A', qty: 4, price: 9, updatedAt: now + 10 }], stockMovementLog: [mv('m1', -1)] }, now + 20);
      await sleep(8);
      const second = { inventory: [{ code: 'A', qty: 4, price: 9, updatedAt: now + 30 }], stockMovementLog: [mv('m2', -1)] };
      this.push(second, now + 40);
      this.push(second, now + 50);                    // the same request again (its reply was lost)
      const q = JSON.parse(this.stateText(null)).inventory[0].qty;
      // Both tills computed "5 - 1 = 4" from a stale base; the server ignores those numbers and applies each movement once.
      must(q === 3, `expected 5 - 1 - 1 = 3, got ${q}`);
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
        // zip 129: which of these records does the database hold, and in which business version (see businessSig) — so a device
        // sends only what the server does not have yet.
        case '/have': {
          const out = {};
          if (LOGS.has(body.col) && Array.isArray(body.ids)) {
            for (const id of body.ids.slice(0, 5000)) {
              const row = this.getRow(body.col, 'id:' + id);
              if (row && row.del !== 1) { try { out[id] = businessSig(JSON.parse(row.json)); } catch (e) { /* unreadable: send again */ } }
            }
          }
          return json({ have: out });
        }
        // zip 137: book a resource — the clash check and the insert happen in this one request (a Durable Object runs one request
        // at a time), so two tills booking the same pool table for the same hour cannot both succeed.
        case '/book': {
          const rec = body.record;
          if (!rec || !rec.id) return json({ ok: false, error: 'bad booking' }, 400);
          const existing = this.q('SELECT json FROM records WHERE col = ? AND del = 0', 'facilityBookings').map((r) => { try { return JSON.parse(r.json); } catch (e) { return null; } });
          const clash = bookingConflict(existing, rec);
          if (clash) return json({ ok: false, conflict: clash });
          this.push({ facilityBookings: [rec] }, Number(body.serverNow) || Date.now());
          return json({ ok: true });
        }
        // zip 141: one staff record, for the server's PIN check when a staff member starts a server session (staff-session.js)
        case '/staff-member': {
          const row = this.getRow('staff', 'id:' + String(body.id || ''));
          let m = null;
          if (row && row.del !== 1) { try { const r = JSON.parse(row.json); m = { id: r.id, name: r.name, pinHash: r.pinHash, roles: r.roles, isManager: !!r.isManager, removed: !!r.removed, lockedDates: r.lockedDates, openAccountOverrideDate: r.openAccountOverrideDate || '' }; } catch (e) { m = null; } }
          return json({ member: m });
        }
        case '/stats': return json(this.stats());
        // only the two password hashes (device pairing checks the shop password against them — see device-pair.js)
        case '/registry': return json(this.getCore().deviceRegistry || {});
        case '/secrets': { const c = this.getCore(); return json({ pwHash: c.pwHash || '', adminPwHash: c.adminPwHash || '' }); }
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
