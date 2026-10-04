/* public-site/shop-ui.js — zip 204. Shared storefront code for the home page and /shop: loads the catalogue, draws product / system cards,
   price blocks, the offer badge and the "Hardware" dropdown. Everything shown comes from /api/catalog (owner-managed); the only fallback is the
   starter list in /shop-catalog.json, used until the owner has saved a catalogue. */
(function () {
  'use strict';
  var PM = window.PM = window.PM || {};
  var WA = '254791598506';
  PM.esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var esc = PM.esc;
  PM.kes = function (n) { return n == null ? 'Get a quote' : 'KES ' + Number(n).toLocaleString('en-KE'); };
  PM.img = function (id) { return '/api/catalog?img=' + encodeURIComponent(id); };
  PM.wa = function () { return WA; };
  PM.waLink = function (text) { return 'https://wa.me/' + WA + '?text=' + encodeURIComponent(text); };

  // ---- loading: the live catalogue, or the starter list until one exists ----
  PM.load = function () {
    if (PM._p) return PM._p;
    PM._p = fetch('/api/catalog').then(function (r) { if (!r.ok) throw new Error('catalog ' + r.status); return r.json(); }).then(function (j) {
      if (j && j.configured) { j.live = true; return j; }
      return PM.starter();
    }).catch(function () { return PM.starter(); });
    return PM._p;
  };
  PM.starter = function () {
    return fetch('/shop-catalog.json').then(function (r) { return r.json(); }).then(function (s) {
      WA = String(s.whatsapp || WA).replace(/\D/g, '') || WA;
      var cats = (s.categories || []).map(function (c) { return { id: c.key, name: c.label, slug: c.key, scope: 'product' }; });
      var products = (s.products || []).map(function (p, i) {
        return { id: p.id, slug: p.id, name: p.name, sku: '', cat: p.cat, kind: p.kind, stock: 'in', blurb: p.blurb, description: p.blurb, specs: (p.points || []).map(function (v) { return { k: 'Includes', v: v }; }),
          images: [], featured: !!p.badge, related: [], createdAt: 0, pos: i, price: null, eff: null, onOffer: false, offerEnd: 0, discount: 0, pct: 0, was: null };
      });
      return { ok: true, live: false, configured: false, now: Date.now(), categories: cats, products: products, systems: [] };
    }).catch(function () { return { ok: true, live: false, categories: [], products: [], systems: [], now: Date.now() }; });
  };

  // ---- pieces ----
  PM.art = function (x) {
    if (x.images && x.images[0]) return '<img src="' + PM.img(x.images[0]) + '" alt="' + esc(x.name) + '" loading="lazy" decoding="async" width="600" height="450">';
    return window.pmArt ? window.pmArt(x.kind || 'accessory') : '';
  };
  PM.stockLabel = { in: 'In stock', low: 'Low stock', out: 'Out of stock', order: 'On order' };
  PM.stockOf = function (x) { return PM.stockLabel[x && x.stock] ? x.stock : 'in'; };
  PM.priceBlock = function (x, big) {
    if (x.eff == null) return '<div class="pr' + (big ? ' big' : '') + '"><span class="now q">Get a quote</span></div>';
    var was = x.was ? '<s class="was">' + PM.kes(x.was) + '</s>' : '';
    var off = x.pct ? '<span class="pct">' + x.pct + '% OFF</span>' : '';
    return '<div class="pr' + (big ? ' big' : '') + (x.onOffer ? ' offer' : '') + '"><span class="now">' + PM.kes(x.eff) + '</span>' + was + off + '</div>';
  };
  PM.offerBadge = function () { return '<span class="ob" aria-label="Special offer"><i aria-hidden="true">🔥</i> SPECIAL OFFER</span>'; };
  PM.href = function (x, sys) { return '/shop/' + (sys ? 's' : 'p') + '/' + encodeURIComponent(x.slug); };
  PM.catName = function (d, id) { var k = (d.categories || []).filter(function (c) { return c.id === id; })[0]; return k ? k.name : ''; };

  PM.card = function (d, x, i, opts) {
    opts = opts || {}; var sys = !!x.components;
    var badges = (x.onOffer ? PM.offerBadge() : '') + (x.featured && !x.onOffer ? '<span class="fb">Featured</span>' : '') + (x.stock === 'out' ? '<span class="sb out">Out of stock</span>' : x.stock === 'low' ? '<span class="sb">Low stock</span>' : '');
    var saving = sys && x.saving ? '<div class="save">You save <b>' + PM.kes(x.saving) + '</b></div>' : '';
    return '<a class="pc' + (sys ? ' sys' : '') + (x.featured ? ' feat' : '') + (opts.cls ? ' ' + opts.cls : '') + '" href="' + PM.href(x, sys) + '" data-id="' + esc(x.id) + '" data-sys="' + (sys ? 1 : 0) + '" style="--i:' + (i || 0) + '">'
      + '<div class="pc-art">' + badges + '<div class="pc-img">' + PM.art(x) + '</div></div>'
      + '<div class="pc-body"><span class="pc-cat">' + esc(sys ? (PM.catName(d, x.cat) || 'Complete system') : PM.catName(d, x.cat)) + '</span><h3>' + esc(x.name) + '</h3>'
      + (x.blurb ? '<p class="pc-blurb">' + esc(x.blurb) + '</p>' : '') + saving
      + '<div class="pc-foot">' + PM.priceBlock(x) + '<span class="pc-cta">' + (x.onOffer ? 'View offer' : sys ? 'See the system' : 'View') + ' <i aria-hidden="true">→</i></span></div></div></a>';
  };
  // the large Special Offers card
  PM.offerCard = function (d, x, i) {
    var sys = !!x.components;
    return '<a class="oc" href="' + PM.href(x, sys) + '" data-id="' + esc(x.id) + '" style="--i:' + (i || 0) + '"><div class="oc-art">' + PM.offerBadge() + '<div class="pc-img">' + PM.art(x) + '</div></div>'
      + '<div class="oc-body"><span class="pc-cat">' + esc(sys ? 'Complete system' : PM.catName(d, x.cat)) + '</span><h3>' + esc(x.name) + '</h3>' + PM.priceBlock(x, true)
      + (sys && x.saving ? '<div class="save">Includes everything · you save <b>' + PM.kes(x.saving) + '</b></div>' : '') + '<span class="pm-btn primary">View offer <i aria-hidden="true">→</i></span></div></a>';
  };
  // an offer whose end time has passed while the page stayed open stops showing (the server stays the authority on the next load)
  PM.expire = function (d) {
    var skew = (d.now || Date.now()) - (d._t0 || (d._t0 = Date.now())), t = Date.now() + skew;
    d.products.concat(d.systems).forEach(function (x) {
      if (!x.onOffer || !x.offerEnd || t < x.offerEnd) return;
      x.onOffer = false; x.eff = x.price; x.was = null; x.discount = 0; x.pct = 0; x.offerEnd = 0;
      if (x.components) x.saving = x.individualValue != null && x.eff != null && x.individualValue > x.eff ? x.individualValue - x.eff : 0;
    });
  };
  PM.offers = function (d) { return d.systems.filter(function (x) { return x.onOffer; }).concat(d.products.filter(function (x) { return x.onOffer; })); };

  // pointer highlight on cards (desktop only, one delegated listener, no layout work)
  PM.cardGlow = function (root) {
    if (!window.matchMedia || !matchMedia('(hover:hover) and (pointer:fine)').matches || root._glow) return; root._glow = true;
    var raf = 0, last = null;
    root.addEventListener('pointermove', function (e) {
      last = e; if (raf) return;
      raf = requestAnimationFrame(function () { raf = 0; var c = last.target.closest && last.target.closest('.pc,.oc'); if (!c) return; var r = c.getBoundingClientRect(); c.style.setProperty('--mx', (last.clientX - r.left) + 'px'); c.style.setProperty('--my', (last.clientY - r.top) + 'px'); });
    }, { passive: true });
  };

  // ---- the "Hardware" dropdown in the top bar ----
  PM.dropdown = function (d) {
    var link = document.querySelector('.nav-links a[href="/shop"]'); if (!link || link.dataset.dd) return; link.dataset.dd = '1';
    var cats = (d.categories || []).filter(function (c) { return c.scope === 'product'; });
    var items = ['<a role="menuitem" href="/shop">All hardware</a>'].concat(cats.map(function (c) { return '<a role="menuitem" href="/shop?cat=' + encodeURIComponent(c.slug) + '">' + esc(c.name) + '</a>'; }));
    if (d.systems && d.systems.length) items.push('<a role="menuitem" href="/shop?view=systems">Complete systems</a>');
    if (PM.offers(d).length) items.push('<a role="menuitem" href="/shop?view=offers">Special offers</a>');
    var wrap = document.createElement('div'); wrap.className = 'nav-dd';
    wrap.innerHTML = '<button type="button" class="nav-dd-btn" aria-haspopup="true" aria-expanded="false">Products <i aria-hidden="true">▾</i></button><div class="nav-dd-menu" role="menu">' + items.join('') + '</div>';
    link.replaceWith(wrap);
    var btn = wrap.firstChild, pinned = false, hov = false, canHover = function () { return window.matchMedia && matchMedia('(hover:hover) and (pointer:fine)').matches; };
    var open = function (v) { wrap.classList.toggle('open', v); btn.setAttribute('aria-expanded', v ? 'true' : 'false'); if (!v) pinned = false; };
    var items = function () { return [].slice.call(wrap.querySelectorAll('.nav-dd-menu a')); };
    // a mouse opens it on hover and a click then keeps it open; a finger or the keyboard simply toggles it
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (hov && wrap.classList.contains('open') && !pinned) { pinned = true; return; }
      open(!wrap.classList.contains('open')); pinned = wrap.classList.contains('open');
    });
    wrap.addEventListener('mouseenter', function () { if (canHover()) { hov = true; open(true); } });
    wrap.addEventListener('mouseleave', function () { hov = false; if (canHover() && !pinned) open(false); });
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) open(false); else if (e.target.closest && e.target.closest('.nav-dd-menu a')) open(false); });
    wrap.addEventListener('keydown', function (e) {
      var l = items(), i = l.indexOf(document.activeElement);
      if (e.key === 'Escape') { if (wrap.classList.contains('open')) { open(false); btn.focus(); } }
      else if (e.key === 'ArrowDown') { e.preventDefault(); open(true); (l[i + 1] || l[0]).focus(); }
      else if (e.key === 'ArrowUp' && i >= 0) { e.preventDefault(); (l[i - 1] || btn).focus(); }
    });
  };
  // the small-screen menu button
  PM.burger = function () {
    var nav = document.querySelector('header.site-nav .nav-inner'), links = document.querySelector('.nav-links'); if (!nav || !links || nav.querySelector('.nav-burger')) return;
    var b = document.createElement('button'); b.type = 'button'; b.className = 'nav-burger'; b.setAttribute('aria-label', 'Menu'); b.setAttribute('aria-expanded', 'false'); b.innerHTML = '<span></span><span></span>';
    var cta = nav.querySelector('.nav-cta'); nav.insertBefore(b, cta || null);
    var set = function (o) { document.body.classList.toggle('nav-open', o); b.setAttribute('aria-expanded', o ? 'true' : 'false'); };
    b.addEventListener('click', function (e) { e.stopPropagation(); set(!document.body.classList.contains('nav-open')); });
    links.addEventListener('click', function (e) { if (e.target.closest('a')) set(false); });
    document.addEventListener('click', function (e) { if (document.body.classList.contains('nav-open') && !links.contains(e.target) && !b.contains(e.target)) set(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && document.body.classList.contains('nav-open')) { set(false); b.focus(); } });
    window.addEventListener('resize', function () { if (window.innerWidth > 720) set(false); });
  };
})();
