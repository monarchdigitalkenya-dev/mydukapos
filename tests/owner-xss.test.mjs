import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 143 (security). A value is put inside onclick="fn('...')" with escapeQuotes(). In the Owner Console it only escaped ' — a
// tenant's business name, a client's name or a public website / WhatsApp lead containing ", \' or &#39; broke out of the handler and
// ran script in the owner's browser (where the owner session is kept). The value="..." fields used the same helper.
const HOSTILE = [
  "O'Brien Hardware",
  "x');window.__pwned=1;//",
  "x\\');window.__pwned=1;//",
  'x" onmouseover="window.__pwned=1" y="',
  "&#39;);window.__pwned=1;//",
  '&quot;);window.__pwned=1;//',
  '</button><img src=x onerror="window.__pwned=1">',
  'line1\nline2',
  'back\\slash & <b>bold</b>',
];

for (const app of ['owner/index.html', 'index.html', 'hotel/index.html']) {
  test(`${app}: escapeQuotes() inside onclick="fn('…')" hands back exactly the original text and never runs anything`, async () => {
    const { w, d, close } = await boot(app, { wait: 1500 });
    for (const name of HOSTILE) {
      w.__pwned = 0; w.__got = null;
      const host = d.createElement('div');
      w.__name = name;
      host.innerHTML = w.eval(`'<button onclick="window.__got=\\'' + escapeQuotes(window.__name) + '\\'">x</button>'`);
      d.body.appendChild(host);
      const btn = host.querySelector('button');
      assert.ok(btn, `${JSON.stringify(name)}: still one button`);
      assert.equal(host.querySelectorAll('img').length, 0, `${JSON.stringify(name)}: no injected element`);
      btn.click();
      assert.equal(w.__pwned, 0, `${JSON.stringify(name)}: nothing injected ran`);
      assert.equal(w.__got, name, `${JSON.stringify(name)}: the handler got the exact text`);
      host.remove();
    }
    await new Promise((r) => setTimeout(r, 1500));   // let the app's own start-up requests finish before the window closes
    close();
  });
}

test('owner/index.html: a lead / client value shown in value="…" is shown exactly and cannot add attributes', async () => {
  const { w, d, close } = await boot('owner/index.html', { wait: 1500 });
  for (const name of HOSTILE) {
    w.__name = name;
    const host = d.createElement('div');
    host.innerHTML = w.eval('`<input type="text" value="${escapeHtml(window.__name)}">`');
    const input = host.querySelector('input');
    assert.equal(input.getAttributeNames().sort().join(','), 'type,value', JSON.stringify(name));
    assert.equal(input.value, name.replace(/\n/g, ''), JSON.stringify(name));   // (an <input> drops newlines by itself)
  }
  await new Promise((r) => setTimeout(r, 1500));
  close();
});
