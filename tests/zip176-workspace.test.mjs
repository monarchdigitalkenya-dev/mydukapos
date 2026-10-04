import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot } from './helpers.mjs';

const APPS = ['index.html', 'water/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'hotel/index.html'];

test('zip 176: the Sales Counter workspace CSS + fit code ship in every module', async () => {
  for (const a of APPS) {
    const src = fs.readFileSync(new URL('../' + a, import.meta.url), 'utf8');
    assert.ok(src.includes('Sales Counter workspace'), a + ': workspace css');
    assert.ok(src.includes("setProperty('--pos-h'"), a + ': height fit');
    assert.ok(src.includes('grid-auto-rows: max-content'), a + ': product rows keep their natural height');
    assert.ok(src.includes('pos-left-foot'), a + ': product card footer');
  }
});

test('zip 176: the product card gets its footer row (hint + Sell Unlisted Item) and the cart a count pill', async () => {
  for (const a of APPS.filter((x) => x !== 'water/index.html')) {
    const { w, d, close } = await boot(a, { wait: 4000 });
    try {
      const card = d.querySelector('#item-image-grid').parentNode;
      assert.ok(card.classList.contains('pos-products'), a + ': marked');
      const foot = card.querySelector(':scope > .pos-left-foot');
      assert.ok(foot, a + ': footer row');
      assert.ok(foot.children.length > 0, a + ': hint / button moved into the footer');
      assert.equal(card.lastElementChild, foot, a + ': footer is last');
      assert.ok(d.querySelector('.pos-checkout'), a + ': checkout card');
    } finally { close(); }
  }
});

test('zip 176: Windows app — screen-fitted window, remembered zoom, hang recovery, safe graphics', async () => {
  const m = fs.readFileSync(new URL('../native/windows/main.js', import.meta.url), 'utf8');
  assert.ok(/workArea/.test(m) && /0\.92/.test(m), 'window sized from the screen');
  assert.ok(/setZoomFactor/.test(m) && /did-finish-load/.test(m), 'zoom applied after every load');
  assert.ok(/'unresponsive'/.test(m) && /reload\(\)/.test(m), 'a frozen page is reloaded');
  assert.ok(/disableHardwareAcceleration/.test(m) && /safeGraphics/.test(m), 'safe graphics mode');
  assert.ok(/CmdOrCtrl\+0/.test(m) && /CmdOrCtrl\+-/.test(m), 'zoom shortcuts');
});
