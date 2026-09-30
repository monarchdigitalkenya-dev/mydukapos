/* MyDuka CRM - start-up: theme, invite / reset links, router wiring. */
(function () {
  'use strict';
  const C = window.CRM;
  const t = C.safeLS('get', 'crm_theme'); if (t === 'dark' || t === 'light') C.applyTheme(t);
  // The server e-mails / shares links like /crm/?invite=TOKEN or /crm/?reset=TOKEN - turn them into the hash routes, and drop the token from the address bar.
  try {
    const sp = new URLSearchParams(location.search);
    const inv = sp.get('invite'), rst = sp.get('reset');
    if (inv || rst) {
      history.replaceState(null, '', location.pathname + '#/' + (inv ? 'invite' : 'reset') + '?token=' + encodeURIComponent(inv || rst));
    }
  } catch (e) { /* no history API: the hash form still works */ }
  window.addEventListener('hashchange', () => C.render());
  window.addEventListener('error', (e) => { try { console.error('CRM error:', e.message); } catch (x) { /* ignore */ } });
  C.render();

  /* zip 161: the CRM's own service worker (the app shell opens from the device on a repeat visit; data is never cached). ?nosw=1 switches it off and clears it. */
  try {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      if (/[?&]nosw=1/.test(location.search)) {
        navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => { if (r.scope.indexOf('/crm/') >= 0) r.unregister(); })).catch(() => {});
        if (window.caches) caches.keys().then((ks) => ks.forEach((k) => { if (k.indexOf('crm-') === 0) caches.delete(k); })).catch(() => {});
      } else {
        navigator.serviceWorker.addEventListener('message', (e) => {
          if (!e.data || e.data.type !== 'crm-update' || document.getElementById('crm-update')) return;
          const bar = C.h('div', { id: 'crm-update', class: 'notice', role: 'status', style: { position: 'fixed', left: '12px', right: '12px', bottom: '72px', zIndex: '60', display: 'flex', gap: '10px', alignItems: 'center', justifyContent: 'space-between' } },
            C.h('span', null, 'A new version of the CRM is ready.'), C.h('span', { class: 'row' }, C.btn('Reload', () => location.reload(), 'sm primary'), C.btn('Later', () => bar.remove(), 'sm ghost')));
          document.body.appendChild(bar);
        });
        const reg = () => navigator.serviceWorker.register('/crm/sw.js', { scope: '/crm/' }).catch(() => {});
        if ('requestIdleCallback' in window) requestIdleCallback(reg, { timeout: 4000 }); else setTimeout(reg, 1500);
      }
    }
  } catch (e) { /* no service worker: the app works exactly as before */ }
})();
