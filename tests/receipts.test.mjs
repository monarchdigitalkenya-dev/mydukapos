import test from 'node:test';
import assert from 'node:assert/strict';
import { APPS, boot, SAMPLE_SALE, decodeEscPos } from './helpers.mjs';

// Every app x paper width x alignment: raw (USB/Bluetooth) receipt must have column headings,
// contain only printable ASCII, and never be wider than the paper.
for (const app of APPS) {
  test(`${app}: raw receipt has column headers, ASCII only, fits the paper`, async () => {
    const { w, errors, close } = await boot(app, { storage: { pos_biz_name: 'Mama Njeri Hardware', aqua_biz_name: 'Mama Njeri Hardware' } });
    for (const [width, cols] of [['58', 32], ['80', 48]]) {
      for (const align of ['justified', 'left', 'right']) {
        w.eval(`receiptWidth='${width}'; receiptItemAlign='${align}';`);
        w.eval('renderReceipt(' + JSON.stringify(SAMPLE_SALE) + ')');
        const sectioned = w.eval("typeof buildReceiptEscPosBytes==='function'");
        const bytes = sectioned
          ? w.eval('buildReceiptEscPosBytes(lastReceiptHeader,lastReceiptItemSection,lastReceiptFooter)')
          : w.eval('buildEscPosBytes(lastReceiptText)');
        const r = decodeEscPos(bytes);
        const label = `${app} ${width}mm ${align}`;
        assert.ok(/ITEM\s+QTY\s+PRICE\s+AMOUNT/.test(r.text) || /Item\s+Qty\s+Total/.test(r.text), `${label}: column headings`);
        assert.equal(r.nonAscii, 0, `${label}: non-ASCII bytes would print as junk`);
        assert.ok(r.fontA, `${label}: font A selected`);
        const longest = Math.max(...r.text.split('\n').map((l) => l.replace(/[\u0000-\u001f]/g, '').length));
        assert.ok(longest <= cols, `${label}: longest line ${longest} > ${cols} columns`);
      }
    }
    assert.deepEqual(errors, []);
    close();
  });
}

// The system-dialog receipt uses the same column titles as the printed one (zip 144: it is the same grid).
for (const app of APPS.filter((a) => a !== 'water/index.html')) {
  test(`${app}: on-screen / system receipt table titles`, async () => {
    const { w, d, close } = await boot(app);
    w.eval('renderReceipt(' + JSON.stringify(SAMPLE_SALE) + ')');
    // zip 144: the preview IS the printed layout (the character grid), so its heading row is the printer's own heading row
    const rows = [...d.querySelectorAll('#receipt-body .receipt-grid .rg-l')].map((t) => t.textContent);
    const head = rows.find((r) => /^ITEM\s+QTY\s+PRICE\s+AMOUNT$/.test(r));
    assert.ok(head, 'column headings row');
    assert.ok(d.querySelector('#receipt-body .rg-b') && [...d.querySelectorAll('#receipt-body .rg-b')].some((e) => e.textContent === head), 'headings in bold');
    close();
  });
}
