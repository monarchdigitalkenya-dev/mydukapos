import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// downloadReceiptPdf()/downloadReportPdf() used to call textToPdfBlob() with
// no error handling at all — a canvas/PDF build failure (e.g. an oversized
// report on a low-memory device) meant the button silently did nothing,
// with no toast and no visible sign anything went wrong.
const APPS = ['index.html', 'water/index.html', 'hotel/index.html'];

for (const app of APPS) {
  test(`${app}: a failure building the receipt/report PDF shows an error toast instead of failing silently`, async () => {
    const { w, errors, close } = await boot(app, { wait: 900 });
    w.eval("showToast = function (m, isErr) { window.__toasts = (window.__toasts || []).concat(m); };");
    w.eval("lastReceiptText = 'Some receipt text'; lastReportText = 'Some report text';");
    // Simulate a canvas/PDF build failure exactly like a real one would surface.
    w.eval("window.__origTextToPdfBlob = textToPdfBlob; textToPdfBlob = function () { throw new Error('canvas too large'); };");
    await w.eval('downloadReceiptPdf()');
    await w.eval('downloadReportPdf()');
    const toasts = (w.eval('window.__toasts') || []).join(' | ');
    assert.match(toasts, /Could not generate the receipt PDF/);
    assert.match(toasts, /Could not generate the report PDF/);
    // No uncaught exception reached the page (the whole point of the fix).
    assert.deepEqual(errors, []);
    close();
  });
}
