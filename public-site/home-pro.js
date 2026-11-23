/* public-site/home-pro.js - zip 303. Dependency-free. Everything here is presentation: the sale story is a DEMONSTRATION with sample numbers (it never touches
   a till, a stock count or a payment), and the page is complete without this file (the story's markup already shows the finished state).
   1) phone menu   2) the animated sale story   3) the business-control board toggle   4) the website-example carousel */
(function () {
  'use strict';
  var reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* motion allowed */ }
  function $(id) { return document.getElementById(id); }
  function qa(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }
  function kes(n) { return 'KES ' + Math.round(n).toLocaleString('en-KE'); }

  /* ---------- 1) phone menu ---------- */
  (function menu() {
    var nav = document.querySelector('header.site-nav .nav-inner'); if (!nav || $('hp-menu')) return;
    var links = qa('.nav-links a', nav); if (!links.length) return;
    var b = document.createElement('button'); b.type = 'button'; b.className = 'hp-burger'; b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-controls', 'hp-menu'); b.setAttribute('aria-label', 'Open menu'); b.innerHTML = '<span></span>';
    nav.appendChild(b);
    var m = document.createElement('div'); m.id = 'hp-menu'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-label', 'Site menu');
    var html = '';
    links.forEach(function (a) { html += '<a href="' + a.getAttribute('href') + '"' + (/websites/.test(a.getAttribute('href')) ? ' class="web"' : '') + '>' + a.textContent + '</a>'; });
    html += '<div class="hp-menu-cta"><a href="/#demos">Explore live demo</a><a class="alt" href="/websites#enquiry">Get a website for my business</a></div>';
    m.innerHTML = html; document.body.appendChild(m);
    function setTop() { var h = document.querySelector('header.site-nav'); if (h) document.documentElement.style.setProperty('--hp-navh', Math.round(h.getBoundingClientRect().bottom) + 'px'); }
    function open(v) {
      setTop(); m.classList.toggle('open', v); b.setAttribute('aria-expanded', v ? 'true' : 'false'); b.setAttribute('aria-label', v ? 'Close menu' : 'Open menu'); document.body.classList.toggle('hp-menu-open', v);
      if (v) { var f = m.querySelector('a'); if (f) f.focus(); } else b.focus();
    }
    b.addEventListener('click', function () { open(!m.classList.contains('open')); });
    m.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('a')) open(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && m.classList.contains('open')) open(false); });
    window.addEventListener('resize', function () { if (window.innerWidth > 1060 && m.classList.contains('open')) open(false); });
  })();

  /* ---------- 5) the demo film (zip 305) ----------
     Nothing is downloaded until the visitor taps Play (the poster is a 20 KB picture). Then a muted, inline video starts; it pauses itself when
     scrolled out of view or when the tab is hidden, so it never runs in the background and never competes with the rest of the page. */
  (function film() {
    var box = $('hp-film'), play = $('hp-film-play'); if (!box || !play) return;
    var v = null, obs = null;
    function start() {
      if (!v) {
        v = document.createElement('video');
        v.muted = true; v.defaultMuted = true; v.setAttribute('muted', ''); v.playsInline = true; v.setAttribute('playsinline', ''); v.controls = true; v.preload = 'auto';
        v.setAttribute('poster', '/img/demo-film-poster.jpg'); v.setAttribute('aria-label', 'MyDuka POS demo video, 55 seconds, no sound');
        [['/img/demo-film-720.webm', 'video/webm; codecs=vp9'], ['/img/demo-film-720.mp4', 'video/mp4']].forEach(function (x) { var s = document.createElement('source'); s.src = x[0]; s.type = x[1]; v.appendChild(s); });
        var end = document.createElement('div'); end.className = 'hp-film-end';
        end.innerHTML = '<b style="font-size:22px">Now try it on your own phone</b><a class="btn btn-primary glow-cta" href="#demos" data-ev="demo_cta">Try a Live Demo</a><button type="button" class="hp-film-again">↻ Watch again</button>';
        box.appendChild(v); box.appendChild(end);
        end.querySelector('.hp-film-again').addEventListener('click', function () { box.classList.remove('ended'); v.currentTime = 0; v.play().catch(function () {}); });
        v.addEventListener('ended', function () { box.classList.add('ended'); });
        v.addEventListener('playing', function () { box.classList.add('playing'); box.classList.remove('ended'); });
        if ('IntersectionObserver' in window) {
          obs = new IntersectionObserver(function (es) { es.forEach(function (e) { if (!e.isIntersecting && v && !v.paused) v.pause(); }); }, { threshold: 0.25 });
          obs.observe(box);
        }
        document.addEventListener('visibilitychange', function () { if (document.hidden && v && !v.paused) v.pause(); });
      }
      var p = v.play(); if (p && p.catch) p.catch(function () { box.classList.add('playing'); });
      try { v.focus({ preventScroll: true }); } catch (e) { /* ok */ }
    }
    play.addEventListener('click', start);
  })();

  /* ---------- 2) the sale story ---------- */
  (function story() {
    var root = $('hp-story'); if (!root) return;
    var ITEMS = [{ n: 'Maize flour 2kg', p: 190 }, { n: 'Cooking oil 1L', p: 330 }, { n: 'Milk 500ml', p: 65 }];
    var STOCK = [24, 12, 40], SALES0 = 12400, TX0 = 38, TOTAL = 585;
    var LABELS = ['Cashier scans or taps a product', 'The items land in the cart', 'The total updates', 'Payment is recorded (demonstration)', 'A receipt preview appears', 'Stock is updated', 'The dashboard is updated'];
    var step = 7, playing = false, userPaused = false, inView = false, timer = 0, manual = false;
    var els = { tiles: qa('.hp-tile', root), cart: qa('.hp-cl', root), tot: $('hp-tot'), chip: $('hp-chip-mpesa'), badge: $('hp-badge'), rcpt: $('hp-rcpt'), sales: $('hp-sales'), tx: $('hp-tx'), spk: $('hp-spk-new'), stat: $('hp-stat'), steps: qa('.hp-steps li', root), play: $('hp-play'), next: $('hp-next'), reset: $('hp-reset') };
    function setNum(el, to, fmt, animate) {
      var from = Number(el.getAttribute('data-v')) || 0; el.setAttribute('data-v', to);
      if (!animate || reduce || from === to) { el.textContent = fmt(to); return; }
      var t0 = 0, dur = 650; (function f(t) { if (!t0) t0 = t; var k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(from + (to - from) * e); if (k < 1) requestAnimationFrame(f); })(performance.now ? performance.now() : 0);
    }
    function render(n, animate) {
      step = n; root.setAttribute('data-step', n);
      root.classList.toggle('hp-st1', n === 1);
      els.cart.forEach(function (c) { c.classList.toggle('in', n >= 2); });
      setNum(els.tot, n >= 3 ? TOTAL : 0, kes, animate);
      els.chip.classList.toggle('on', n >= 4); els.badge.classList.toggle('show', n >= 4);
      els.rcpt.classList.toggle('show', n >= 5);
      qa('.hp-stk', root).forEach(function (r, i) {
        var q = STOCK[i] - (n >= 6 ? 1 : 0); r.querySelector('b').textContent = q + ' in stock'; r.querySelector('.hp-meter span').style.setProperty('--w', Math.round(q / 50 * 100) + '%');
        r.querySelector('.hp-meter').classList.toggle('low', q < 14);
      });
      setNum(els.sales, SALES0 + (n >= 7 ? TOTAL : 0), kes, animate); setNum(els.tx, TX0 + (n >= 7 ? 1 : 0), function (v) { return Math.round(v) + ' sales'; }, animate);
      els.spk.classList.toggle('new', n >= 7); els.spk.style.setProperty('--h', n >= 7 ? '88%' : '22%');
      els.steps.forEach(function (li, i) { li.classList.toggle('done', i + 1 < n || n === 7); li.classList.toggle('now', n > 0 && n < 7 && i + 1 === n); });
      els.stat.textContent = n > 0 ? 'Step ' + n + ' of 7: ' + LABELS[n - 1] : 'Ready: tap Next step or Play';
      if (els.next) { els.next.textContent = 'Next step'; els.next.disabled = n >= 7; }      // zip 307: at the last step only Restart remains (it used to show two Restart buttons)
    }
    function pickTiles(n) { els.tiles.forEach(function (t) { t.classList.toggle('pick', n === 1); }); }
    function go(n, animate) { render(n, animate); pickTiles(n); }
    function stop() { clearTimeout(timer); timer = 0; }
    function loop() {
      stop(); if (!playing || reduce || !inView || userPaused || document.hidden) return;
      var next = step >= 7 ? 0 : step + 1, wait = step >= 7 ? 3800 : 1900;
      timer = setTimeout(function () { go(next, true); loop(); }, wait);
    }
    function setPlaying(v) { playing = v; if (els.play) { els.play.textContent = v && !userPaused ? '⏸ Pause' : '▶ Play'; els.play.setAttribute('aria-pressed', v && !userPaused ? 'true' : 'false'); } }
    function live() { if (!manual) { manual = true; els.stat.setAttribute('aria-live', 'polite'); } }
    if (els.play) els.play.addEventListener('click', function () { live(); userPaused = !userPaused; setPlaying(!userPaused); if (!userPaused) { if (step >= 7) go(0, false); loop(); } else stop(); });
    if (els.next) els.next.addEventListener('click', function () { live(); userPaused = true; setPlaying(false); stop(); go(step >= 7 ? 1 : step + 1, true); });
    if (els.reset) els.reset.addEventListener('click', function () { live(); stop(); go(0, false); userPaused = false; setPlaying(!reduce); loop(); if (reduce) { userPaused = true; } });
    els.steps.forEach(function (li, i) { li.setAttribute('tabindex', '0'); li.addEventListener('click', function () { live(); userPaused = true; setPlaying(false); stop(); go(i + 1, true); }); li.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.click(); } }); });
    go(7, false);   // the finished state is what shows without motion, and before the story is scrolled into view
    if (reduce) { if (els.play) els.play.hidden = true; setPlaying(false); userPaused = true; return; }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { es.forEach(function (e) { var was = inView; inView = e.isIntersecting; if (inView && !was) { if (!userPaused) { go(0, false); setPlaying(true); loop(); } } else if (!inView) stop(); }); }, { threshold: 0.35 }).observe(root);
    }
    document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else loop(); });
  })();

  /* ---------- 3) online / offline toggle on the board ---------- */
  (function net() {
    var sw = $('hp-net-sw'), t = $('hp-net-t'); if (!sw || !t) return;
    sw.addEventListener('click', function () {
      var off = sw.getAttribute('aria-pressed') !== 'true'; sw.setAttribute('aria-pressed', off ? 'true' : 'false');
      t.innerHTML = off ? '<b>Offline: sales keep saving</b>Every sale is stored on the device and will sync when signal returns.' : '<b>Online: synced</b>Sales reach your other devices and branches as they happen.';
    });
  })();

  /* ---------- 4) the website-example carousel ---------- */
  qa('[data-hp-car]').forEach(function (car) {
    var track = car.querySelector('.hp-track'), slides = qa('.hp-slide', track), dots = qa('.hp-dots button', car), prev = car.querySelector('[data-prev]'), next = car.querySelector('[data-next]'), pp = car.querySelector('.hp-pp');
    if (!track || !slides.length) return;
    var idx = 0, paused = reduce, hover = false, vis = false, t = 0, ticking = false;
    function pos(i) { return slides[i].offsetLeft - slides[0].offsetLeft; }
    function show(i, smooth) { i = (i + slides.length) % slides.length; track.scrollTo({ left: pos(i), behavior: smooth === false || reduce ? 'auto' : 'smooth' }); mark(i); }
    function mark(i) { idx = i; dots.forEach(function (d, k) { if (k === i) d.setAttribute('aria-current', 'true'); else d.removeAttribute('aria-current'); }); slides.forEach(function (s, k) { s.setAttribute('aria-label', (k + 1) + ' of ' + slides.length); }); }
    function whichSlide() { var best = 0, d = 1e9; slides.forEach(function (s, k) { var x = Math.abs(pos(k) - track.scrollLeft); if (x < d) { d = x; best = k; } }); return best; }
    track.addEventListener('scroll', function () { if (ticking) return; ticking = true; requestAnimationFrame(function () { ticking = false; mark(whichSlide()); }); }, { passive: true });
    if (prev) prev.addEventListener('click', function () { paused = true; sync(); show(idx - 1); });
    if (next) next.addEventListener('click', function () { paused = true; sync(); show(idx + 1); });
    dots.forEach(function (d, k) { d.addEventListener('click', function () { paused = true; sync(); show(k); }); });
    track.addEventListener('keydown', function (e) { if (e.key === 'ArrowRight') { e.preventDefault(); paused = true; sync(); show(idx + 1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); paused = true; sync(); show(idx - 1); } });
    function sync() { if (pp) { pp.textContent = paused ? '▶ Auto-play' : '⏸ Pause'; pp.setAttribute('aria-pressed', paused ? 'false' : 'true'); } }
    function run() { clearTimeout(t); if (paused || hover || !vis || document.hidden || reduce) return; t = setTimeout(function () { show(idx + 1); run(); }, 6500); }
    if (pp) { if (reduce) pp.hidden = true; pp.addEventListener('click', function () { paused = !paused; sync(); run(); }); }
    car.addEventListener('mouseenter', function () { hover = true; clearTimeout(t); }); car.addEventListener('mouseleave', function () { hover = false; run(); });
    car.addEventListener('focusin', function () { hover = true; clearTimeout(t); }); car.addEventListener('focusout', function () { hover = false; run(); });
    car.addEventListener('touchstart', function () { paused = true; sync(); clearTimeout(t); }, { passive: true });
    if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { es.forEach(function (e) { vis = e.isIntersecting; run(); }); }, { threshold: 0.4 }).observe(car);
    window.addEventListener('resize', function () { show(idx, false); });
    mark(0); sync();
  });
})();
