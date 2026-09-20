import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

const PAYLOADS = ["O'Brien", 'plain', 'a\\', "\\'); window.__pwn=1;//", "&#39;); window.__pwn=1;//", "&quot;); window.__pwn=1;//",
  '"><img src=x onerror="window.__pwn=1">', '</script><script>window.__pwn=1</script>'];

for (const app of ['index.html', 'water/index.html', 'hotel/index.html']) {
  test(`${app}: escapeJsAttr / escapeHtml survive injection payloads`, async () => {
    const { w, d, close } = await boot(app);
    const esc = w.eval('escapeJsAttr'), escH = w.eval('escapeHtml');
    for (const p of PAYLOADS) {
      w.__got = undefined; w.__pwn = undefined; w.__fn = (v) => { w.__got = v; };
      const box = d.createElement('div'); d.body.appendChild(box);
      box.innerHTML = `<button id="tb" onclick="window.__fn('${esc(p)}')">go</button><input id="ti" value="${escH(p)}">`;
      d.getElementById('tb').click();
      assert.equal(w.__got, p, `handler received the exact string for ${JSON.stringify(p)}`);
      assert.equal(d.getElementById('ti').value, p);
      assert.equal(w.__pwn, undefined, 'injected code must not run');
      assert.equal(box.querySelectorAll('img').length, 0);
      box.remove();
    }
    close();
  });
}
