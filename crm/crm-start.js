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
})();
