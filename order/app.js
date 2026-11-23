// Customer ordering page (zip 136). Opened by scanning a table / room / poolside QR code: /order/?t=<token>[&c=<shop link>].
// Everything shown is built with textContent (menu data is never parsed as HTML). Guests can order, cancel / swap (where allowed), see their bill and tell the
// cashier they paid. Money is only ever confirmed by the cashier on a till; this page then shows the order's live status from the database.
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  var T = qs.get('t') || '', C = qs.get('c') || '';
  var api = function (extra) { return '/api/qr-order?t=' + encodeURIComponent(T) + (C ? '&c=' + encodeURIComponent(C) : '') + (extra || ''); };
  var post = function (body) { return fetch('/api/qr-order' + (C ? '?c=' + encodeURIComponent(C) : ''), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); };
  var main = document.getElementById('main'), bar = document.getElementById('bar'), sheet = document.getElementById('sheet'), panel = document.getElementById('sheet-panel');
  var menu = null, pay = null, cart = [], cat = '', q = '', kind = '', SHOP = false;   // SHOP: a shop / pharmacy / water seller (not a restaurant): the words say "shop" and "staff", never "restaurant" or "waiter"
  function W(food, shop) { return SHOP ? shop : food; }
  function BIZ() { return (menu && menu.business && String(menu.business).trim()) || 'the shop'; }   // zip 376: the customer sees the real name ("Nadia Beauty"), never a guessed "the restaurant"
  var store = { get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  var money = function (n) { return 'KES ' + (Math.round(n * 100) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') e.textContent = attrs[k]; else if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { e.addEventListener(ev, attrs.on[ev]); }); else e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  function fail(msg) { main.textContent = ''; main.appendChild(el('p', { class: 'center', text: msg })); bar.hidden = true; }
  function key() { var k = store.get('qr-key'); if (!k) { k = 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('qr-key', k); } return k; }

  function load() {
    if (!/^[A-Za-z0-9_-]{32}$/.test(T)) { fail('This code is not valid. Please ask a member of staff.'); return; }
    fetch(api()).then(function (r) { return r.text().then(function (t) { var d = {}; try { d = JSON.parse(t); } catch (e) { d = {}; } return { ok: r.ok && !!d.location, d: d }; }); }).then(function (x) {
      if (!x.ok) { fail(x.d.error || 'This code is not valid. Please ask a member of staff.'); return; }
      document.getElementById('biz').textContent = x.d.business || 'Menu';
      kind = x.d.location.kind || '';
      document.getElementById('loc').textContent = (kind === 'online' ? '🏠 ' : '📍 ') + x.d.location.label;
      document.title = (x.d.business || 'Menu') + ' — ' + x.d.location.label;
      if (!x.d.open || !x.d.menu) { fail('Ordering by phone is closed right now. Please ask a member of staff.'); return; }
      menu = x.d.menu; pay = x.d.payment || null; SHOP = menu.style !== 'food';
      if (SHOP) { LABEL.CLAIMED = '👍 Confirmed — we have your order'; LABEL.PREPARING = '🔥 Being got ready'; LABEL.READY = '✅ Ready'; LABEL.SERVED = '✅ Done — thank you!'; }
      // a NEW session at this table / room (the previous guests left): nothing of theirs — cart, order — carries over
      if (store.get('qr-session') && store.get('qr-session') !== x.d.session) { store.set('qr-last-order', ''); store.set('qr-key', ''); cart = []; }
      store.set('qr-session', x.d.session || '');
      var last = store.get('qr-last-order');
      if (last) { track(last); return; }
      render();
    }).catch(function () { fail('No connection. Check your internet and try again.'); });
  }
  function groupsFor(it) { return (it.modifierGroupIds || []).map(function (id) { return menu.modifierGroups.find(function (g) { return g.id === id; }); }).filter(Boolean); }
  function render() {
    main.textContent = '';
    var search = el('input', { type: 'search', placeholder: W('Search the menu…', 'Search items…'), value: q, on: { input: function (e) { q = e.target.value.toLowerCase(); list(); } } });
    var chips = el('div', { class: 'chips' }, [''].concat(menu.categories).map(function (c) {
      return el('button', { type: 'button', class: 'chip' + (c === cat ? ' on' : ''), text: c || 'All', on: { click: function () { cat = c; render(); } } });
    }));
    var box = el('div', { id: 'items' });
    main.appendChild(search); main.appendChild(chips); main.appendChild(box);
    if (menu.note) main.insertBefore(el('p', { class: 'muted', text: menu.note }), search);
    list(); updateBar();
  }
  function list() {
    var box = document.getElementById('items'); if (!box) return;
    box.textContent = '';
    var items = menu.items.filter(function (i) { return (!cat || i.category === cat) && (!q || i.name.toLowerCase().indexOf(q) >= 0); });
    if (!items.length) box.appendChild(el('p', { class: 'muted', text: 'Nothing matches.' }));
    items.forEach(function (it) {
      var img = it.image ? el('img', { src: it.image + (C ? '&c=' + encodeURIComponent(C) : ''), alt: '', loading: 'lazy' }) : null;
      box.appendChild(el('div', { class: 'item' }, [img, el('div', { class: 'body' }, [
        el('div', { class: 'name', text: it.name }), it.description ? el('div', { class: 'desc', text: it.description }) : null,
        el('div', { class: 'price', text: money(it.price) })]),
        el('button', { type: 'button', class: 'add', text: 'Add', on: { click: function () { choose(it); } } })]));
    });
  }
  function choose(it) {
    var groups = groupsFor(it);
    if (!groups.length) { addLine(it, [], ''); return; }
    panel.textContent = '';
    panel.appendChild(el('h3', { text: it.name }));
    var err = el('div', { class: 'err' });
    groups.forEach(function (g) {
      panel.appendChild(el('div', { class: 'name', text: g.name + (g.required ? ' (required)' : '') + (g.max === 1 ? ' — choose one' : g.max > 1 ? ' — up to ' + g.max : '') }));
      g.options.forEach(function (o, i) {
        var inp = el('input', { type: g.max === 1 ? 'radio' : 'checkbox', name: 'g-' + g.id, 'data-g': g.id, 'data-i': String(i), style: 'width:auto' });
        panel.appendChild(el('label', { class: 'row' }, [el('span', {}, [inp, document.createTextNode(' ' + o.name)]), el('span', { class: 'muted', text: o.price ? '+' + money(o.price) : '' })]));
      });
    });
    var note = el('input', { type: 'text', placeholder: 'Note (e.g. no onions)', maxlength: '140' });
    panel.appendChild(note); panel.appendChild(err);
    panel.appendChild(el('button', { type: 'button', class: 'add', text: 'Add to order', on: { click: function () {
      var mods = [];
      for (var k = 0; k < groups.length; k++) {
        var g = groups[k], picked = Array.prototype.slice.call(panel.querySelectorAll('input[data-g="' + g.id + '"]:checked')).map(function (x) { return g.options[Number(x.getAttribute('data-i'))]; });
        if (g.required && !picked.length) { err.textContent = 'Choose ' + g.name + '.'; return; }
        if (g.max && picked.length > g.max) { err.textContent = g.name + ': at most ' + g.max + '.'; return; }
        mods = mods.concat(picked);
      }
      close(); addLine(it, mods, note.value.trim());
    } } }));
    panel.appendChild(el('button', { type: 'button', class: 'chip', text: 'Cancel', on: { click: close } }));
    sheet.classList.add('open');
  }
  function addLine(it, mods, note) {
    var sig = it.code + '|' + mods.map(function (m) { return m.name; }).join(',') + '|' + note;
    var ex = cart.find(function (l) { return l.sig === sig; });
    if (ex) ex.qty++; else cart.push({ sig: sig, code: it.code, name: it.name + (mods.length ? ' (' + mods.map(function (m) { return m.name; }).join(', ') + ')' : ''), price: it.price + mods.reduce(function (s, m) { return s + (m.price || 0); }, 0), qty: 1, modifiers: mods.map(function (m) { return m.name; }), note: note });
    updateBar();
  }
  function total() { return cart.reduce(function (s, l) { return s + l.price * l.qty; }, 0); }
  function updateBar() {
    var n = cart.reduce(function (s, l) { return s + l.qty; }, 0);
    bar.hidden = !n;
    document.getElementById('bar-sum').textContent = n + ' item' + (n === 1 ? '' : 's') + ' · ' + money(total());
  }
  function close() { sheet.classList.remove('open'); }
  sheet.addEventListener('click', function (e) { if (e.target === sheet) close(); });
  document.getElementById('bar-go').addEventListener('click', review);
  function review() {
    panel.textContent = '';
    panel.appendChild(el('h3', { text: 'Your order' }));
    cart.forEach(function (l, i) {
      panel.appendChild(el('div', { class: 'row' }, [el('div', {}, [el('div', { text: l.name }), l.note ? el('div', { class: 'muted', text: l.note }) : null]),
        el('div', { class: 'qty' }, [el('button', { type: 'button', text: '−', on: { click: function () { l.qty--; if (l.qty <= 0) cart.splice(i, 1); updateBar(); cart.length ? review() : close(); } } }), document.createTextNode(' ' + l.qty + ' '), el('button', { type: 'button', text: '+', on: { click: function () { l.qty++; updateBar(); review(); } } })]),
        el('div', { class: 'price', text: money(l.price * l.qty) })]));
    });
    panel.appendChild(el('div', { class: 'row' }, [el('strong', { text: 'Total' }), el('strong', { text: money(total()) })]));
    var online = kind === 'online';
    var name = el('input', { type: 'text', placeholder: online ? 'Your name' : 'Your name (optional)', maxlength: '60', value: store.get('qr-name') || '', autocomplete: 'name', 'aria-label': 'Your name' });
    name.addEventListener('input', function () { store.set('qr-name', name.value.trim()); });
    var phone = el('input', { type: 'tel', inputmode: 'tel', placeholder: 'Your phone number (e.g. 0712 345 678)', maxlength: '20', value: store.get('qr-phone') || '', autocomplete: 'tel', 'aria-label': 'Your phone number' });
    var mode = el('select', { 'aria-label': 'Delivery or pickup' }, [el('option', { value: 'delivery', text: '🛵 Deliver to me' }), el('option', { value: 'pickup', text: '🏃 I will collect it' })]);
    var addr = el('input', { type: 'text', placeholder: 'Where to deliver (area, building, landmark)', maxlength: '140', value: store.get('qr-addr') || '', autocomplete: 'street-address', 'aria-label': 'Delivery address' });
    phone.addEventListener('input', function () { store.set('qr-phone', phone.value.trim()); }); addr.addEventListener('input', function () { store.set('qr-addr', addr.value.trim()); });
    mode.addEventListener('change', function () { addr.hidden = mode.value !== 'delivery'; });
    var note = el('input', { type: 'text', placeholder: 'Anything else? (optional)', maxlength: '200', 'aria-label': 'Anything else? (optional)', value: store.get('qr-onote') || '' });
    note.addEventListener('input', function () { store.set('qr-onote', note.value); });
    var err = el('div', { class: 'err', role: 'alert' });
    var go = el('button', { type: 'button', class: 'go', text: 'Send order', style: 'width:100%; margin-top:10px; border:0; background:var(--brand); color:#fff; border-radius:10px; padding:14px; font-weight:700;' });
    go.addEventListener('click', function () {
      err.textContent = '';
      if (online) {
        var digits = phone.value.replace(/\D/g, '');
        if (name.value.trim().length < 2) { err.textContent = 'Please enter your name.'; name.focus(); return; }
        if (digits.length < 9) { err.textContent = 'Please enter a phone number we can reach you on.'; phone.focus(); return; }
        if (mode.value === 'delivery' && addr.value.trim().length < 3) { err.textContent = 'Please tell us where to deliver.'; addr.focus(); return; }
      }
      go.disabled = true; go.textContent = 'Sending…';
      store.set('qr-name', name.value.trim()); if (online) { store.set('qr-phone', phone.value.trim()); store.set('qr-addr', addr.value.trim()); }
      post({ action: 'order', t: T, key: key(), name: name.value.trim(), phone: online ? phone.value.trim() : '', mode: online ? mode.value : '', address: online ? addr.value.trim() : '', note: note.value.trim(), items: cart.map(function (l) { return { code: l.code, qty: l.qty, modifiers: l.modifiers, note: l.note, name: l.name }; }) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) {
          if (!x.ok) { err.textContent = x.d.error || 'Could not send the order.'; go.disabled = false; go.textContent = 'Send order'; return; }
          store.set('qr-key', ''); store.set('qr-onote', ''); store.set('qr-last-order', x.d.orderId); cart = []; close(); updateBar(); track(x.d.orderId);
        }).catch(function () { err.textContent = 'No connection — your order was not sent yet. Tap again to retry (it will not be sent twice).'; go.disabled = false; go.textContent = 'Send order'; });
    });
    (online ? [el('p', { class: 'muted', text: 'Your details, so ' + BIZ() + ' can reach you:' }), name, phone, mode, addr, note, err, go] : [name, note, err, go]).forEach(function (x) { panel.appendChild(x); });
    panel.appendChild(el('p', { class: 'muted', text: online ? 'Nothing is charged now. ' + BIZ() + ' confirms your order, then you pay on delivery or pickup (cash or M-Pesa).' : 'Nothing is charged now. Staff confirm your order, and you pay on your bill.' }));
    sheet.classList.add('open');
  }
  // zip 153: statuses follow the server (D1). Everything is built with textContent; nothing from the server is ever parsed as HTML.
  var LABEL = { SUBMITTED: '⏳ Sent — waiting for staff to pick it up', CLAIMED: '👍 Confirmed — a waiter has your order', PREPARING: '🔥 Being prepared', READY: '✅ Ready — on its way', SERVED: '🍽️ Served — enjoy!', BILLED: '🧾 Your bill is ready', PAID: '💚 Paid — thank you!', CANCELLED: '❌ Cancelled', REJECTED: '❌ Sorry — we could not take this order' };
  var timer = null, pending = {};
  function once(name) { if (!pending[name]) pending[name] = 'k' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); return pending[name]; }
  function done(name) { delete pending[name]; }
  function send(body, name, orderId) {
    return post(Object.assign({ t: T, key: once(name), orderId: orderId }, body)).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); });
  }
  function track(orderId) {
    fetch(api('&o=' + encodeURIComponent(orderId))).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); }).then(function (x) {
      if (!x.ok) { store.set('qr-last-order', ''); render(); return; }
      var o = x.d.order, editing = sheet.classList.contains('open');
      main.textContent = '';
      main.appendChild(el('div', { class: 'status', text: LABEL[o.status] || o.status }));
      if (o.owner && ['CLAIMED', 'PREPARING', 'READY', 'SERVED', 'BILLED'].indexOf(o.status) >= 0) main.appendChild(el('p', { class: 'muted', text: W('Your waiter: ', 'Looked after by: ') + o.owner }));
      if (o.billNo) main.appendChild(el('p', { class: 'muted', text: 'Bill no. ' + o.billNo }));
      if (o.cancelRequested) main.appendChild(el('p', { class: 'muted', text: '⏳ You asked to cancel — waiting for the staff to confirm.' }));
      (o.requests || []).filter(function (r) { return r.status === 'PENDING' && r.type === 'EXCHANGE'; }).forEach(function () { main.appendChild(el('p', { class: 'muted', text: '⏳ You asked to swap an item — waiting for the staff to confirm.' })); });
      var pendingLine = function (i) { return (o.requests || []).some(function (r) { return r.status === 'PENDING' && r.type === 'CANCEL' && r.payload && r.payload.line === i.line; }); };
      o.items.forEach(function (i) {
        if (i.removed) { main.appendChild(el('div', { class: 'row', style: 'opacity:.6;' }, [el('span', { style: 'text-decoration:line-through;', text: i.qty + '× ' + i.name }), el('span', { class: 'muted', text: 'Cancelled' })])); return; }
        main.appendChild(el('div', { class: 'row' }, [el('span', { text: i.qty + '× ' + i.name }), el('span', {}, [el('span', { text: money(i.price * i.qty) + ' ' }),
          o.canExchange ? el('button', { type: 'button', class: 'chip', text: 'Swap', on: { click: function () { swap(o, i); } } }) : null,
          pendingLine(i) ? el('span', { class: 'muted', text: ' ⏳ cancel requested' }) : (o.canCancelItem && o.items.filter(function (x) { return !x.removed; }).length > 1 ? el('button', { type: 'button', class: 'chip', text: 'Cancel', on: { click: function () { cancelItem(o, i); } } }) : null)])]));
        if (i.note) main.appendChild(el('p', { class: 'muted', style: 'margin:0 0 4px 12px;', text: 'Note: ' + i.note }));
      });
      if (o.kind === 'online' && o.phone) main.appendChild(el('p', { class: 'muted', text: 'We will call ' + o.phone + ' if we need to.' }));
      if (o.note) main.appendChild(el('p', { class: 'muted', text: 'Order note: ' + o.note }));
      main.appendChild(el('div', { class: 'row' }, [el('strong', { text: 'Total' }), el('strong', { text: money(o.total) })]));
      if (o.paid > 0) main.appendChild(el('div', { class: 'row' }, [el('span', { text: 'Paid so far' }), el('span', { text: money(o.paid) })]));
      if (o.paid > 0 && o.outstanding > 0) main.appendChild(el('div', { class: 'row' }, [el('strong', { text: 'Still to pay' }), el('strong', { text: money(o.outstanding) })]));
      (o.payments || []).forEach(function (p) {
        var t = p.status === 'CONFIRMED' ? '✅ confirmed' : p.status === 'REJECTED' ? '❌ not received — please pay again' : p.status === 'SUPERSEDED' ? '✅ settled at the till' : '⏳ waiting for the cashier to confirm';
        main.appendChild(el('p', { class: 'muted', text: (p.method === 'mpesa' ? 'M-Pesa ' : 'Cash ') + money(p.amount) + (p.mpesaCode ? ' · ' + p.mpesaCode : '') + ' — ' + t }));
      });
      if (o.canCancel) main.appendChild(el('button', { type: 'button', class: 'chip', style: 'margin-top:10px;', text: o.cancelMode === 'now' ? 'Cancel this order' : 'Ask to cancel this order', on: { click: function () { cancelOrder(o); } } }));
      if (o.canPay && o.total - o.paid - (o.pendingPay || 0) > 0.004) payBox(o);
      if (o.status === 'PAID') main.appendChild(el('p', { class: 'muted', text: 'Thank you for visiting.' }));
      main.appendChild(el('button', { type: 'button', class: 'add', style: 'margin-top:14px;', text: 'Order something else', on: { click: function () { clearTimeout(timer); store.set('qr-last-order', ''); render(); } } }));
      clearTimeout(timer);
      if (['PAID', 'REJECTED', 'CANCELLED'].indexOf(o.status) < 0) timer = setTimeout(function () { if (!sheet.classList.contains('open') && !document.activeElement.matches('input')) track(orderId); else timer = setTimeout(function () { track(orderId); }, 4000); }, 6000);
    }).catch(function () { clearTimeout(timer); if (!document.getElementById('conn-lost')) main.insertBefore(el('p', { id: 'conn-lost', class: 'err', role: 'status', text: '⚠️ Connection lost - retrying. What you see may be out of date.' }), main.firstChild); timer = setTimeout(function () { track(orderId); }, 10000); });
  }
  function cancelOrder(o) {
    panel.textContent = '';
    panel.appendChild(el('h3', { text: o.cancelMode === 'now' ? 'Cancel your order?' : 'Ask the staff to cancel?' }));
    panel.appendChild(el('p', { class: 'muted', text: o.cancelMode === 'now' ? 'Nobody has started it yet, so it is cancelled straight away.' : W('A waiter already has your order (it may be in preparation). We will ask them — they confirm.', 'We already have your order (it may be getting ready). We will ask the staff — they confirm.') }));
    var err = el('div', { class: 'err' });
    panel.appendChild(err);
    var why = el('input', { type: 'text', maxlength: '120', placeholder: 'Reason (optional)', 'aria-label': 'Reason for cancelling' });
    panel.insertBefore(why, err);
    panel.appendChild(el('button', { type: 'button', class: 'add', text: 'Yes, cancel it', on: { click: function () {
      send({ action: 'cancel', reason: why.value.trim() }, 'cancel-' + o.id, o.id).then(function (x) { if (!x.ok) { err.textContent = x.d.error || 'Could not cancel.'; done('cancel-' + o.id); return; } done('cancel-' + o.id); close(); track(o.id); }).catch(function () { err.textContent = 'No connection — tap again (it will not be cancelled twice).'; });
    } } }));
    panel.appendChild(el('button', { type: 'button', class: 'chip', text: 'No, keep it', on: { click: close } }));
    sheet.classList.add('open');
  }
  function cancelItem(o, it) {
    panel.textContent = '';
    panel.appendChild(el('h3', { text: 'Cancel ' + it.name + '?' }));
    panel.appendChild(el('p', { class: 'muted', text: o.cancelMode === 'now' ? 'Nobody has started your order yet, so this item comes off straight away.' : W('A waiter already has your order (it may be in preparation). We will ask the staff - they confirm.', 'We already have your order (it may be getting ready). We will ask the staff - they confirm.') }));
    var err = el('div', { class: 'err' }), why = el('input', { type: 'text', maxlength: '120', placeholder: 'Reason (optional)', 'aria-label': 'Reason for cancelling' });
    var nm = 'cancel-' + o.id + '-' + it.line;
    [why, err].forEach(function (x) { panel.appendChild(x); });
    panel.appendChild(el('button', { type: 'button', class: 'add', text: 'Yes, cancel this item', on: { click: function () {
      send({ action: 'cancel', line: it.line, reason: why.value.trim() }, nm, o.id).then(function (x) { if (!x.ok) { err.textContent = x.d.error || 'Could not cancel.'; done(nm); return; } done(nm); close(); track(o.id); }).catch(function () { err.textContent = 'No connection - tap again (it will not be cancelled twice).'; });
    } } }));
    panel.appendChild(el('button', { type: 'button', class: 'chip', text: 'No, keep it', on: { click: close } }));
    sheet.classList.add('open');
  }
  function swap(o, line) {
    panel.textContent = '';
    panel.appendChild(el('h3', { text: 'Swap ' + line.name }));
    panel.appendChild(el('p', { class: 'muted', text: o.exchangeMode === 'now' ? 'Pick what you would like instead.' : W('A waiter already has your order — we will ask them to swap it.', 'We already have your order — we will ask the staff to swap it.') }));
    var err = el('div', { class: 'err' }), box = el('div', {});
    var s = el('input', { type: 'search', placeholder: 'Search…', on: { input: function (e) { fill(e.target.value.toLowerCase()); } } });
    function fill(qq) {
      box.textContent = '';
      menu.items.filter(function (i) { return i.code !== line.code && (!qq || i.name.toLowerCase().indexOf(qq) >= 0); }).slice(0, 30).forEach(function (i) {
        box.appendChild(el('div', { class: 'row' }, [el('span', { text: i.name + ' · ' + money(i.price) }), el('button', { type: 'button', class: 'chip', text: 'Choose', on: { click: function () {
          var nm = 'swap-' + o.id + '-' + line.line + '-' + i.code;
          send({ action: 'exchange', line: line.line, toCode: i.code }, nm, o.id).then(function (x) { done(nm); if (!x.ok) { err.textContent = x.d.error || 'Could not swap.'; return; } close(); track(o.id); }).catch(function () { err.textContent = 'No connection — try again.'; });
        } } })]));
      });
    }
    fill('');
    [s, box, err].forEach(function (x) { panel.appendChild(x); });
    panel.appendChild(el('button', { type: 'button', class: 'chip', text: 'Close', on: { click: close } }));
    sheet.classList.add('open');
  }
  // How to pay: the shop's own details (till number etc.) come from the published menu — never typed here. The code is optional and is only a
  // reference; the cashier confirms the money.
  function payBox(o) {
    var due = Math.round((o.total - o.paid - (o.pendingPay || 0)) * 100) / 100;
    main.appendChild(el('h3', { text: 'Pay your bill' }));
    if (pay && pay.mpesa) {
      var lines = [];
      if (pay.tillNumber) lines.push('M-Pesa Buy Goods Till: ' + pay.tillNumber);
      if (pay.paybill) lines.push('Paybill: ' + pay.paybill + (pay.accountNumber ? ' · Account: ' + pay.accountNumber : ''));
      if (pay.accountName) lines.push('Name shown: ' + pay.accountName);
      if (pay.instructions) lines.push(pay.instructions);
      lines.forEach(function (t) { main.appendChild(el('div', { class: 'muted', text: t })); });
    } else main.appendChild(el('div', { class: 'muted', text: W('Please pay your waiter or the cashier.', 'Please pay the cashier.') }));
    var method = el('select', {}, [el('option', { value: 'mpesa', text: 'M-Pesa' }), el('option', { value: 'cash', text: W('Cash (I will pay the waiter / cashier)', 'Cash (I will pay the cashier)') })]);
    var amount = el('input', { type: 'number', inputmode: 'decimal', min: '1', step: '0.5', value: String(due) });
    var code = el('input', { type: 'text', placeholder: 'M-Pesa code (optional)', maxlength: '14', autocapitalize: 'characters' });
    var err = el('div', { class: 'err' });
    method.addEventListener('change', function () { code.hidden = method.value !== 'mpesa'; });
    var go = el('button', { type: 'button', class: 'add', text: 'I have paid', on: { click: function () {
      // zip 185: an empty / zero / non-numeric amount was sent as null / 0 and came back as a confusing server error - say it here
      if (!(Number(amount.value) > 0)) { err.textContent = 'Enter the amount you paid.'; return; }
      go.disabled = true; err.textContent = '';
      var nm = 'pay-' + o.id + '-' + method.value + '-' + amount.value + '-' + code.value;
      send({ action: 'pay', method: method.value, amount: Number(amount.value), mpesaCode: code.value.trim() }, nm, o.id).then(function (x) {
        go.disabled = false; if (!x.ok) { err.textContent = x.d.error || 'Could not record the payment.'; if (x.d.code === 'bad_code') done(nm); return; }
        done(nm); track(o.id);
      }).catch(function () { go.disabled = false; err.textContent = 'No connection — tap again (it will not be recorded twice).'; });
    } } });
    [method, amount, code, err, go].forEach(function (x) { main.appendChild(x); });
    main.appendChild(el('p', { class: 'muted', text: 'The cashier confirms every payment. Your code is only a reference.' }));
  }
  load();
})();
