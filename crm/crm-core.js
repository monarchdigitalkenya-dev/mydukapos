/* MyDuka CRM - core: helpers, API client, UI kit, auth screens, shell + router. Classic script, no build. */
(function () {
  'use strict';
  const CRM = window.CRM = { routes: {}, nav: [], state: { me: null, config: null, staff: null, perms: new Set() }, timers: [] };

  /* ---------- tiny DOM builder (never innerHTML with data) ---------- */
  const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'readOnly', 'indeterminate']);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    let deferredValue;
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') deferredValue = v;
      else if (PROP_KEYS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    append(el, kids);
    if (deferredValue !== undefined) el.value = deferredValue;
    return el;
  }
  function append(el, kids) {
    for (const k of kids) {
      if (k == null || k === false) continue;
      if (Array.isArray(k)) append(el, k);
      else if (k instanceof Node) el.appendChild(k);
      else el.appendChild(document.createTextNode(String(k)));
    }
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function mount(el, ...kids) { clear(el); append(el, kids); return el; }

  /* ---------- icons: static markup only ---------- */
  const ICONS = {
    chat: '<path d="M4 5h16v11H9l-5 4V5z"/>', users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.5a3.5 3.5 0 010 7M18 14c2.2.6 3.5 2.6 3.5 6"/>',
    home: '<path d="M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1v-9z"/>', bell: '<path d="M6 17V11a6 6 0 1112 0v6l2 2H4l2-2zM10 21h4"/>',
    phone: '<path d="M5 3h4l2 5-2.5 1.5a11 11 0 006 6L16 13l5 2v4a2 2 0 01-2 2A16 16 0 013 5a2 2 0 012-2z"/>', mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    check: '<path d="M4 12l5 5L20 6"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4V7zM3 7l9 4 9-4M12 11v10"/>', flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>', money: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.7"/>',
    chart: '<path d="M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3"/>', gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', send: '<path d="M3 11l18-8-8 18-2-8-8-2z"/>', back: '<path d="M15 5l-7 7 7 7"/>', more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/>', upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>', download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
    moon: '<path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/>', sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
    logout: '<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/>', shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/>', wa: '<path d="M12 3a9 9 0 00-7.8 13.5L3 21l4.6-1.2A9 9 0 1012 3z"/><path d="M8.5 8.5c.5 3 3 5.5 6 6l1.3-1.6-2-1-1 .8a4 4 0 01-2-2l.8-1-1-2-1.6 1z"/>',
    star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z"/>', user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
    edit: '<path d="M4 20l1-5L16 4l4 4L9 19l-5 1z"/>', trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', tag: '<path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="7.5" cy="8.5" r="1.3"/>', list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>', target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5z"/>', lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>', pin: '<path d="M12 21s7-6 7-11a7 7 0 10-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>'
  };
  function ic(name, cls) {
    const s = document.createElement('span');
    s.className = 'ic' + (cls ? ' ' + cls : '');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || ICONS.more) + '</svg>'; // static markup
    return s;
  }
  function logoMark(cls) {
    const s = document.createElement('span');
    s.className = 'logo ' + (cls || '');
    s.innerHTML = '<svg viewBox="0 0 512 512" width="100%" height="100%" aria-hidden="true"><rect width="512" height="512" rx="112" fill="#075E54"/><path d="M256 96c-88 0-160 66-160 148 0 36 14 69 38 95l-14 68 72-24c19 8 42 13 64 13 88 0 160-66 160-148S344 96 256 96z" fill="#25D366"/><path d="M168 300v-96l56 60 32-44 32 44 56-60v96" fill="none" stroke="#fff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return s;
  }

  /* ---------- value helpers ---------- */
  function pick(o, ...keys) { if (!o) return undefined; for (const k of keys) { if (o[k] != null && o[k] !== '') return o[k]; } return undefined; }
  function listOf(x, ...keys) {
    if (Array.isArray(x)) return x;
    if (x && typeof x === 'object') { for (const k of [...keys, 'items', 'data', 'rows', 'results']) if (Array.isArray(x[k])) return x[k]; }
    return [];
  }
  function ts(v) { if (v == null || v === '') return null; if (typeof v === 'number') return v; const n = Number(v); if (!isNaN(n) && /^\d+$/.test(String(v))) return n; const d = Date.parse(v); return isNaN(d) ? null : d; }
  const NBO = 3 * 3600 * 1000; // Africa/Nairobi is UTC+3 all year
  function ymd(ms) { const d = new Date((ms == null ? Date.now() : ms) + NBO); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); }
  function addDays(dateStr, n) { const [y, m, d] = dateStr.split('-').map(Number); return ymd(Date.UTC(y, m - 1, d + n) - NBO + 12 * 3600 * 1000); }
  function dayStartMs(dateStr) { return Date.parse(dateStr + 'T00:00:00+03:00'); }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(v) { const t = ts(v); if (t == null) return ''; const d = new Date(t + NBO); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + (d.getUTCFullYear() !== new Date(Date.now() + NBO).getUTCFullYear() ? ' ' + d.getUTCFullYear() : ''); }
  function fmtTime(v) { const t = ts(v); if (t == null) return ''; const d = new Date(t + NBO); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); }
  function fmtDT(v) { const t = ts(v); return t == null ? '' : fmtDate(t) + ', ' + fmtTime(t); }
  function rel(v) {
    const t = ts(v); if (t == null) return '';
    const diff = Date.now() - t; const a = Math.abs(diff);
    if (a < 60e3) return 'now';
    if (a < 3600e3) return Math.round(a / 60e3) + 'm' + (diff < 0 ? ' left' : '');
    if (ymd(t) === ymd()) return fmtTime(t);
    if (ymd(t) === addDays(ymd(), -1)) return 'Yesterday';
    return fmtDate(t);
  }
  function toLocalInput(v) { const t = ts(v); if (t == null) return ''; const d = new Date(t + NBO); return d.toISOString().slice(0, 16); }
  function fromLocalInput(s) { if (!s) return null; const t = Date.parse(s.length === 16 ? s + ':00+03:00' : s); return isNaN(t) ? null : t; }
  function money(n, cur) { if (n == null || n === '' || isNaN(Number(n))) return '-'; return (cur || 'KES') + ' ' + Number(n).toLocaleString('en-KE', { maximumFractionDigits: 0 }); }
  function num(n) { return n == null || n === '' || isNaN(Number(n)) ? '-' : Number(n).toLocaleString('en-KE', { maximumFractionDigits: 2 }); }
  function pct(n) { return n == null || isNaN(Number(n)) ? '-' : (Math.round(Number(n) * 10) / 10) + '%'; }
  function initials(name) { const p = String(name || '?').trim().split(/\s+/); return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
  const AV = ['#128C7E', '#075E54', '#34B7F1', '#7E57C2', '#E67E22', '#D81B60', '#5D4037', '#00897B'];
  function avatar(name, photo, size) {
    let n = 0; const s = String(name || '?'); for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
    const el = h('span', { class: 'avatar' + (size ? ' ' + size : ''), style: { background: AV[n % AV.length] }, 'aria-hidden': 'true' });
    if (photo && /^(data:image\/|https:\/\/|\/)/.test(String(photo))) { const im = h('img', { alt: '', loading: 'lazy' }); im.src = photo; el.appendChild(im); } else el.textContent = initials(name);
    return el;
  }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function safeLS(op, k, v) { try { if (op === 'get') return localStorage.getItem(k); if (op === 'set') localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* private mode */ } return null; }
  function digits(s) { return String(s || '').replace(/[^\d]/g, ''); }
  function waNumber(phone) { let d = digits(phone); if (d.startsWith('00')) d = d.slice(2); if (d.startsWith('0')) d = '254' + d.slice(1); return d; }
  function telHref(phone) { return 'tel:' + String(phone || '').replace(/[^\d+]/g, ''); }
  function waHref(phone, text) { return 'https://wa.me/' + waNumber(phone) + (text ? '?text=' + encodeURIComponent(text) : ''); }

  /* ---------- API client ---------- */
  class ApiError extends Error { constructor(msg, status, code, data) { super(msg); this.status = status; this.code = code; this.data = data; } }
  function sessionToken() { return safeLS('get', 'crm_mode') === 'owner' ? (safeLS('get', 'pos_owner_session_token') || '') : (safeLS('get', 'crm_token') || ''); }
  function qs(o) { const p = []; for (const k of Object.keys(o || {})) { const v = o[k]; if (v == null || v === '' || v === false) continue; p.push(encodeURIComponent(k) + '=' + encodeURIComponent(v === true ? '1' : v)); } return p.length ? '?' + p.join('&') : ''; }
  // zip 161: (1) two identical GETs that are in flight at once share ONE request (a re-render or a double click no longer doubles the load);
  // (2) every navigation-bound GET is cancelled when the user moves to another screen (`bg: true` opts out: the polls); a cancelled request never settles, so a
  // half-finished screen cannot toast an error or draw over the new one.
  const inflight = new Map(); let navCtl = new AbortController();
  CRM.newNav = function () { inflight.clear(); try { navCtl.abort(); } catch (e) { /* old browser */ } navCtl = new AbortController(); };
  CRM.stats = { requests: 0, deduped: 0, aborted: 0 };
  const NEVER = new Promise(() => {});
  function api(path, opts) {
    opts = opts || {};
    const isGet = !(opts.method && opts.method !== 'GET') && opts.body === undefined && !opts.blob;
    if (!isGet) return apiCall(path, opts);
    const key = path + qs(opts.query) + '|' + (opts.token !== undefined ? opts.token : '') + (opts.bg ? '|bg' : '');
    const hit = inflight.get(key); if (hit) { CRM.stats.deduped++; return hit; }
    const nav = navCtl, sig = opts.signal || (opts.bg ? undefined : nav.signal);
    const p = apiCall(path, Object.assign({}, opts, { signal: sig })).catch((e) => { if (e && e.code === 'aborted') { CRM.stats.aborted++; return NEVER; } throw e; });
    inflight.set(key, p); const done = () => { if (inflight.get(key) === p) inflight.delete(key); }; p.then(done, done);
    return p;
  }
  async function apiCall(path, opts) {
    const headers = { Accept: 'application/json' };
    const tok = opts.token !== undefined ? opts.token : sessionToken();
    if (tok) headers.Authorization = 'Bearer ' + tok;
    let body;
    if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
    let res;
    try { res = await fetch('/api/crm' + path + qs(opts.query), { method: opts.method || (body !== undefined ? 'POST' : 'GET'), headers, body, cache: 'no-store', signal: opts.signal }); CRM.stats.requests++; }
    catch (e) { if (e && e.name === 'AbortError') throw new ApiError('Cancelled', 0, 'aborted'); throw new ApiError('Network problem - check your connection and try again.', 0, 'network'); }
    if (opts.blob) { if (!res.ok) throw new ApiError('Download failed (' + res.status + ')', res.status, 'download'); return res.blob(); }
    let data = null; const txt = await res.text();
    if (txt) { try { data = JSON.parse(txt); } catch (e) { data = { raw: txt }; } }
    if (!res.ok) {
      const code = data && data.code; let msg = (data && (data.error || data.message)) || ('Request failed (' + res.status + ')');
      if (code === 'crm_database_missing' || res.status === 503) msg = 'The CRM database is not set up on this server yet (' + (code || '503') + ').';
      if (res.status === 401 && !opts.noAuthRedirect && tok) { CRM.signOut(true); }
      if (data && data.fields && typeof data.fields === 'object') { const fm = Object.values(data.fields).filter((x) => typeof x === 'string').join('; '); if (fm) msg = fm; }
      if (res.status === 403) msg = msg || 'You do not have permission to do that.';
      throw new ApiError(msg, res.status, code, data);
    }
    return data == null ? {} : data;
  }
  async function download(path, filename, query) {
    const blob = await api(path, { blob: true, query });
    if (!(window.URL && URL.createObjectURL)) throw new ApiError('Downloads are not supported in this browser.', 0, 'nodl');
    const a = h('a', { download: filename }); a.href = URL.createObjectURL(blob); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function downloadText(text, filename, type) {
    if (!(window.URL && URL.createObjectURL)) return;
    const a = h('a', { download: filename }); a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/csv' })); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---------- toasts, modal, menus ---------- */
  function toast(msg, isErr) {
    const root = document && document.getElementById && document.getElementById('toasts'); if (!root) return;
    const t = h('div', { class: 'toast' + (isErr ? ' err' : ''), role: isErr ? 'alert' : 'status' }, msg);
    root.appendChild(t); setTimeout(() => t.remove(), isErr ? 6000 : 3200);
  }
  function fail(e) { if (e && e.status === 401) return; toast(e && e.message ? e.message : String(e), true); }
  function openModal(o) {
    const root = document.getElementById('modal-root'); const prev = document.activeElement;
    const body = h('div', { class: 'mbody' });
    const modal = h('div', { class: 'modal' + (o.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title || 'Dialog' });
    const overlay = h('div', { class: 'overlay' }, modal);
    const api_ = { el: modal, body, close() { overlay.remove(); document.removeEventListener('keydown', onKey, true); try { prev && prev.focus && prev.focus(); } catch (e) { /* gone */ } if (o.onClose) o.onClose(); }, setBusy(b) { modal.querySelectorAll('button.btn').forEach((x) => { x.disabled = !!b; }); } };
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); api_.close(); }
      if (ev.key === 'Tab') { const f = [...modal.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])')].filter((x) => x.offsetParent !== null || true); if (!f.length) return; const first = f[0], last = f[f.length - 1]; if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); } else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); } }
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) api_.close(); });
    append(body, [o.body]);
    append(modal, [h('h2', null, o.title || ''), body]);
    if (o.actions) {
      const bar = h('div', { class: 'actions' });
      o.actions.forEach((a) => bar.appendChild(h('button', { class: 'btn ' + (a.kind || ''), type: 'button', onclick: async () => {
        if (!a.onClick) return api_.close();
        api_.setBusy(true); let keep = false;
        try { keep = (await a.onClick(api_)) === false; } catch (e) { fail(e); keep = true; }
        if (keep) api_.setBusy(false);
        else api_.close();
      } }, a.label)));
      modal.appendChild(bar);
    }
    root.appendChild(overlay);
    const first = modal.querySelector('input:not([type=hidden]),select,textarea') || modal.querySelector('button');
    if (first) setTimeout(() => { try { first.focus(); } catch (e) { /* detached */ } }, 20);
    return api_;
  }
  function ask(title, message, okLabel, danger) {
    return new Promise((resolve) => {
      let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
      openModal({ title, body: h('p', null, message), onClose: () => finish(false), actions: [{ label: 'Cancel' }, { label: okLabel || 'OK', kind: danger ? 'danger' : 'primary', onClick: () => { finish(true); } }] });
    });
  }
  function popMenu(anchor, items) {
    document.querySelectorAll('.menu.pop').forEach((m) => m.remove());
    const m = h('div', { class: 'menu pop', role: 'menu' });
    const close = () => { m.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); };
    const outside = (e) => { if (!m.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
    const esc = (e) => { if (e.key === 'Escape') { close(); anchor.focus(); } };
    items.forEach((it) => { if (!it) return; if (it.head) m.appendChild(h('div', { class: 'mhead' }, it.head)); else m.appendChild(h('button', { class: 'navlink', role: 'menuitem', type: 'button', onclick: () => { close(); it.onClick(); } }, it.icon ? ic(it.icon) : null, it.label)); });
    anchor.parentNode.style.position = 'relative'; anchor.parentNode.appendChild(m);
    setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', esc, true); const f = m.querySelector('button'); if (f) f.focus(); }, 0);
    return m;
  }

  /* ---------- form + state components ---------- */
  function field(label, input, hint) { const id = 'f' + Math.random().toString(36).slice(2, 8); if (input.setAttribute && !input.id) input.id = id; return h('div', { class: 'field' }, h('label', { for: input.id || id }, label), input, hint ? h('span', { class: 'tiny faint' }, hint) : null); }
  function opt(v, l, sel) { return h('option', { value: v, selected: sel }, l); }
  function sel(options, value, attrs) {
    const s = h('select', attrs, options.map((o) => typeof o === 'string' ? opt(o, o) : opt(o.v, o.l)));
    if (value != null) s.value = String(value);
    return s;
  }
  function inp(type, attrs) { return h('input', Object.assign({ type }, attrs || {})); }
  function loading(label) { return h('div', { class: 'empty', role: 'status' }, h('div', { class: 'spinner', style: { margin: '0 auto 8px' } }), label || 'Loading...'); }
  function empty(msg, icon, action) { return h('div', { class: 'empty' }, ic(icon || 'chat'), h('div', null, msg), action ? h('div', { style: { marginTop: '10px' } }, action) : null); }
  function errbox(e, retry) { return h('div', { class: 'errbox', role: 'alert' }, h('div', null, (e && e.message) || String(e)), retry ? h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn sm', type: 'button', onclick: retry }, 'Try again')) : null); }
  function btn(label, onClick, kind, attrs) { return h('button', Object.assign({ class: 'btn ' + (kind || ''), type: 'button', onclick: onClick }, attrs || {}), label); }
  function cfg(kind) { const c = CRM.state.config || {}; return listOf(c[kind]).filter((x) => x); }
  function cfgFind(kind, v) { if (v && typeof v === 'object') v = pick(v, 'key', 'id'); return cfg(kind).find((i) => String(i.key) === String(v) || String(i.id) === String(v)); }
  function cfgLabel(kind, v) { if (v && typeof v === 'object') return pick(v, 'label', 'name', 'key') || ''; const i = cfgFind(kind, v); return i ? i.label : (v == null ? '' : String(v)); }
  function pill(label, color) {
    const p = h('span', { class: 'pill' }, h('span', { class: 'sw' }), label);
    if (color && /^#[0-9a-f]{6}$/i.test(color)) { p.style.background = color + '26'; p.style.color = color; }
    return p;
  }
  function cfgPill(kind, v) { if (v == null || v === '') return h('span', { class: 'faint' }, '-'); const i = cfgFind(kind, v); return pill(cfgLabel(kind, v), i && i.color); }
  function cfgOptions(kind, withBlank, blankLabel, includeInactive) {
    const o = withBlank ? [{ v: '', l: blankLabel || 'All' }] : [];
    cfg(kind).filter((i) => includeInactive || i.active !== false).forEach((i) => o.push({ v: i.key != null ? i.key : i.id, l: i.label }));
    return o;
  }
  // statuses a person may set by hand: active, and never "won" (won is reached only through Convert, which records the sale)
  function statusPick(blank, blankLabel, current) {
    const o = blank ? [{ v: '', l: blankLabel || '' }] : [];
    cfg('statuses').filter((i) => (i.active !== false && !i.isWon) || String(i.key) === String(current)).forEach((i) => o.push({ v: i.key, l: i.label + (i.isWon ? ' (use Convert)' : '') }));
    return o;
  }
  function pager(state, total, onChange) {
    const size = state.pageSize || 25, pages = Math.max(1, Math.ceil(total / size));
    return h('div', { class: 'pager' },
      h('button', { class: 'btn sm', type: 'button', disabled: state.page <= 1, onclick: () => onChange(state.page - 1) }, 'Previous'),
      h('span', { class: 'small muted' }, 'Page ' + state.page + ' of ' + pages + ' - ' + total + ' total'),
      h('button', { class: 'btn sm', type: 'button', disabled: state.page >= pages, onclick: () => onChange(state.page + 1) }, 'Next'));
  }
  function tabs(items, current, onPick) {
    const bar = h('div', { class: 'tabs', role: 'tablist' });
    items.forEach((it) => bar.appendChild(h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': it.v === current ? 'true' : 'false', onclick: () => onPick(it.v) }, it.l)));
    return bar;
  }

  /* ---------- date presets ---------- */
  const PRESETS = [{ v: 'today', l: 'Today' }, { v: 'yesterday', l: 'Yesterday' }, { v: 'week', l: 'This week' }, { v: '7d', l: 'Last 7 days' }, { v: 'month', l: 'This month' }, { v: 'lastmonth', l: 'Last month' }, { v: 'custom', l: 'Custom' }];
  function rangeDates(preset, cf, ct) {
    const today = ymd(); const [y, m] = today.split('-').map(Number);
    if (preset === 'today') return { from: today, to: today };
    if (preset === 'yesterday') { const d = addDays(today, -1); return { from: d, to: d }; }
    if (preset === 'week') { const dow = new Date(dayStartMs(today) + NBO).getUTCDay(); const back = (dow + 6) % 7; return { from: addDays(today, -back), to: today }; }
    if (preset === '7d') return { from: addDays(today, -6), to: today };
    if (preset === 'month') return { from: today.slice(0, 8) + '01', to: today };
    if (preset === 'lastmonth') { const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y; const last = new Date(Date.UTC(py, pm, 0)).getUTCDate(); const p2 = (n) => String(n).padStart(2, '0'); return { from: py + '-' + p2(pm) + '-01', to: py + '-' + p2(pm) + '-' + p2(last) }; }
    return { from: cf || today, to: ct || today };
  }
  function rangeBar(state, onChange) {
    const wrap = h('div', { class: 'filters' });
    const s = sel(PRESETS, state.range, { 'aria-label': 'Date range' });
    const f = inp('date', { value: state.from || '', 'aria-label': 'From date' }), t = inp('date', { value: state.to || '', 'aria-label': 'To date' });
    const custom = h('span', { class: 'row' + (state.range === 'custom' ? '' : ' hidden') }, f, t, btn('Apply', () => { state.from = f.value; state.to = t.value; onChange(); }, 'sm'));
    s.addEventListener('change', () => { state.range = s.value; const d = rangeDates(s.value, f.value, t.value); if (s.value !== 'custom') { state.from = d.from; state.to = d.to; } custom.classList.toggle('hidden', s.value !== 'custom'); if (s.value !== 'custom') onChange(); });
    wrap.append(s, custom);
    return wrap;
  }

  /* ---------- session, permissions ---------- */
  const can = (k) => CRM.state.perms.has(k) || CRM.state.perms.has('*');
  const canAny = (...ks) => ks.some(can);
  CRM.signOut = function (expired) {
    safeLS('del', 'crm_token'); safeLS('del', 'crm_mode');
    CRM.state.me = null; CRM.state.perms = new Set(); CRM.state.staff = null; CRM.state.bell = null; CRM.state.meta = null; window.__crmBoot = null;
    CRM.timers.forEach((t) => clearInterval(t)); CRM.timers = [];
    CRM.go('#/signin');
  };
  async function staffList(force) {
    if (CRM.state.staff && !force) return CRM.state.staff;
    let items = [];
    try { items = listOf(await api('/staff'), 'staff'); } catch (e) { const me = CRM.state.me; items = me ? [me] : []; }
    CRM.state.staff = items; return items;
  }
  function staffOptions(items, blank, blankLabel) {
    const o = blank ? [{ v: '', l: blankLabel || 'Anyone' }] : [];
    items.filter((u) => (u.status || 'active') === 'active').forEach((u) => o.push({ v: u.id, l: u.name || u.email }));
    return o;
  }
  function staffName(id) { const u = (CRM.state.staff || []).find((x) => String(x.id) === String(id)); return u ? u.name : ''; }

  /* ---------- router + shell ---------- */
  function route(name, fn, meta) { CRM.routes[name] = fn; if (meta) CRM.nav.push(Object.assign({ name }, meta)); }
  CRM.route = route;
  // decodeURIComponent throws on a stray "%" (a pasted / mangled link): the raw text is kept instead of crashing the router
  const dec = (v) => { try { return decodeURIComponent(v); } catch (e) { return v; } };
  function parseHash() {
    const raw = (location.hash || '').replace(/^#\/?/, ''); const [path, query] = raw.split('?'); const q = {};
    (query || '').split('&').filter(Boolean).forEach((p) => { const i = p.indexOf('='); const k = i < 0 ? p : p.slice(0, i), v = i < 0 ? '' : p.slice(i + 1); q[dec(k)] = dec(v.replace(/\+/g, ' ')); });
    const parts = path.split('/').filter(Boolean).map(dec);
    return { parts, q, name: parts[0] || '' };
  }
  let renderSeq = 0;
  CRM.go = function (hash) { if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = hash; };
  CRM.parseHash = parseHash;
  const PUBLIC = new Set(['signin', 'invite', 'reset']);

  CRM.render = async function () {
    const app = document.getElementById('app'); const r = parseHash(); const seq = ++renderSeq; CRM.newNav();
    document.querySelectorAll('.menu.pop').forEach((m) => m.remove());
    if (PUBLIC.has(r.name)) { CRM.shell = null; mount(app); await CRM.authScreens[r.name](app, r); return; }
    if (!sessionToken()) { location.hash = '#/signin'; return; }
    if (!CRM.state.me) {
      mount(app, h('div', { class: 'boot' }, h('div', { class: 'spinner' })));
      try { await loadMe(); } catch (e) { if (seq !== renderSeq) return; if (e.status === 401) return; mount(app, h('div', { class: 'authwrap' }, h('div', { class: 'authcard' }, errbox(e, () => CRM.render()), h('div', { style: { marginTop: '10px' } }, btn('Sign out', () => CRM.signOut(), 'sm'))))); return; }
    }
    if (!CRM.shell || !document.body.contains(CRM.shell.view)) buildShell(app);
    const name = CRM.routes[r.name] ? r.name : (CRM.defaultRoute());
    if (name !== r.name) { location.hash = '#/' + name; return; }
    highlightNav(name);
    const view = CRM.shell.view; mount(view, loading());
    CRM.shell.title.textContent = (CRM.nav.find((n) => n.name === name) || {}).label || 'MyDuka CRM';
    document.title = CRM.shell.title.textContent + ' - MyDuka CRM';
    const ctx = { root: view, parts: r.parts, q: r.q, alive: () => seq === renderSeq, setTitle: (t) => { CRM.shell.title.textContent = t; }, flush: (on) => view.classList.toggle('flush', !!on) };
    view.classList.remove('flush');
    try { await CRM.routes[name](ctx); } catch (e) { if (ctx.alive() && e.status !== 401) mount(view, errbox(e, () => CRM.render())); }
    try { view.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  };
  CRM.defaultRoute = () => 'dashboard';

  async function loadMe() {
    // zip 161: ONE request (/boot) carries the profile + the config lists + the staff names + the first notifications and unread counts (it replaces /me, /staff twice, /notifications
    // and /inbox/conversations at start-up). An older server without /boot answers 404 and the classic requests are used.
    let d = null;
    try { const b = await (window.__crmBoot || api('/boot')); window.__crmBoot = null; if (b && b.me) { d = b.me; if (b.staff && b.staff.items) CRM.state.staff = b.staff.items; if (b.notifications) applyBell(b.notifications, b.inboxUnread); } } catch (e) { window.__crmBoot = null; if (e && e.status === 401) throw e; d = null; }
    if (!d) d = await api('/me');
    const me = d.user || d; CRM.state.me = me; CRM.state.perms = new Set(listOf(me.perms || d.perms));
    CRM.state.config = d.config || CRM.state.config;
    if (!CRM.state.config) { try { CRM.state.config = await api('/config'); } catch (e) { CRM.state.config = {}; } }
    if (!CRM.state.staff) staffList();
  }
  CRM.reloadConfig = async function () { CRM.state.config = await api('/config'); return CRM.state.config; };

  const NAV_VISIBLE = {
    dashboard: () => true, inbox: () => can('inbox.view'), leads: () => can('leads.view'), followups: () => can('followups.manage'),
    calendar: () => canAny('meetings.manage', 'leads.view'), products: () => true, campaigns: () => can('campaigns.view'),
    sales: () => canAny('revenue.own', 'revenue.team', 'revenue.company', 'sales.record'), reports: () => canAny('reports.own', 'reports.team', 'reports.company'),
    staff: () => can('staff.view'), settings: () => canAny('settings.manage', 'settings.integrations', 'settings.products', 'settings.statuses'), audit: () => can('audit.view')
  };
  const BOTTOM = ['dashboard', 'inbox', 'leads', 'followups'];
  const ORDER = ['dashboard', 'inbox', 'leads', 'followups', 'calendar', 'products', 'campaigns', 'sales', 'reports', 'staff', 'settings', 'audit'];
  function navItems() { return CRM.nav.slice().sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name)).filter((n) => (NAV_VISIBLE[n.name] || (() => true))()); }
  function highlightNav(name) {
    document.querySelectorAll('[data-nav]').forEach((a) => { if (a.getAttribute('data-nav') === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  }
  function buildShell(app) {
    const me = CRM.state.me; const items = navItems();
    const link = (n, cls) => h('a', { class: 'navlink ' + (cls || ''), href: '#/' + n.name, 'data-nav': n.name }, ic(n.icon), h('span', null, n.label), n.name === 'inbox' ? h('span', { class: 'badge hidden', id: 'inbox-badge' }) : null);
    const side = h('nav', { class: 'side', 'aria-label': 'Main' }, h('div', { class: 'brand' }, logoMark(), 'MyDuka CRM'), items.map((n) => link(n)));
    const more = items.filter((n) => !BOTTOM.includes(n.name));
    const bottom = h('nav', { class: 'bottomnav', 'aria-label': 'Main' }, items.filter((n) => BOTTOM.includes(n.name)).map((n) => link(n)),
      h('button', { class: 'navlink', type: 'button', 'aria-haspopup': 'menu', onclick: (e) => popMenuUp(e.currentTarget, more) }, ic('more'), h('span', null, 'More')));
    const title = h('h1', { id: 'page-title' }, 'MyDuka CRM');
    const bell = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Notifications', onclick: (e) => showNotifications(e.currentTarget) }, ic('bell'), h('span', { class: 'dot hidden', id: 'bell-dot' }));
    const themeBtn = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Toggle light/dark theme', onclick: toggleTheme }, ic('moon'));
    const userBtn = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Account menu', 'aria-haspopup': 'menu', onclick: (e) => popMenu(e.currentTarget, [{ head: me.name || me.email }, { label: 'Change password', icon: 'lock', onClick: changePassword }, { label: 'Sign out', icon: 'logout', onClick: () => CRM.signOut() }]) }, avatar(me.name || me.email, me.photo, 'sm'));
    const top = h('header', { class: 'topbar' }, h('span', { class: 'only-narrow' }, logoMark()), title, h('span', { style: { position: 'relative' } }, bell), themeBtn, h('span', { style: { position: 'relative' } }, userBtn));
    const view = h('main', { class: 'content', id: 'main', tabindex: '-1' });
    const shell = h('div', { class: 'shell' }, side, h('div', { class: 'main' }, top, view), bottom);
    mount(app, shell); CRM.shell = { view, title, root: shell };
    startPolling();
  }
  function popMenuUp(anchor, items) {
    const m = popMenu(anchor, items.map((n) => ({ label: n.label, icon: n.icon, onClick: () => { location.hash = '#/' + n.name; } })));
    m.style.top = 'auto'; m.style.bottom = '100%'; return m;
  }
  function applyTheme(t) { if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme'); }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark'; applyTheme(next); safeLS('set', 'crm_theme', next);
  }
  CRM.applyTheme = applyTheme;
  function changePassword() {
    const cur = inp('password', { autocomplete: 'current-password' }), nx = inp('password', { autocomplete: 'new-password' });
    openModal({ title: 'Change password', body: h('div', null, field('Current password', cur), field('New password (8+ characters)', nx)), actions: [{ label: 'Cancel' }, { label: 'Change', kind: 'primary', onClick: async () => {
      if (nx.value.length < 8) { toast('Use at least 8 characters.', true); return false; }
      const d = await api('/auth/password/change', { body: { current: cur.value, next: nx.value } });
      if (d && d.token) safeLS('set', 'crm_token', d.token);
      toast('Password changed.');
    } }] });
  }

  /* ---------- notifications ---------- */
  function applyBell(d, inboxUnread) {
    const items = listOf(d, 'notifications');
    const unread = d.unread != null ? d.unread : items.filter((n) => !n.read && !n.readAt).length;
    CRM.state.notifications = items;
    const dot = document.getElementById('bell-dot'); if (dot) { dot.textContent = unread > 9 ? '9+' : String(unread); dot.classList.toggle('hidden', !unread); }
    if (inboxUnread != null) { const badge = document.getElementById('inbox-badge'); if (badge) { badge.textContent = String(inboxUnread); badge.classList.toggle('hidden', !inboxUnread); } }
    CRM.state.bell = { unread, inboxUnread };
  }
  // zip 161: the bell and the Inbox badge come from ONE small request (the server now adds `inboxUnread` to /notifications; before, the app also fetched up to 200 conversations
  // (~78 KB) every 45 s just to count them). `bg` = not cancelled by navigation. Older servers do not send inboxUnread: the old second request is the fallback.
  let polling = false;
  async function pollNotifications() {
    if (polling) return; polling = true;
    try {
      const d = await api('/notifications', { query: { pageSize: 20 }, bg: true });
      let ib = d.inboxUnread != null ? d.inboxUnread : null;
      if (ib == null && can('inbox.view')) { try { const c = await api('/inbox/conversations', { query: { unread: 1 }, bg: true }); const cl = listOf(c, 'conversations'); ib = c.unread != null ? c.unread : (c.total != null ? c.total : cl.filter((x) => Number(pick(x, 'unread', 'unreadCount', 'unread_count') || 0) > 0).length); } catch (e) { ib = null; } }
      applyBell(d, ib);
    } catch (e) { /* silent: polling */ } finally { polling = false; }
  }
  // visibility-aware: nothing is fetched while the tab is hidden, and coming back refreshes at once (if the last look is older than 20 s)
  let lastPoll = 0;
  function startPolling() {
    CRM.timers.forEach((t) => clearInterval(t)); CRM.timers = [];
    if (!CRM.state.bell) { lastPoll = Date.now(); pollNotifications(); }
    CRM.timers.push(setInterval(() => { if (!document.hidden) { lastPoll = Date.now(); pollNotifications(); } }, 45000));
    if (!CRM._vis) { CRM._vis = true; document.addEventListener('visibilitychange', () => { if (!document.hidden && CRM.shell && Date.now() - lastPoll > 20000) { lastPoll = Date.now(); pollNotifications(); } }); }
  }
  CRM.pollNotifications = pollNotifications;
  async function showNotifications() {
    const body = h('div', null, loading());
    const m = openModal({ title: 'Notifications', body, actions: [{ label: 'Mark all read', onClick: async () => { await api('/notifications/read', { body: { all: true } }); pollNotifications(); } }, { label: 'Close', kind: 'primary' }] });
    try {
      const d = await api('/notifications'); const items = listOf(d, 'notifications');
      mount(body, items.length ? items.map((n) => {
        const link = pick(n, 'link', 'url'); const leadId = pick(n, 'leadId', 'lead_id');
        const href = link && String(link).startsWith('#') ? link : (n.entity === 'conversation' && n.entityId ? '#/inbox/' + encodeURIComponent(n.entityId) : (leadId ? '#/leads/' + leadId : null));
        const read = n.read || n.readAt;
        return h('div', { class: 'listrow' }, read ? null : h('span', { class: 'unread-dot' }), h('div', { class: 'grow' },
          href ? h('a', { href, onclick: () => m.close() }, pick(n, 'title', 'message', 'text') || 'Notification') : h('div', null, pick(n, 'title', 'message', 'text') || 'Notification'),
          pick(n, 'body') ? h('div', { class: 'small muted' }, n.body) : null, h('div', { class: 'tiny faint' }, fmtDT(pick(n, 'at', 'createdAt', 'created_at')))));
      }) : empty('You are all caught up.', 'bell'));
    } catch (e) { mount(body, errbox(e)); }
  }

  /* ---------- auth screens ---------- */
  function authShell(app, ...kids) { mount(app, h('div', { class: 'authwrap' }, h('div', { class: 'authcard' }, h('div', { class: 'brand' }, logoMark(), 'MyDuka CRM'), kids))); }
  function downscalePhoto(file) {
    return new Promise((resolve) => {
      if (!file || !/^image\//.test(file.type) || !window.FileReader) return resolve(null);
      const fr = new FileReader();
      fr.onload = () => {
        const img = new Image();
        img.onload = () => { try { const c = document.createElement('canvas'); const s = 192; c.width = s; c.height = s; const cx = c.getContext('2d'); if (!cx) return resolve(null); const m = Math.min(img.width, img.height); cx.drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, s, s); resolve(c.toDataURL('image/jpeg', 0.8)); } catch (e) { resolve(null); } };
        img.onerror = () => resolve(null); img.src = fr.result;
      };
      fr.onerror = () => resolve(null); fr.readAsDataURL(file);
    });
  }
  CRM.downscalePhoto = downscalePhoto;
  CRM.authScreens = {
    async signin(app) {
      const email = inp('email', { autocomplete: 'username', required: true, placeholder: 'you@company.com' }), pw = inp('password', { autocomplete: 'current-password', required: true });
      const err = h('div', { class: 'hidden' }); const go = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%' } }, 'Sign in');
      const form = h('form', { novalidate: true, onsubmit: async (ev) => {
        ev.preventDefault(); err.classList.add('hidden');
        if (!email.value.trim() || !pw.value) { mount(err, errbox({ message: 'Enter your email and password.' })); err.classList.remove('hidden'); return; }
        go.disabled = true;
        try {
          const d = await api('/auth/login', { body: { email: email.value.trim(), password: pw.value }, token: '', noAuthRedirect: true });
          safeLS('set', 'crm_token', d.token); safeLS('set', 'crm_mode', 'staff'); CRM.state.me = null; CRM.go('#/dashboard');
        } catch (e) { mount(err, errbox(e)); err.classList.remove('hidden'); go.disabled = false; }
      } }, field('Email', email), field('Password', pw), err, go);
      const ownerTok = safeLS('get', 'pos_owner_session_token');
      authShell(app, h('h2', { class: 'center', style: { margin: '4px 0 14px' } }, 'Sign in'), form,
        ownerTok ? h('div', null, h('div', { class: 'sep' }), btn('Continue as owner', () => { safeLS('set', 'crm_mode', 'owner'); CRM.state.me = null; CRM.go('#/dashboard'); }, 'wa', { style: { width: '100%' } })) : null,
        h('p', { class: 'small muted center', style: { marginTop: '12px' } }, 'Forgot your password? Ask your manager for a reset link.'));
    },
    async reset(app, r) {
      const token = r.q.token || ''; const pw = inp('password', { autocomplete: 'new-password' }), pw2 = inp('password', { autocomplete: 'new-password' }); const err = h('div', { class: 'hidden' });
      const form = h('form', { novalidate: true, onsubmit: async (ev) => {
        ev.preventDefault(); err.classList.add('hidden');
        let m = ''; if (!token) m = 'This reset link is incomplete.'; else if (pw.value.length < 8) m = 'Use at least 8 characters.'; else if (pw.value !== pw2.value) m = 'The passwords do not match.';
        if (m) { mount(err, errbox({ message: m })); err.classList.remove('hidden'); return; }
        try { await api('/auth/reset/accept', { body: { token, password: pw.value }, token: '', noAuthRedirect: true }); toast('Password updated. Sign in with your new password.'); location.hash = '#/signin'; }
        catch (e) { mount(err, errbox(e)); err.classList.remove('hidden'); }
      } }, field('New password', pw, 'At least 8 characters'), field('Confirm password', pw2), err, h('button', { class: 'btn primary', type: 'submit', style: { width: '100%' } }, 'Set new password'));
      authShell(app, h('h2', { class: 'center', style: { margin: '4px 0 14px' } }, 'Reset your password'), form);
    },
    async invite(app, r) {
      const token = r.q.token || ''; authShell(app, loading('Checking your invitation...'));
      let inv; try { inv = await api('/auth/invite', { query: { token }, token: '', noAuthRedirect: true }); } catch (e) { authShell(app, h('h2', { class: 'center' }, 'Invitation problem'), errbox(e), h('p', { class: 'center' }, h('a', { href: '#/signin' }, 'Go to sign in'))); return; }
      const name = inp('text', { value: inv.name || '', autocomplete: 'name' }), phone = inp('tel', { value: inv.phone || '', autocomplete: 'tel' });
      const pw = inp('password', { autocomplete: 'new-password' }), pw2 = inp('password', { autocomplete: 'new-password' }), photo = inp('file', { accept: 'image/*' }); const err = h('div', { class: 'hidden' });
      const form = h('form', { novalidate: true, onsubmit: async (ev) => {
        ev.preventDefault(); err.classList.add('hidden');
        let m = ''; if (!name.value.trim()) m = 'Enter your name.'; else if (pw.value.length < 8) m = 'Use at least 8 characters for your password.'; else if (pw.value !== pw2.value) m = 'The passwords do not match.';
        if (m) { mount(err, errbox({ message: m })); err.classList.remove('hidden'); return; }
        try {
          const body = { token, password: pw.value, name: name.value.trim(), phone: phone.value.trim() || undefined };
          if (photo.files && photo.files[0]) { const p = await downscalePhoto(photo.files[0]); if (p) body.photo = p; }
          const d = await api('/auth/invite/accept', { body, token: '', noAuthRedirect: true });
          safeLS('set', 'crm_token', d.token); safeLS('set', 'crm_mode', 'staff'); CRM.state.me = null; CRM.go('#/dashboard');
        } catch (e) { mount(err, errbox(e)); err.classList.remove('hidden'); }
      } }, h('div', { class: 'notice', style: { marginBottom: '10px' } }, 'You have been invited as ', h('b', null, cfgRole(inv.role)), h('br'), h('span', { class: 'small' }, inv.email || '')),
        field('Your name', name), field('Phone (optional)', phone), field('Profile photo (optional)', photo), field('Choose a password', pw, 'At least 8 characters'), field('Confirm password', pw2), err,
        h('button', { class: 'btn primary', type: 'submit', style: { width: '100%' } }, 'Accept invitation'));
      authShell(app, h('h2', { class: 'center', style: { margin: '4px 0 14px' } }, 'Welcome to MyDuka CRM'), form);
    }
  };
  function cfgRole(r) { return ({ owner: 'Owner', manager: 'Manager', sales: 'Sales' })[r] || r || 'team member'; }

  /* export shared kit */
  Object.assign(CRM, { h, append, clear, mount, ic, logoMark, pick, listOf, ts, ymd, addDays, dayStartMs, fmtDate, fmtTime, fmtDT, rel, toLocalInput, fromLocalInput, money, num, pct, initials, avatar, debounce, safeLS, waNumber, telHref, waHref,
    api, ApiError, download, downloadText, qs, toast, fail, openModal, ask, popMenu, field, opt, sel, inp, loading, empty, errbox, btn, cfg, cfgFind, cfgLabel, pill, cfgPill, cfgOptions, statusPick, pager, tabs, PRESETS, rangeDates, rangeBar,
    can, canAny, staffList, staffOptions, staffName, cfgRole, loadMe, sessionToken, NBO });
})();
