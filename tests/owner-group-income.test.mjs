import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// The new per-person "Quote & Payments" ledger — replaces the old per-link,
// one-time, popup-based "Income recorded" toggle with an inline, repeatable
// entry (so a later entry for an extra service just adds a line), combined
// across every link a person has, matching how the client list already
// groups them by name.
test('Owner Console: recording a quote inline for a grouped person adds an entry, shows a running total, and allows a second entry later for an extra service', async () => {
  let savedEntries = null;
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('/api/owner-lock') && (opts.method || 'GET') === 'POST') {
      const body = JSON.parse(opts.body);
      if (body.action === 'recordGroupIncome') {
        savedEntries = savedEntries || [];
        savedEntries.push({ id: `e${savedEntries.length + 1}`, at: Date.now(), agreed: body.agreedAmount, paid: body.paidAmount, method: body.method, note: body.note });
        return { ok: true, status: 200, json: async () => ({ entries: savedEntries }) };
      }
    }
    return Promise.reject(new Error('offline'));
  };
  const { w, d, errors, close } = await boot('owner/index.html', { fetch: fetchImpl, wait: 900 });
  w.eval("showToast = function () {}; queuePush = function () {}; renderDailySales = function () {};");
  w.eval(`
    unifiedClientsCache = [{ id: 'c1', type: 'permanent', product: 'shop', clientName: 'Maurice Malowa', businessName: 'Achievers Auto Parts', link: 'https://x/', isMainBranch: true }];
    clientDetailCurrentGroup = { key: 'maurice malowa', type: 'permanent', records: unifiedClientsCache };
    groupIncomeCache = {};
  `);

  // First entry: the original quote.
  w.eval("document.getElementById('client-detail-records').innerHTML = groupIncomeHtml('maurice malowa', 'Maurice Malowa');");
  d.getElementById('group-income-agreed-input').value = '5000';
  d.getElementById('group-income-paid-input').value = '3000';
  d.getElementById('group-income-note-input').value = 'Initial setup';
  await w.eval("submitGroupIncomeEntry('maurice malowa', 'Maurice Malowa')");

  assert.equal(w.eval('salesLog.length'), 1, 'the paid portion is recorded as a sale');
  assert.equal(w.eval('salesLog[0].items[0].price'), 3000);
  assert.equal(w.eval('bills.length'), 1, 'the remaining balance becomes a bill');
  assert.equal(w.eval('bills[0].items[0].price'), 2000);
  assert.equal(w.eval("bills[0].groupIncomeDebt.groupKey"), 'maurice malowa', 'tagged distinctly from the old per-link licenseDebt shape');
  assert.equal(w.eval("typeof bills[0].licenseDebt"), 'undefined', 'never collides with the existing per-link settle logic');

  // Second entry, later, for an extra service — the old system could not do this at all (one-time, disabled after set).
  d.getElementById('group-income-agreed-input').value = '1500';
  d.getElementById('group-income-paid-input').value = '1500';
  d.getElementById('group-income-note-input').value = 'Extra service';
  await w.eval("submitGroupIncomeEntry('maurice malowa', 'Maurice Malowa')");

  assert.equal(w.eval('salesLog.length'), 2, 'a second, independent entry is allowed');
  assert.equal(w.eval("groupIncomeCache['maurice malowa'].entries.length"), 2);
  const html = d.getElementById('client-detail-records').innerHTML;
  assert.match(html, /6,500/, 'the running total across both entries is shown (5000+1500 agreed)');
  assert.deepEqual(errors, []);
  close();
});
