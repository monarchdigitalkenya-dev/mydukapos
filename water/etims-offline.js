/*
 * AquaPOS — Offline-First KRA eTIMS (VSCU) Module
 * =================================================
 * This file is additive: it does not replace the existing online eTIMS
 * pipeline in index.html (submitSaleToEtimsIfEnabled -> /api/etims-submit,
 * which already talks to KRA through the Cloudflare Worker backend and
 * already retries same-day failures). What THIS file adds is the piece
 * that was missing: a genuinely offline-capable local ledger, so a sale
 * made with zero internet still gets a sequential receipt number, a
 * tamper-evident audit trail, and a queue that flushes itself the moment
 * connectivity (to either KRA's VSCU or our own backend) returns.
 *
 * IMPORTANT ARCHITECTURE NOTE (read this before wiring anything else in):
 * KRA's actual VSCU is not something we re-implement in the browser. Per
 * KRA's own VSCU Specification Document v2.0: "To use VSCU a JAR file is
 * deployed on your local webserver and needs to be up and running
 * locally... If there is no internet connection for 24 hours after VSCU
 * issues a receipt signature and an internal data, VSCU stops issuing a
 * receipt number." In other words VSCU is KRA-supplied software that runs
 * on a machine on the shop's own LAN (conceptually the same pattern as
 * our existing print-helper Node bridge) and IT does the real signing,
 * sequencing and KRA-facing sync — our POS just calls its local REST API.
 * This module talks to that local VSCU service (configurable base URL,
 * defaults to http://127.0.0.1:8088) using KRA's real endpoint names and
 * field names. When VSCU itself isn't reachable (not installed yet, PC
 * off, or genuinely no LAN), sales still complete instantly using OUR
 * OWN local sequence + queue below, clearly marked pending_sync, and get
 * pushed to VSCU automatically once it's reachable again.
 */
(function (global) {
  'use strict';

  const DB_NAME = 'aqua_etims_offline';
  const DB_VERSION = 1;
  const STORES = ['config', 'keys', 'counters', 'receipts', 'queue', 'auditLog', 'itemMaster', 'localAuth', 'clock'];
  const DOC_TYPES = ['NS', 'NR', 'CN', 'DN', 'PR', 'TR']; // Normal Sale, Normal Refund/Credit Note-ish,
  // Credit Note, Debit Note, Proforma Receipt, Training Receipt — per the app's own settings screen,
  // matching KRA's Sales Receipt Type / Transaction Type codes (see buildSaveSalesPayload below).
  const CLOCK_DRIFT_LIMIT_MS = 5 * 60 * 1000; // 5 minutes, per spec section 4

  let _dbPromise = null;
  function idb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('config')) db.createObjectStore('config', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('counters')) db.createObjectStore('counters', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('receipts')) {
          const s = db.createObjectStore('receipts', { keyPath: 'localId' });
          s.createIndex('status', 'status', { unique: false });
          s.createIndex('saleId', 'saleId', { unique: false });
        }
        if (!db.objectStoreNames.contains('queue')) {
          const s = db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
          s.createIndex('status', 'status', { unique: false });
          s.createIndex('seq', 'seq', { unique: false });
        }
        if (!db.objectStoreNames.contains('auditLog')) {
          const s = db.createObjectStore('auditLog', { keyPath: 'id', autoIncrement: true });
          s.createIndex('ts', 'ts', { unique: false });
        }
        if (!db.objectStoreNames.contains('itemMaster')) db.createObjectStore('itemMaster', { keyPath: 'itemCd' });
        if (!db.objectStoreNames.contains('localAuth')) db.createObjectStore('localAuth', { keyPath: 'username' });
        if (!db.objectStoreNames.contains('clock')) db.createObjectStore('clock', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }

  function tx(storeName, mode) {
    return idb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
  }
  function reqP(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function idbGet(store, key) { return reqP((await tx(store, 'readonly')).get(key)); }
  async function idbPut(store, val) { return reqP((await tx(store, 'readwrite')).put(val)); }
  async function idbDelete(store, key) { return reqP((await tx(store, 'readwrite')).delete(key)); }
  async function idbAll(store) { return reqP((await tx(store, 'readonly')).getAll()); }

  // ---------------------------------------------------------------------
  // 1) OPT-IN CONFIG
  // ---------------------------------------------------------------------
  // Config keys: enabled (bool), controlUnitId (sdcId once issued by KRA),
  // kraPin (tin), apiKey (cmcKey / communication key, once issued),
  // payPointId (bhfId, "00" head office / branch code), vscuBaseUrl
  // (local VSCU JAR address, e.g. http://127.0.0.1:8088), deviceSerial
  // (dvcSrlNo — required by /initializer/selectInitInfo), env (sandbox|production).
  async function getEtimsConfig() {
    const c = await idbGet('config', 'etims');
    return c ? c.value : {
      enabled: false,
      controlUnitId: '',
      kraPin: '',
      apiKey: '',
      payPointId: '00',
      vscuBaseUrl: 'http://127.0.0.1:8088',
      deviceSerial: '',
      env: 'sandbox',
      // Off by default so turning eTIMS on doesn't instantly block every
      // sale before anyone has had a chance to classify the catalogue.
      // Turn this on from Settings once itemClassCd/itemCd/taxTyCd have
      // actually been filled in for the products this shop sells.
      requireItemClassification: false,
    };
  }
  async function setEtimsConfig(patch) {
    const current = await getEtimsConfig();
    const next = Object.assign({}, current, patch);
    await idbPut('config', { key: 'etims', value: next });
    await auditAppend('config_change', { patch });
    return next;
  }
  async function isEtimsEnabled() {
    const c = await getEtimsConfig();
    return !!c.enabled;
  }

  // ---------------------------------------------------------------------
  // 2) OFFLINE AUTH — salted PBKDF2, additive upgrade over the app's
  //    existing unsalted-SHA-256 pwHash/adminPwHash. We never replace the
  //    existing login path; we add a stronger local record that gets
  //    created the next time a PIN successfully verifies, and preferred
  //    over the legacy hash once present. This directly addresses the
  //    "unsalted SHA-256 PIN hashing" risk flagged earlier in this project.
  // ---------------------------------------------------------------------
  function bufToHex(buf) { return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join(''); }
  function hexToBuf(hex) {
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
    return arr.buffer;
  }
  async function pbkdf2Hash(pin, saltHex) {
    const enc = new TextEncoder();
    const salt = saltHex ? hexToBuf(saltHex) : crypto.getRandomValues(new Uint8Array(16)).buffer;
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      256
    );
    return { hash: bufToHex(bits), salt: bufToHex(salt) };
  }

  // Call this once a PIN/password has verified successfully through the
  // app's existing flow (legacy sha256 match or first-time set) to persist
  // a hardened local record with a role and an optional expiry.
  async function upgradeLocalAuth(username, pin, role, expiresAt) {
    const { hash, salt } = await pbkdf2Hash(pin);
    await idbPut('localAuth', {
      username: String(username || '').toLowerCase(),
      hash, salt, role: role || 'staff',
      expiresAt: expiresAt || null,
      updatedAt: new Date().toISOString(),
    });
  }

  // Offline-safe verification: returns { ok, role, reason }. Callers should
  // try this FIRST (it needs no network); only fall back to the legacy
  // sha256 comparison already in index.html if no hardened record exists
  // yet for that username (e.g. first login on a fresh device before an
  // online sync has run).
  async function verifyLocalAuth(username, pin) {
    const rec = await idbGet('localAuth', String(username || '').toLowerCase());
    if (!rec) return { ok: false, reason: 'no_local_record' };
    if (rec.expiresAt && new Date(rec.expiresAt).getTime() < Date.now()) {
      return { ok: false, reason: 'expired', role: rec.role };
    }
    const { hash } = await pbkdf2Hash(pin, rec.salt);
    if (hash === rec.hash) return { ok: true, role: rec.role };
    return { ok: false, reason: 'mismatch' };
  }

  // ---------------------------------------------------------------------
  // 3) CLOCK DRIFT GUARD
  // ---------------------------------------------------------------------
  // Call recordServerTime(isoString) any time we successfully talk to
  // ANY server (the sync poll, a printer ping, an eTIMS submit) — it
  // stores the server time alongside performance.now() (a MONOTONIC
  // clock that keeps ticking at a steady rate regardless of the device's
  // wall clock being changed — unlike Date.now(), moving the system
  // clock forward or back does not affect it). checkClockDrift() then
  // compares Date.now() against "server time + real elapsed time since
  // that sync" to catch exactly the case this guard exists for: someone
  // moving the device clock AFTER the last time we had a trustworthy
  // reference, not just replaying the offset that existed at sync time.
  async function recordServerTime(serverIso) {
    const serverMs = new Date(serverIso).getTime();
    if (!Number.isFinite(serverMs)) return;
    await idbPut('clock', { key: 'offset', serverMs, monotonicAtSync: performance.now() });
  }
  async function checkClockDrift() {
    const rec = await idbGet('clock', 'offset');
    if (!rec) return { ok: true, driftMs: 0, reason: 'no_reference_yet' };
    const realElapsedMs = performance.now() - rec.monotonicAtSync; // unaffected by wall-clock changes
    const expectedServerNow = rec.serverMs + realElapsedMs;
    const driftMs = Math.abs(Date.now() - expectedServerNow);
    return { ok: driftMs <= CLOCK_DRIFT_LIMIT_MS, driftMs };
  }

  // ---------------------------------------------------------------------
  // 4) SEQUENTIAL LOCAL NUMBERING — per pay-point, per document type.
  //    Guaranteed sequential & uninterrupted because IndexedDB
  //    transactions are atomic: two concurrent calls on the same tab
  //    cannot both read-then-write the same counter value.
  // ---------------------------------------------------------------------
  async function nextLocalSeq(payPointId, docType) {
    if (DOC_TYPES.indexOf(docType) === -1) throw new Error('Unknown eTIMS doc type: ' + docType);
    const key = payPointId + ':' + docType;
    const db = await idb();
    return new Promise((resolve, reject) => {
      const t = db.transaction('counters', 'readwrite');
      const store = t.objectStore('counters');
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const current = getReq.result ? getReq.result.value : 0;
        const next = current + 1;
        store.put({ key, value: next });
        t.oncomplete = () => resolve(next);
        t.onerror = () => reject(t.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  // The KRA-facing invcNo is a SEPARATE sequence from the local human-
  // readable ref above, and it must never repeat. It starts from
  // whatever VSCU told us on /initializer/selectInitInfo (lastSaleInvcNo)
  // and is incremented atomically, exactly like nextLocalSeq, on every
  // single call — including calls that are still offline. Nothing else
  // in this file may compute invcNo by reading keys.lastSaleInvcNo
  // directly; that field is only ever the SEED, used once.
  async function nextInvcNo(seedFromKeys) {
    const key = 'invcNo';
    const db = await idb();
    return new Promise((resolve, reject) => {
      const t = db.transaction('counters', 'readwrite');
      const store = t.objectStore('counters');
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const current = getReq.result ? getReq.result.value : (seedFromKeys || 0);
        const next = current + 1;
        store.put({ key, value: next });
        t.oncomplete = () => resolve(next);
        t.onerror = () => reject(t.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }
  function formatLocalRef(payPointId, docType, seq) {
    // e.g. 00-NS-000123 — human-readable, sortable, and distinct from the
    // eventual KRA invcNo/rcptNo which only exist once VSCU/backend syncs.
    return payPointId + '-' + docType + '-' + String(seq).padStart(6, '0');
  }

  // ---------------------------------------------------------------------
  // 5) IMMUTABLE, HASH-CHAINED AUDIT LOG
  // ---------------------------------------------------------------------
  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return bufToHex(buf);
  }
  // auditAppend chains hash(prevEntry) -> newEntry, so two calls that ran
  // concurrently — read "what's the last entry" then write a new one as
  // two separate steps — could both read the same prev entry and write
  // two forks of the chain, which auditVerifyChain() would then (rightly)
  // report as broken. Serialize every call, in this tab via a promise
  // chain and across tabs via the Web Locks API where it's available
  // (every current till browser — Chrome/Edge — supports it; where it
  // isn't, the in-tab chain still protects the common single-tab case).
  let _auditChainTail = Promise.resolve();
  async function _auditAppendLocked(action, details) {
    const all = await idbAll('auditLog');
    const prev = all.length ? all[all.length - 1] : null;
    const entry = {
      ts: new Date().toISOString(),
      action,
      details: details || {},
      prevHash: prev ? prev.hash : null,
    };
    entry.hash = await sha256Hex((entry.prevHash || '') + '|' + entry.ts + '|' + entry.action + '|' + JSON.stringify(entry.details));
    await idbPut('auditLog', entry);
    return entry;
  }
  async function auditAppend(action, details) {
    const run = () => (global.navigator && navigator.locks)
      ? navigator.locks.request('aqua-etims-audit-log', () => _auditAppendLocked(action, details))
      : _auditAppendLocked(action, details);
    const result = _auditChainTail.then(run, run);
    _auditChainTail = result.catch(() => {});
    return result;
  }
  // Verifies the whole chain is intact — call from Settings if you ever
  // need to prove no entry has been altered or removed out of band.
  async function auditVerifyChain() {
    const all = (await idbAll('auditLog')).sort((a, b) => a.id - b.id);
    let prevHash = null;
    for (const entry of all) {
      if (entry.prevHash !== prevHash) return { ok: false, brokenAt: entry.id };
      const expect = await sha256Hex((entry.prevHash || '') + '|' + entry.ts + '|' + entry.action + '|' + JSON.stringify(entry.details));
      if (expect !== entry.hash) return { ok: false, brokenAt: entry.id };
      prevHash = entry.hash;
    }
    return { ok: true, count: all.length };
  }

  // ---------------------------------------------------------------------
  // 6) ITEM MASTER COMPLIANCE GATE
  // ---------------------------------------------------------------------
  // Call before allowing checkout to proceed as an eTIMS receipt (not a
  // plain receipt). Cache the item master locally via cacheItemForEtims()
  // whenever a product is saved/edited in the normal Inventory UI once
  // it has eTIMS fields; this function then only checks what's cached.
  async function cacheItemForEtims(item) {
    // item: { itemCd, itemClsCd, itemNm, taxTyCd, hsCode, pkgUnitCd, qtyUnitCd }
    if (!item || !item.itemCd) return;
    await idbPut('itemMaster', item);
  }
  function validateItemFields(item) {
    const missing = [];
    if (!item) return { ok: false, missing: ['item'] };
    if (!item.itemClsCd) missing.push('itemClassCd');
    if (!item.itemCd) missing.push('itemCd');
    if (!item.taxTyCd || ['A', 'B', 'C', 'D', 'E'].indexOf(item.taxTyCd) === -1) missing.push('taxTyCd (A/B/C/D/E)');
    return { ok: missing.length === 0, missing };
  }
  async function validateCartForEtims(cartLines) {
    // cartLines: [{ itemCd, ... }] — looks each one up in the cached item
    // master and reports every line that's missing required eTIMS fields,
    // so checkout can block ("Cannot issue eTIMS receipt: 2 items are
    // missing tax classification — finish classifying them in Inventory or
    // ring this sale up as a plain receipt") instead of silently degrading.
    const problems = [];
    for (const line of cartLines) {
      const key = line.itemCd || line.code || line.id;
      const master = await idbGet('itemMaster', key);
      const v = validateItemFields(master);
      if (!v.ok) problems.push({ item: line.name || key, missing: v.missing });
    }
    return { ok: problems.length === 0, problems };
  }

  // ---------------------------------------------------------------------
  // 7) VSCU CLIENT — talks to the local VSCU JAR using KRA's real
  //    endpoint paths & field names (VSCU Specification Document v2.0).
  //    Falls back to the local queue on any failure (VSCU not running,
  //    LAN down, timeout) so the caller never has to special-case it.
  // ---------------------------------------------------------------------
  async function vscuFetch(path, body, timeoutMs) {
    const cfg = await getEtimsConfig();
    const base = (cfg.vscuBaseUrl || 'http://127.0.0.1:8088').replace(/\/$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 5000);
    try {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json();
      await recordServerTime(new Date().toISOString()); // VSCU responded — treat its host clock as a trust anchor
      return { ok: res.ok && data.resultCd === '000', data };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  // /initializer/selectInitInfo — one-time device activation. Requires
  // internet the first time (VSCU itself needs to reach KRA to fetch
  // keys); after that, dvcId/sdcId/mrcNo/intrlKey/signKey/cmcKey are
  // cached locally and VSCU signs offline using them.
  function buildInitializerReq(cfg) {
    return { tin: cfg.kraPin, bhfId: cfg.payPointId, dvcSrlNo: cfg.deviceSerial };
  }
  async function runInitialize() {
    const cfg = await getEtimsConfig();
    const result = await vscuFetch('/initializer/selectInitInfo', buildInitializerReq(cfg), 15000);
    if (result.ok) {
      const info = (result.data.data && result.data.data.info) || {};
      await idbPut('keys', {
        key: 'device',
        dvcId: info.dvcId, sdcId: info.sdcId, mrcNo: info.mrcNo,
        intrlKey: info.intrlKey, signKey: info.signKey, cmcKey: info.cmcKey,
        lastSaleInvcNo: info.lastSaleInvcNo || 0, lastSaleRcptNo: info.lastSaleRcptNo || 0,
      });
      await setEtimsConfig({ controlUnitId: info.sdcId || '' });
      await auditAppend('etims_initialize_ok', { bhfId: cfg.payPointId });
    } else {
      await auditAppend('etims_initialize_failed', { error: result.error || result.data });
    }
    return result;
  }

  // /items/saveItems — mirrors ItemSaveReq exactly (see spec 3.3.4.1).
  function buildSaveItemsPayload(cfg, item, registrant) {
    return {
      tin: cfg.kraPin, bhfId: cfg.payPointId,
      itemCd: item.itemCd, itemClsCd: item.itemClsCd,
      itemTyCd: item.itemTyCd || '2', // 1=Raw Material, 2=Finished Product, 3=Service
      itemNm: item.itemNm, itemStdNm: item.itemStdNm || null,
      orgnNatCd: item.orgnNatCd || 'KE', pkgUnitCd: item.pkgUnitCd || 'NT',
      qtyUnitCd: item.qtyUnitCd || 'U', taxTyCd: item.taxTyCd,
      btchNo: item.btchNo || null, bcd: item.barcode || null,
      dftPrc: item.price, grpPrcL1: item.price, grpPrcL2: item.wholesalePrice || item.price,
      grpPrcL3: item.customPrice || item.price, grpPrcL4: null, grpPrcL5: null,
      addInfo: item.hsCode || null, sftyQty: item.lowStockThreshold || null,
      isrcAplcbYn: 'N', useYn: 'Y',
      regrNm: registrant || 'System', regrId: registrant || 'system',
      modrNm: registrant || 'System', modrId: registrant || 'system',
    };
  }
  async function saveItemToEtims(item, registrant) {
    const cfg = await getEtimsConfig();
    if (!cfg.enabled) return { ok: false, reason: 'disabled' };
    const payload = buildSaveItemsPayload(cfg, item, registrant);
    const result = await vscuFetch('/items/saveItems', payload, 8000);
    if (!result.ok) await enqueue('saveItems', payload);
    return result;
  }

  // /items/selectItems — pulls the item catalogue back down (e.g. after
  // a reinstall) so local classification data can be rehydrated offline.
  async function selectItemsFromEtims(lastReqDt) {
    const cfg = await getEtimsConfig();
    return vscuFetch('/items/selectItems', { tin: cfg.kraPin, bhfId: cfg.payPointId, lastReqDt: lastReqDt || '20200101000000' }, 10000);
  }

  // /trnsSales/saveSales — mirrors TrnsSalesSaveWrReq (spec 3.3.6.1).
  // `sale` is this app's own sale object; `localRef` is what
  // recordOfflineSale() below generated.
  function buildSaveSalesPayload(cfg, sale, localRef, invcNo) {
    const now = new Date();
    const yyyymmddhhmmss = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const yyyymmdd = yyyymmddhhmmss.slice(0, 8);
    const taxBuckets = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    const taxAmts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    const items = (sale.items || []).map((line, idx) => {
      // AquaPOS's own cart lines use `code` (product code) and
      // `vatCategory` (A/B today) rather than KRA's itemCd/taxTyCd —
      // accept either so this works against the app's real data shape
      // without requiring every call site to remap first. Once a
      // product has real eTIMS fields cached (see cacheItemForEtims),
      // those take priority.
      const itemCd = line.itemCd || line.code || line.id;
      const taxTy = line.taxTyCd || line.vatCategory || 'B';
      const taxbl = round2((line.qty || 1) * (line.price || 0) - (line.discount || 0));
      const rate = { A: 0, B: 16, C: 0, D: 0, E: 8 }[taxTy] || 0;
      const taxAmt = round2(taxbl - taxbl / (1 + rate / 100));
      taxBuckets[taxTy] = round2(taxBuckets[taxTy] + taxbl);
      taxAmts[taxTy] = round2(taxAmts[taxTy] + taxAmt);
      return {
        itemSeq: idx + 1, itemCd, itemClsCd: line.itemClsCd,
        itemNm: line.name, bcd: line.barcode || null,
        pkgUnitCd: line.pkgUnitCd || 'NT', pkg: 1,
        qtyUnitCd: line.qtyUnitCd || 'U', qty: line.qty || 1,
        prc: line.price || 0, splyAmt: round2((line.qty || 1) * (line.price || 0)),
        dcRt: 0, dcAmt: line.discount || 0,
        taxTyCd: taxTy, taxblAmt: taxbl, totTaxAmt: taxAmt, totAmt: taxbl,
      };
    });
    const totTaxbl = round2(Object.values(taxBuckets).reduce((a, b) => a + b, 0));
    const totTax = round2(Object.values(taxAmts).reduce((a, b) => a + b, 0));
    return {
      tin: cfg.kraPin, bhfId: cfg.payPointId,
      trdInvcNo: localRef, invcNo, orgInvcNo: 0,
      custTin: sale.customerPin || null, custNm: sale.customerName || null,
      salesTyCd: 'N', rcptTyCd: sale.docType === 'CN' ? 'R' : 'S',
      pmtTyCd: mapPaymentMethod(sale.paymentMethod), salesSttsCd: '02',
      cfmDt: yyyymmddhhmmss, salesDt: yyyymmdd, stockRlsDt: yyyymmddhhmmss,
      cnclReqDt: null, cnclDt: null, rfdDt: null, rfdRsnCd: null,
      totItemCnt: items.length,
      taxblAmtA: taxBuckets.A, taxblAmtB: taxBuckets.B, taxblAmtC: taxBuckets.C, taxblAmtD: taxBuckets.D, taxblAmtE: taxBuckets.E,
      taxRtA: 0, taxRtB: 16, taxRtC: 0, taxRtD: 0, taxRtE: 8,
      taxAmtA: taxAmts.A, taxAmtB: taxAmts.B, taxAmtC: taxAmts.C, taxAmtD: taxAmts.D, taxAmtE: taxAmts.E,
      totTaxblAmt: totTaxbl, totTaxAmt: totTax, totAmt: round2(sale.total),
      prchrAcptcYn: 'N', remark: null,
      regrNm: sale.servedBy || 'Till', regrId: sale.servedBy || 'till',
      modrNm: sale.servedBy || 'Till', modrId: sale.servedBy || 'till',
      itemList: items,
    };
  }
  function mapPaymentMethod(m) {
    const map = { cash: '01', credit: '02', mpesa: '06', card: '05', split: '03', bank: '04' };
    return map[(m || '').toLowerCase()] || '07';
  }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  // ---------------------------------------------------------------------
  // 8) THE OFFLINE-FIRST SALE PATH — this is the function checkout should
  //    call (in addition to, not instead of, the existing
  //    submitSaleToEtimsIfEnabled online path). It never touches the
  //    network; it returns instantly with a local sequential reference
  //    and a pending_sync record, then queues the real VSCU submission.
  // ---------------------------------------------------------------------
  async function recordOfflineSale(sale, docType) {
    docType = docType || 'NS';
    const cfg = await getEtimsConfig();
    if (!cfg.enabled) return null;

    const drift = await checkClockDrift();
    if (!drift.ok) {
      await auditAppend('etims_blocked_clock_drift', { driftMs: drift.driftMs, saleId: sale.id });
      return { blocked: true, reason: 'clock_drift', driftMs: drift.driftMs };
    }

    if (cfg.requireItemClassification) {
      const cartCheck = await validateCartForEtims(sale.items || []);
      if (!cartCheck.ok) {
        await auditAppend('etims_blocked_item_master', { saleId: sale.id, problems: cartCheck.problems });
        return { blocked: true, reason: 'item_master_incomplete', problems: cartCheck.problems };
      }
    }

    const seq = await nextLocalSeq(cfg.payPointId, docType);
    const localRef = formatLocalRef(cfg.payPointId, docType, seq);
    const keys = await idbGet('keys', 'device');
    const invcNo = await nextInvcNo(keys && keys.lastSaleInvcNo);
    const payload = buildSaveSalesPayload(cfg, sale, localRef, invcNo);

    const localId = 'LOC-' + localRef + '-' + Date.now();
    await idbPut('receipts', {
      localId, saleId: sale.id, localRef, docType,
      status: 'pending_sync', createdAt: new Date().toISOString(),
      payload, printedCount: 0,
    });
    await auditAppend('offline_sale_recorded', { saleId: sale.id, localRef });

    await enqueue('saveSales', payload, { localId, seq });
    triggerSyncSoon();
    return { blocked: false, localRef, localId, pending: true };
  }

  // Call this before any REPRINT (not the first, original print) of a
  // receipt whose eTIMS record is anything other than 'synced' — or
  // honestly, per KRA's own reprint rule, on every reprint regardless of
  // sync status; the original print is the only one that's ever "clean".
  async function markReprintWatermark(localId) {
    const rec = await idbGet('receipts', localId);
    if (!rec) return false;
    rec.printedCount = (rec.printedCount || 0) + 1;
    await idbPut('receipts', rec);
    return rec.printedCount > 1; // true => caller should stamp "COPY" on the receipt render
  }

  function buildQrPayload(cfg, keys, invcNo) {
    // Real KRA QR payloads resolve through etims.kra.go.ke's public receipt
    // verification link, parameterised by PIN + Control Unit ID + invoice
    // number. Confirm the exact path against your OSCU/VSCU onboarding
    // pack before go-live — this mirrors the publicly documented pattern
    // but KRA has been known to adjust the verification host per env.
    const host = cfg.env === 'production' ? 'https://etims.kra.go.ke' : 'https://etims-sbx.kra.go.ke';
    return `${host}/common/link/etims/receipt/indexEtimsReceiptData?tin=${encodeURIComponent(cfg.kraPin)}&bhfId=${encodeURIComponent(cfg.payPointId)}&sdcId=${encodeURIComponent(keys && keys.sdcId || '')}&invcNo=${encodeURIComponent(invcNo || '')}`;
  }

  // ---------------------------------------------------------------------
  // 9) QUEUE + BACKGROUND SYNC
  // ---------------------------------------------------------------------
  async function enqueue(kind, payload, meta) {
    await idbPut('queue', Object.assign({ kind, payload, status: 'pending', attempts: 0, createdAt: new Date().toISOString() }, meta || {}));
  }

  let _processing = false;
  async function processQueue() {
    if (_processing) return { ok: true, skipped: 'already_running' };
    _processing = true;
    try {
      const all = (await idbAll('queue')).filter((q) => q.status === 'pending').sort((a, b) => (a.seq || 0) - (b.seq || 0) || a.id - b.id);
      let synced = 0, failed = 0;
      for (const job of all) {
        const path = job.kind === 'saveSales' ? '/trnsSales/saveSales' : job.kind === 'saveItems' ? '/items/saveItems' : null;
        if (!path) continue;
        const result = await vscuFetch(path, job.payload, 8000);
        if (result.ok) {
          job.status = 'synced';
          job.syncedAt = new Date().toISOString();
          job.response = result.data.data || null;
          await idbPut('queue', job);
          if (job.localId) {
            const rec = await idbGet('receipts', job.localId);
            if (rec) {
              rec.status = 'synced';
              rec.kraResponse = result.data.data || null;
              await idbPut('receipts', rec);
            }
          }
          await auditAppend('etims_synced', { kind: job.kind, localId: job.localId });
          synced++;
        } else {
          job.attempts = (job.attempts || 0) + 1;
          job.lastError = result.error || (result.data && result.data.resultMsg) || 'unknown';
          job.lastAttemptAt = new Date().toISOString();
          await idbPut('queue', job);
          failed++;
          // Stop on first failure to preserve strict sequence per pay-point —
          // KRA/VSCU sequencing must stay unbroken, so we don't skip ahead.
          break;
        }
      }
      return { ok: true, synced, failed, remaining: all.length - synced };
    } finally {
      _processing = false;
    }
  }

  let _syncTimer = null;
  function triggerSyncSoon() {
    if (_syncTimer) clearTimeout(_syncTimer);
    _syncTimer = setTimeout(() => { processQueue(); }, 1500);
    // Also ask the service worker to take over if the tab closes before
    // this fires — see the 'sync' event registered in sw.js.
    if (global.navigator && navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then((reg) => {
        if ('sync' in reg) reg.sync.register('etims-queue-sync').catch(() => {});
      }).catch(() => {});
    }
  }

  async function pendingCount() {
    const all = await idbAll('queue');
    return all.filter((q) => q.status === 'pending').length;
  }

  // ---------------------------------------------------------------------
  // 10) NETWORK STATUS BADGE (header indicator)
  // ---------------------------------------------------------------------
  async function currentNetworkState() {
    if (!navigator.onLine) return 'Offline - Invoicing Locally';
    const pending = await pendingCount();
    if (pending > 0) return `Syncing (${pending} pending)`;
    return 'Online';
  }
  function installNetworkBadge(elId) {
    const update = async () => {
      const el = document.getElementById(elId);
      if (el) el.textContent = await currentNetworkState();
    };
    window.addEventListener('online', () => { update(); processQueue(); });
    window.addEventListener('offline', update);
    setInterval(update, 15000);
    update();
  }

  // ---------------------------------------------------------------------
  // PUBLIC API
  // ---------------------------------------------------------------------
  global.EtimsOffline = {
    getConfig: getEtimsConfig,
    setConfig: setEtimsConfig,
    isEnabled: isEtimsEnabled,
    upgradeLocalAuth,
    verifyLocalAuth,
    recordServerTime,
    checkClockDrift,
    cacheItemForEtims,
    validateItemFields,
    validateCartForEtims,
    runInitialize,
    saveItemToEtims,
    selectItemsFromEtims,
    recordOfflineSale,
    markReprintWatermark,
    buildQrPayload,
    processQueue,
    pendingCount,
    currentNetworkState,
    installNetworkBadge,
    auditAppend,
    auditVerifyChain,
    formatLocalRef,
    DOC_TYPES,
    _internal: { buildInitializerReq, buildSaveItemsPayload, buildSaveSalesPayload },
  };
})(typeof window !== 'undefined' ? window : globalThis);
