import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 304: the per-person "Quote & Payments" form (and the per-link 💰 switch) each pushed their OWN copy of a payment into the console's sales
// book - recording the same person in both doubled the money. Both are replaced by one "Record a payment" that writes to the single money record
// (/api/owner-money). The person's panel now LISTS what the money record holds for their links and never writes to salesLog / bills itself.
test('Owner Console: a grouped person shows their payments from the one money record, and offers Record a payment instead of the old inline form', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/api/owner-money')) {
      const body = JSON.parse(opts.body || '{}'); calls.push(body);
      if (body.action === 'list') return { ok: true, status: 200, json: async () => ({ ok: true, total: 1, summary: {}, rows: [{ ref: 'purchase:p1', kind: 'link_sale', client_id: 'c1', label: 'Achievers Auto Parts', amount_c: 300000, status: 'success', source: 'gateway', created_at: Date.now(), refunded_c: 0 }] }) };
    }
    return Promise.reject(new Error('offline'));
  };
  const { w, d, errors, close } = await boot('owner/index.html', { fetch: fetchImpl, wait: 1600 });
  w.eval("showToast = function () {}; queuePush = function () {}; renderDailySales = function () {};");
  w.eval(`
    unifiedClientsCache = [{ id: 'c1', type: 'permanent', product: 'shop', clientName: 'Maurice Malowa', businessName: 'Achievers Auto Parts', link: 'https://x/', isMainBranch: true }];
    clientDetailCurrentGroup = { key: 'maurice malowa', type: 'permanent', records: unifiedClientsCache };
  `);
  w.eval("document.getElementById('client-detail-records').innerHTML = groupIncomeHtml('maurice malowa', 'Maurice Malowa');");
  assert.equal(d.getElementById('group-income-agreed-input'), null, 'the old inline form is gone');
  assert.match(d.getElementById('client-detail-records').textContent, /Record a payment/);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(calls.some((c) => c.action === 'list'), 'the money record is read');
  assert.match(d.getElementById('op-client-money').textContent, /3,000/);
  assert.equal(w.eval('salesLog.length + bills.length'), 0, 'nothing is written to the old sales book');
  assert.deepEqual(errors, []);
  close();
});
