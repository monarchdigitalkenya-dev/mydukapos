/* Searchable dropdowns (zip 359). Every single-choice <select> with 3 or more options becomes a typing field: click it, the full list opens,
   type and the list narrows (all words must match), arrow keys + Enter or a tap picks. The original <select> stays in the page as the source of
   truth (hidden), so every existing handler, validation and value read keeps working. Opt a select out with data-nocombo. */
(function () {
    'use strict';
    if (window.__hcb) return; window.__hcb = 1;
    var MIN = 3, MAXSHOW = 150, pop = null, act = null;
    var css = '.hcb{position:relative;display:inline-block;max-width:100%;vertical-align:middle}.hcb-in{width:100%;box-sizing:border-box;padding-right:26px!important;cursor:text;text-overflow:ellipsis;background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'8\' viewBox=\'0 0 12 8\'%3E%3Cpath d=\'M1 1l5 5 5-5\' fill=\'none\' stroke=\'%23667\' stroke-width=\'1.8\' stroke-linecap=\'round\'/%3E%3C/svg%3E")!important;background-repeat:no-repeat!important;background-position:right 9px center!important;background-size:12px 8px!important}' +
        '.hcb-hid{position:absolute!important;clip:rect(0 0 0 0)!important;width:1px!important;height:1px!important;min-width:0!important;margin:0!important;padding:0!important;border:0!important;overflow:hidden!important;opacity:0!important;pointer-events:none!important}' +
        '#hcb-pop{position:fixed;z-index:2147483000;background:var(--card-bg,#fff);color:var(--dark,#1b2a4a);border:1px solid #b9c8e6;border-radius:10px;box-shadow:0 14px 36px rgba(0,30,90,.28);overflow:auto;font:14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:none}' +
        '#hcb-pop .o{padding:8px 11px;cursor:pointer;display:flex;gap:6px;align-items:center}#hcb-pop .o.on,#hcb-pop .o:hover{background:#e3efff}#hcb-pop .o.cur{font-weight:700}#hcb-pop .o.cur::after{content:"\\2713";margin-left:auto;color:#0a6fd6}#hcb-pop .o.dis{opacity:.45;pointer-events:none}' +
        '#hcb-pop .g{padding:6px 11px 3px;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:#6b7a99;background:rgba(0,40,120,.05)}#hcb-pop .m{padding:8px 11px;color:#6b7a99;font-size:12.5px}#hcb-pop mark{background:#ffe58a;color:inherit;border-radius:3px;padding:0 1px}';
    var st = document.createElement('style'); st.id = 'hcb-css'; st.textContent = css; (document.head || document.documentElement).appendChild(st);
    var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
    function optsOf(sel) { return Array.prototype.map.call(sel.options, function (o, i) { return { v: o.value, t: o.text, g: o.parentNode && o.parentNode.tagName === 'OPTGROUP' ? o.parentNode.label : '', d: o.disabled, i: i }; }); }
    function labelOf(sel) { var o = sel.options[sel.selectedIndex]; return o ? o.text : ''; }
    function eligible(sel) { return !sel.multiple && !(sel.size > 1) && !sel.hasAttribute('data-nocombo') && !sel.__hcb && sel.options.length >= MIN && !(sel.closest && sel.closest('.hcb,#hcb-pop')); }
    function sync(sel) {
        var h = sel.__hcb; if (!h) return;
        var o = sel.options[sel.selectedIndex], empty = !o || o.value === '';
        if (document.activeElement !== h.inp) { h.inp.value = empty ? '' : o.text; }
        h.inp.placeholder = empty && o ? o.text : (sel.getAttribute('data-ph') || 'Type to search…');
        h.inp.disabled = sel.disabled; h.inp.title = sel.title || '';
        h.w.style.display = (sel.hidden || sel.style.display === 'none') ? 'none' : '';
    }
    function enhance(sel) {
        var cs = window.getComputedStyle(sel), par = sel.parentNode; if (!par) return;
        var w = document.createElement('span'); w.className = 'hcb';
        var inp = document.createElement('input'); inp.type = 'text'; inp.className = (sel.className || '') + ' hcb-in'; inp.autocomplete = 'off'; inp.spellcheck = false; inp.setAttribute('role', 'combobox'); inp.setAttribute('aria-autocomplete', 'list'); inp.setAttribute('aria-expanded', 'false');
        var al = sel.getAttribute('aria-label'); if (al) inp.setAttribute('aria-label', al); else if (sel.id) { var lb = document.querySelector('label[for="' + sel.id + '"]'); if (lb) inp.setAttribute('aria-label', lb.textContent.trim().slice(0, 80)); }
        inp.style.cssText = sel.style.cssText; inp.style.display = ''; inp.style.width = '100%'; inp.style.flex = ''; inp.style.margin = '';
        var pd = par && window.getComputedStyle(par).display, ow = sel.offsetWidth;
        w.style.cssText = sel.style.cssText; w.style.display = ''; w.style.padding = ''; w.style.border = '';
        if (/flex|grid/.test(pd || '')) { if (cs.flexGrow && cs.flexGrow !== '0') w.style.flex = cs.flex; w.style.minWidth = w.style.minWidth || (cs.minWidth !== '0px' && cs.minWidth !== 'auto' ? cs.minWidth : ''); if (!sel.style.width && ow && !(cs.flexGrow > 0)) w.style.width = Math.min(ow, 480) + 'px'; }
        else if (!sel.style.width) { if (par && ow && ow >= par.clientWidth * 0.9) w.style.width = '100%'; else if (ow) w.style.width = Math.min(ow, 480) + 'px'; }
        if (cs.display === 'block' || (/^(100%|auto)$/.test(sel.style.width || '') && cs.display !== 'inline-block')) { w.style.display = ''; if (cs.display === 'block' && !w.style.width) w.style.width = '100%'; }
        par.insertBefore(w, sel); w.appendChild(inp);
        sel.classList.add('hcb-hid'); sel.tabIndex = -1; sel.setAttribute('aria-hidden', 'true');
        if (sel.required) { sel.__req = true; sel.required = false; inp.required = true; }
        var h = { w: w, inp: inp, sel: sel }; sel.__hcb = h; inp.__sel = sel;
        sel.addEventListener('focus', function () { try { inp.focus(); } catch (e) { /* none */ } });
        inp.addEventListener('focus', function () { try { inp.select(); } catch (e) { /* none */ } openPop(sel, ''); });
        inp.addEventListener('click', function () { if (!act || act.sel !== sel) openPop(sel, ''); });
        inp.addEventListener('input', function () { openPop(sel, inp.value); });
        inp.addEventListener('keydown', onKey);
        inp.addEventListener('blur', function () { setTimeout(function () { if (act && act.sel === sel && document.activeElement !== inp) { closePop(); } if (document.activeElement !== inp) { inp.value = (sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].value !== '') ? labelOf(sel) : ''; } }, 120); });
        try { new MutationObserver(function () { sync(sel); }).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'style', 'label', 'selected'] }); } catch (e) { /* none */ }
        sync(sel);
    }
    function filt(sel, q) {
        var all = optsOf(sel), toks = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
        if (!toks.length) return all;
        var hit = all.filter(function (o) { var t = (o.t + ' ' + o.g).toLowerCase(); return toks.every(function (k) { return t.indexOf(k) >= 0; }); });
        var f = toks[0]; hit.sort(function (a, b) { var A = a.t.toLowerCase().indexOf(f) === 0 ? 0 : 1, B = b.t.toLowerCase().indexOf(f) === 0 ? 0 : 1; return A - B || a.i - b.i; });
        return hit;
    }
    function mark(t, q) { var toks = String(q || '').trim().split(/\s+/).filter(Boolean).map(function (k) { return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }); var s = esc(t); if (!toks.length) return s; try { return s.replace(new RegExp('(' + toks.join('|') + ')', 'ig'), '<mark>$1</mark>'); } catch (e) { return s; } }
    function openPop(sel, q) {
        var h = sel.__hcb; if (!h || sel.disabled) return;
        if (!pop) { pop = document.createElement('div'); pop.id = 'hcb-pop'; pop.setAttribute('role', 'listbox'); document.body.appendChild(pop); pop.addEventListener('mousedown', function (e) { e.preventDefault(); var o = e.target.closest('.o'); if (o && act) pick(act.sel, +o.getAttribute('data-i')); }); }
        var list = filt(sel, q), shown = list.slice(0, MAXSHOW), curIdx = sel.selectedIndex, lastG = null, html = '';
        shown.forEach(function (o) { if (o.g && o.g !== lastG) { html += '<div class="g">' + esc(o.g) + '</div>'; lastG = o.g; } html += '<div class="o' + (o.i === curIdx && o.v !== '' ? ' cur' : '') + (o.d ? ' dis' : '') + '" role="option" data-i="' + o.i + '">' + mark(o.t, q) + '</div>'; });
        if (!shown.length) html = '<div class="m">No match for “' + esc(q) + '”. Clear the box to see everything.</div>'; else if (list.length > shown.length) html += '<div class="m">' + (list.length - shown.length) + ' more … keep typing to narrow the list</div>';
        pop.innerHTML = html; pop.style.display = 'block'; h.inp.setAttribute('aria-expanded', 'true');
        act = { sel: sel, inp: h.inp, items: shown.filter(function (o) { return !o.d; }).map(function (o) { return o.i; }), pos: 0 };
        var first = pop.querySelector('.o:not(.dis)'); var on = q ? first : pop.querySelector('.o.cur') || first; if (on) { on.classList.add('on'); act.pos = Math.max(0, act.items.indexOf(+on.getAttribute('data-i'))); }
        place(); if (on && !q) { try { on.scrollIntoView({ block: 'nearest' }); } catch (e) { /* none */ } }
    }
    function place() {
        if (!act || !pop) return; var r = act.inp.getBoundingClientRect(), vh = window.innerHeight, vw = window.innerWidth;
        if (r.bottom < 0 || r.top > vh) { closePop(); return; }
        var below = vh - r.bottom - 8, above = r.top - 8, w = Math.max(r.width, 240); w = Math.min(w, vw - 12);
        pop.style.width = w + 'px'; pop.style.left = Math.max(6, Math.min(r.left, vw - w - 6)) + 'px';
        if (below >= 160 || below >= above) { pop.style.top = (r.bottom + 4) + 'px'; pop.style.bottom = ''; pop.style.maxHeight = Math.min(300, below) + 'px'; }
        else { pop.style.bottom = (vh - r.top + 4) + 'px'; pop.style.top = ''; pop.style.maxHeight = Math.min(300, above) + 'px'; }
    }
    function closePop() { if (pop) pop.style.display = 'none'; if (act) { try { act.inp.setAttribute('aria-expanded', 'false'); } catch (e) { /* none */ } } act = null; }
    var nativeSI = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex').set;
    function pick(sel, i) {
        var h = sel.__hcb, changed = sel.selectedIndex !== i; nativeSI.call(sel, i); sync(sel); closePop();
        if (h) { h.inp.value = (sel.options[i] && sel.options[i].value !== '') ? sel.options[i].text : ''; try { h.inp.blur(); } catch (e) { /* none */ } }
        if (changed) { sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    function onKey(e) {
        var inp = e.target, sel = inp.__sel; if (!sel) return;
        if (!act || act.sel !== sel) { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { openPop(sel, ''); e.preventDefault(); } return; }
        var rows = pop.querySelectorAll('.o:not(.dis)');
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!rows.length) return; act.pos = (act.pos + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; rows.forEach(function (r, k) { r.classList.toggle('on', k === act.pos); }); rows[act.pos].scrollIntoView({ block: 'nearest' }); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (rows.length) pick(sel, +rows[Math.min(act.pos, rows.length - 1)].getAttribute('data-i')); }
        else if (e.key === 'Tab') { if (rows.length && inp.value.trim() && filt(sel, inp.value).length === 1) pick(sel, +rows[0].getAttribute('data-i')); else closePop(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(); inp.value = (sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].value !== '') ? labelOf(sel) : ''; inp.blur(); }
    }
    // keep the typing field in step when other code sets the select's value
    ['value', 'selectedIndex'].forEach(function (p) {
        var d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, p); if (!d || !d.set || d.set.__hcb) return;
        var orig = d.set, w = function (v) { orig.call(this, v); if (this.__hcb) sync(this); }; w.__hcb = 1;
        try { Object.defineProperty(HTMLSelectElement.prototype, p, { get: d.get, set: w, configurable: true, enumerable: d.enumerable }); } catch (e) { /* none */ }
    });
    function scan() {
        var l = document.querySelectorAll('select'); for (var i = 0; i < l.length; i++) { var s = l[i]; if (eligible(s)) { try { enhance(s); } catch (e) { /* skip this one */ } } else if (s.__hcb) sync(s); }
        var ws = document.querySelectorAll('.hcb'); for (var k = 0; k < ws.length; k++) { var nx = ws[k].nextElementSibling; if (!(nx && nx.__hcb && nx.__hcb.w === ws[k])) ws[k].remove(); }
    }
    var pend = false; function later() { if (pend) return; pend = true; (window.requestAnimationFrame || setTimeout)(function () { pend = false; scan(); }); }
    try { new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) { /* interval below */ }
    window.addEventListener('scroll', function () { if (act) place(); }, true); window.addEventListener('resize', function () { if (act) place(); });
    document.addEventListener('mousedown', function (e) { if (act && !e.target.closest('.hcb') && !e.target.closest('#hcb-pop')) closePop(); }, true);
    setInterval(scan, 1200); if (document.readyState !== 'loading') scan(); else document.addEventListener('DOMContentLoaded', scan);
})();
