import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 376: cash surplus is added and shortage subtracted under profit; the final profit follows.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('CashDiff totals: counted sessions only, rejected left out, by date', async () => {
  const d = await boot('index.html', { storage: { pos_biz_name: 'Biz' }, wait: 800 });
  try {
    const w = d.w;
    w.eval(`cashSessions.length = 0;
      var t = Date.now();
      cashSessions.push({ id: 'a', openedAt: t - 5000, status: 'closed', closing: { status: 'counted', variance: 300, at: t - 4000, approval: { status: 'not-required' } } });
      cashSessions.push({ id: 'b', openedAt: t - 5000, status: 'closed', closing: { status: 'counted', variance: -120.5, at: t - 3000, approval: { status: 'approved' } } });
      cashSessions.push({ id: 'c', openedAt: t - 5000, status: 'closed', closing: { status: 'counted', variance: -999, at: t - 2000, approval: { status: 'rejected' } } });
      cashSessions.push({ id: 'd', openedAt: t - 5000, status: 'open', closing: null });
      cashSessions.push({ id: 'e', openedAt: t - 9e9, status: 'closed', closing: { status: 'counted', variance: 50, at: t - 9e9, approval: { status: 'not-required' } } });`);
    const r = JSON.parse(w.eval(`JSON.stringify(CashDiff.between(new Date(Date.now() - 86400000), new Date(Date.now() + 86400000)))`));
    assert.deepEqual(r, { surplus: 300, shortage: 120.5, net: 179.5, count: 2 });
    const k = JSON.parse(w.eval(`JSON.stringify(CashDiff.between(dateKey(new Date()), dateKey(new Date())))`));
    assert.equal(k.net, 179.5, 'date-key ranges work too');
  } finally { d.close && d.close(); }
});

test('Profits tab shows surplus, shortage and Final profit; Expenses & Profit report too', async () => {
  const d = await boot('index.html', { storage: { pos_biz_name: 'Biz' }, wait: 800 });
  try {
    const w = d.w;
    w.eval(`cashSessions.length = 0; var t = Date.now();
      cashSessions.push({ id: 'a', openedAt: t - 5000, status: 'closed', closing: { status: 'counted', variance: 300, at: t - 4000, approval: { status: 'not-required' } } });
      cashSessions.push({ id: 'b', openedAt: t - 5000, status: 'closed', closing: { status: 'counted', variance: -100, at: t - 3000, approval: { status: 'not-required' } } });`);
    w.eval(`document.getElementById('profit-gross-total'); renderProfitReport();`);
    await sleep(100);
    const box = w.document.getElementById('profit-cash-adj');
    assert.ok(box, 'panel exists'); assert.notEqual(box.style.display, 'none');
    const txt = box.textContent;
    assert.match(txt, /Cash surplus[\s\S]*300\.00/); assert.match(txt, /Cash shortage[\s\S]*100\.00/); assert.match(txt, /Final profit[\s\S]*200\.00/, 'net 0 + 300 - 100');
    const rep = JSON.parse(w.eval(`JSON.stringify((function(){ var r = reportBuildExpenses({ from: new Date(Date.now() - 86400000), to: new Date(Date.now() + 86400000) }); return r.html; })())`));
    assert.match(rep, /Cash surplus/); assert.match(rep, /Final profit/);
    w.eval('cashSessions.length = 0; renderProfitReport();');
    assert.equal(w.document.getElementById('profit-cash-adj').style.display, 'none', 'no counted differences: panel hidden');
    const none = JSON.parse(w.eval(`JSON.stringify(reportBuildExpenses({ from: new Date(Date.now() - 86400000), to: new Date(Date.now() + 86400000) }).html)`));
    assert.doesNotMatch(none, /Final profit/);
  } finally { d.close && d.close(); }
});

test('printed Profit Report carries the cash lines and the final profit', async () => {
  const d = await boot('index.html', { storage: { pos_biz_name: 'Biz' }, wait: 800 });
  try {
    const w = d.w;
    w.eval(`cashSessions.length = 0; var t = Date.now();
      cashSessions.push({ id: 'a', openedAt: t - 5000, status: 'closed', closing: { status: 'counted', variance: 300, at: t - 4000, approval: { status: 'not-required' } } });
      window.__got = ''; window.__orig = window.triggerAutoPrintReport;`);
    w.eval(`(function(){ var real = window.triggerAutoPrintReport; })()`);
    // stand in for the printer: the hook wraps whatever triggerAutoPrintReport is at print time
    w.eval(`window.triggerAutoPrintReport = function () { window.__got = lastReportText; };`);
    w.eval('printProfitsReport()');
    await sleep(100);
    const got = w.eval('window.__got');
    assert.match(got, /Cash surplus: KES 300\.00/); assert.match(got, /Cash shortage: KES 0\.00/); assert.match(got, /Final profit: KES 300\.00/);
    assert.equal(typeof w.eval('window.triggerAutoPrintReport'), 'function');
  } finally { d.close && d.close(); }
});
