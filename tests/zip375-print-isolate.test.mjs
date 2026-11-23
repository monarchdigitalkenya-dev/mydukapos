import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 375: Print prints the receipt from its own hidden document - never the page on screen.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('receipt print: the printed document holds ONLY the receipt, and the screen can no longer change it', async () => {
  const d = await boot('hotel/index.html', { storage: { pos_biz_name: 'Biz' }, wait: 800 });
  try {
    const w = d.w, doc = d.d;
    assert.equal(w.eval('typeof PrintIsolate'), 'object');
    w.eval("window.__printed = 0; PrintIsolate.printWin = function (win) { window.__printed++; window.__pwin = win; };");
    w.eval("document.getElementById('receipt-body').textContent = 'HELLO-RECEIPT-123'; document.body.classList.add('printing-receipt'); document.body.style.setProperty('--receipt-print-width', '58mm');");
    w.eval('window.print()');
    await sleep(500);
    assert.equal(w.eval('window.__printed'), 1, 'the hidden document was printed');
    const f = w.eval('PrintIsolate.frame()'); assert.ok(f, 'a hidden frame exists');
    const idoc = f.contentDocument;
    const kids = [...idoc.body.children].filter((c) => c.tagName !== 'STYLE').map((c) => c.id);
    assert.deepEqual(kids, ['receipt-modal'], 'nothing but the receipt is in the printed document');
    assert.match(idoc.body.textContent, /HELLO-RECEIPT-123/);
    assert.ok(idoc.body.classList.contains('printing-receipt'), 'the receipt print rules apply inside it');
    assert.equal(idoc.body.style.getPropertyValue('--receipt-print-width'), '58mm', 'the chosen paper width is carried');
    assert.equal(idoc.querySelectorAll('script').length, 0, 'no script runs inside it');
    assert.equal(idoc.getElementById('sales-tab'), null, 'the Sales Counter is not in it');
    // the page clears its print mode and the receipt changes: the printed document is untouched
    w.eval("document.body.classList.remove('printing-receipt'); document.getElementById('receipt-body').textContent = 'CHANGED';");
    assert.ok(idoc.body.classList.contains('printing-receipt'));
    assert.match(idoc.body.textContent, /HELLO-RECEIPT-123/);
  } finally { d.close && d.close(); }
});

test('afterprint is relayed to the page once; no print mode = a normal print; the off switch works', async () => {
  const d = await boot('hotel/index.html', { storage: { pos_biz_name: 'Biz' }, wait: 800 });
  try {
    const w = d.w;
    w.eval("window.__ap = 0; window.addEventListener('afterprint', function () { window.__ap++; }); window.__printed = 0; PrintIsolate.printWin = function (win) { window.__printed++; };");
    w.eval("document.body.classList.add('printing-report'); window.print();");
    await sleep(400);
    assert.equal(w.eval('window.__printed'), 1);
    w.eval("var fw = PrintIsolate.frame().contentWindow; fw.dispatchEvent(new fw.Event('afterprint')); fw.dispatchEvent(new fw.Event('afterprint'));");
    assert.equal(w.eval('window.__ap'), 1, 'the page hears about it once');
    w.eval("document.body.classList.remove('printing-report'); window.__native = 0; ");
    w.eval("PrintIsolate.drop(); window.__n = 0; window.print = (function(){ return function(){ window.__n++; }; })();");
    w.eval('window.print()'); assert.equal(w.eval('window.__n'), 1);
    assert.equal(w.eval('PrintIsolate.frame()'), null);
  } finally { d.close && d.close(); }
});
