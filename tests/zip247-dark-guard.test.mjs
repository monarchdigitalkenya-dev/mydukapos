import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 247: the dark-mode contrast guard fixes unreadable text in every app (and the owner console) and undoes itself when dark mode is switched off.
for (const app of ['index.html', 'hotel/index.html', 'owner/index.html']) {
  test(`${app}: dark mode - dark text on the dark page and light text on a pale box become readable; light mode puts everything back`, async () => {
    const { w, d, close } = await boot(app, { wait: 900 });
    try {
      const host = d.createElement('div'); host.id = 'dk-host';
      host.innerHTML = '<p id="a" style="color:#333">dark text on the page</p>'
        + '<div id="box" style="background:#fff3cd"><span id="b" style="color:#f0f0f0">light text on pale</span></div>'
        + '<div style="background:#14171a"><span id="c" style="color:#2c3e50">navy on near-black</span></div>'
        + '<p id="ok" style="color:#ecf0f1">already fine</p>';
      d.body.appendChild(host);
      d.documentElement.setAttribute('data-theme', 'dark');
      d.body.style.backgroundColor = '#14171a';
      w.darkGuardRun(host);
      const col = (id) => w.getComputedStyle(d.getElementById(id)).color;
      const hex = (c) => '#' + (c.match(/\d+/g) || []).slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('');
      assert.equal(hex(col('a')), '#ecf0f1', 'dark text on the dark page -> light');
      assert.equal(hex(col('b')), '#1b2631', 'light text on a pale box -> dark');
      assert.equal(hex(col('c')), '#ecf0f1', 'navy on near-black -> light');
      assert.equal(d.getElementById('ok').hasAttribute('data-dkfix'), false, 'readable text is left alone');
      d.documentElement.removeAttribute('data-theme');
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(d.getElementById('a').style.color, 'rgb(51, 51, 51)', 'light mode: original colour back');
      assert.equal(d.querySelectorAll('[data-dkfix]').length, 0);
    } finally { close(); }
  });
}
