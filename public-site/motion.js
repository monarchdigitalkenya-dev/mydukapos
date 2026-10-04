/* public-site/motion.js — zip 203. Small, dependency-free motion for the PUBLIC site only.
   1) nav tightens after a few pixels of scroll   2) scroll-reveal with stagger (IntersectionObserver)
   3) gentle parallax on [data-parallax] (rAF, transform only)   4) a hairline scroll-progress bar
   Everything is skipped under prefers-reduced-motion, and the page never waits on it: no script = content simply shows. */
(function () {
  'use strict';
  var reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* ignore */ }
  var nav = document.querySelector('header.site-nav, header.nav');
  function onScrollNav() { if (nav) nav.classList.toggle('pm-scrolled', (window.scrollY || 0) > 12); }
  window.addEventListener('scroll', onScrollNav, { passive: true }); onScrollNav();
  if (reduce) { [].forEach.call(document.querySelectorAll('.pm-r'), function (el) { el.classList.add('in'); });
    window.pmObserve = function (root) { [].forEach.call((root || document).querySelectorAll('.pm-r'), function (el) { el.classList.add('in'); }); };
    window.pmCount = function (root) { [].forEach.call((root || document).querySelectorAll('[data-count]'), function (el) { el.textContent = (parseFloat(el.getAttribute('data-count')) || 0).toLocaleString('en-KE'); }); };
    window.pmCount(document); return; }

  // scroll reveal: children of [data-stagger] get --d = 0,1,2… so they arrive one after another
  [].forEach.call(document.querySelectorAll('[data-stagger]'), function (g) {
    [].forEach.call(g.children, function (c, i) { c.classList.add('pm-r'); c.style.setProperty('--d', Math.min(i, 8)); });
  });
  var els = [].slice.call(document.querySelectorAll('.pm-r'));
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    els.forEach(function (el) { io.observe(el); });
    // late-added cards (the catalogue draws after a fetch) join in
    window.pmObserve = function (root) { [].forEach.call((root || document).querySelectorAll('.pm-r:not(.in)'), function (el) { io.observe(el); }); };
  } else { els.forEach(function (el) { el.classList.add('in'); }); window.pmObserve = function () {}; }

  // count-up: <b data-count="120">0</b> eases to its number once, when it scrolls into view (reduced motion: the number is simply set)
  var rm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function countEl(el) {
    var to = parseFloat(el.getAttribute('data-count')) || 0, t0 = 0, dur = 1100;
    if (rm || to <= 0) { el.textContent = to.toLocaleString('en-KE'); return; }
    function step(t) { if (!t0) t0 = t; var k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = Math.round(to * e).toLocaleString('en-KE'); if (k < 1) requestAnimationFrame(step); }
    requestAnimationFrame(step);
  }
  window.pmCount = function (root) {
    var list = [].slice.call((root || document).querySelectorAll('[data-count]:not([data-counted])'));
    if (rm || !('IntersectionObserver' in window)) { list.forEach(function (el) { el.setAttribute('data-counted', '1'); countEl(el); }); return; }
    var co = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { co.unobserve(e.target); countEl(e.target); } }); }, { threshold: 0.4 });
    list.forEach(function (el) { el.setAttribute('data-counted', '1'); co.observe(el); });
  };
  window.pmCount(document);

  // parallax: data-parallax="0.12" moves the element that fraction of the scroll distance, hero only while visible
  var par = [].slice.call(document.querySelectorAll('[data-parallax]'));
  var bar = document.createElement('div'); bar.className = 'pm-progress'; bar.setAttribute('aria-hidden', 'true'); document.body.appendChild(bar);
  var ticking = false;
  function frame() {
    ticking = false;
    var y = window.scrollY || 0, h = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    bar.style.transform = 'scaleX(' + Math.min(1, y / h).toFixed(4) + ')';
    if (y < innerHeight * 1.4) par.forEach(function (el) { el.style.transform = 'translate3d(0,' + (y * parseFloat(el.getAttribute('data-parallax') || '0.1')).toFixed(1) + 'px,0)'; });
  }
  window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }, { passive: true });
  frame();

  // pointer tilt on the hero stage (desktop only): a few degrees, eased
  var stage = document.querySelector('.pm-stage');
  if (stage && window.matchMedia && window.matchMedia('(hover:hover) and (pointer:fine)').matches) {
    var tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
    function loop() { cx += (tx - cx) * 0.08; cy += (ty - cy) * 0.08; stage.style.transform = 'rotateY(' + cx.toFixed(2) + 'deg) rotateX(' + cy.toFixed(2) + 'deg)'; raf = (Math.abs(tx - cx) + Math.abs(ty - cy) > 0.02) ? requestAnimationFrame(loop) : 0; }
    window.addEventListener('mousemove', function (e) { tx = (e.clientX / innerWidth - 0.5) * 7; ty = -(e.clientY / innerHeight - 0.5) * 5; if (!raf) raf = requestAnimationFrame(loop); }, { passive: true });
  }
})();
