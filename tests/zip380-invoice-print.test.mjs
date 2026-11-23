// zip 380: Invoicing sits under Money in the sidebar; Print sends the SAME document as the preview to an A4 print page of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot } from './helpers.mjs';

test('Invoicing is listed in the Money folder', () => {
  const s = fs.readFileSync('src/shared/blocks/sidebar-nav.html', 'utf8');
  assert.match(s, /\{ id: 'fin', label: 'Money'[^\n]*'invoicing-tab'/);
});

test('Print uses the preview document on A4, not the thermal report print', async () => {
  const d = await boot('hotel/index.html', { storage: { pos_biz_name: 'Biz' }, wait: 1200 });
  try {
    const w = d.w;
    w.eval("window.__printed = 0; window.print = function () { window.__printed++; }; doPrintReport = function () { window.__report = 1; };");
    w.eval("Invoicing.newInv(); var e = Invoicing.state.ed; e.client = 'Abdi Nuur'; Invoicing.share(e.id);");
    const preview = w.document.getElementById('vx-dp').innerHTML;
    w.eval('Invoicing.doPrint()');
    await new Promise((r) => setTimeout(r, 300));
    const host = w.document.getElementById('vx-print-host');
    assert.ok(host, 'print page made');
    assert.ok(host.innerHTML.includes(preview), 'the printed document is the preview document');
    assert.match(host.innerHTML, /@page\{size:A4 portrait/);
    assert.equal(w.document.body.classList.contains('vx-printing'), true);
    assert.equal(w.eval('window.__printed'), 1);
    assert.equal(w.eval('window.__report || 0'), 0, 'not the thermal report print');
    w.dispatchEvent(new w.Event('afterprint'));
    assert.equal(w.document.getElementById('vx-print-host'), null, 'cleaned up after printing');
    assert.equal(w.document.body.classList.contains('vx-printing'), false);
  } finally { d.close && d.close(); }
});
