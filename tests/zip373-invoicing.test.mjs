import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// zip 373: the Invoicing tab - currencies (KES default, changeable), tax on/off, payments, statements, reconciliation, PDF, every app.
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APPS = ['index.html', 'water/index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html', 'carwash/index.html'];

test('tax: none / on top / included, discount, other currency, status', async () => {
  const d = await boot('index.html', { storage: { pos_biz_name: 'Biz' }, wait: 800 });
  try {
    const w = d.w; const T = (o) => J(w, `Invoicing.totals(${JSON.stringify(o)}, '2026-06-30')`);
    const base = { cur: 'KES', rate: 1, taxRate: 16, lines: [{ qty: 2, price: 500 }, { qty: 1, price: 1000 }], payments: [] };
    let t = T({ ...base, taxMode: 'none' }); assert.equal(t.total, 2000); assert.equal(t.tax, 0);
    t = T({ ...base, taxMode: 'exclusive' }); assert.equal(t.tax, 320); assert.equal(t.total, 2320);
    t = T({ ...base, taxMode: 'inclusive' }); assert.equal(t.total, 2000); assert.equal(t.tax, 275.86); assert.equal(t.net, 1724.14);
    t = T({ ...base, taxMode: 'exclusive', discType: 'pct', discount: 10 }); assert.equal(t.disc, 200); assert.equal(t.tax, 288); assert.equal(t.total, 2088);
    t = T({ ...base, taxMode: 'exclusive', lines: [{ qty: 1, price: 1000 }, { qty: 1, price: 1000, tax: false }] }); assert.equal(t.tax, 160, 'a line marked no-VAT is not taxed');
    t = T({ ...base, cur: 'USD', rate: 130, taxMode: 'none', lines: [{ qty: 3, price: 100 }] }); assert.equal(t.total, 300); assert.equal(t.kes, 39000);
    t = T({ ...base, taxMode: 'none', due: '2026-06-01' }); assert.equal(t.status, 'overdue');
    t = T({ ...base, taxMode: 'none', due: '2026-07-30', payments: [{ amount: 500 }] }); assert.equal(t.status, 'partial'); assert.equal(t.due, 1500);
    t = T({ ...base, taxMode: 'none', payments: [{ amount: 2000 }] }); assert.equal(t.status, 'paid');
    t = T({ ...base, cur: 'UGX', dec: 0, taxMode: 'none', lines: [{ qty: 3, price: 33.4 }] }); assert.equal(t.total, 100, 'a 0-decimal currency rounds to whole units');
  } finally { d.close && d.close(); }
});

test('statement, receive payment (oldest first, extra kept as credit), ageing', async () => {
  const d = await boot('index.html', { storage: { pos_biz_name: 'Biz' }, wait: 800 });
  try {
    const w = d.w;
    w.eval(`(function(){ var D = Invoicing.data(); var mk = function(no, date, due, amt){ return { id: 'i'+no, no: no, client: 'Acme', phone: '0712345678', cur: 'KES', rate: 1, taxMode: 'none', taxRate: 16, date: date, due: due, lines: [{ qty: 1, price: amt }], payments: [], updatedAt: 1 }; };
      D.invoices.push(mk('INV-0001', '2026-01-01', '2026-01-15', 1000), mk('INV-0002', '2026-02-01', '2026-02-15', 2000), mk('INV-0003', '2026-03-01', '2026-03-15', 3000)); })()`);
    const key = w.eval("Invoicing.clientKey({phone:'0712345678'})");
    const r = J(w, `Invoicing.receive('${key}', 'Acme', 'KES', 3500, '2026-03-20', 'M-Pesa', 'QWE1234ABC')`);
    assert.deepEqual(r.used.map((x) => [x.no, x.amount]), [['INV-0001', 1000], ['INV-0002', 2000], ['INV-0003', 500]], 'oldest invoice first');
    assert.equal(r.credit, 0);
    const st = J(w, `Invoicing.statement('${key}', 'KES', '', '')`);
    assert.equal(st.invoiced, 6000); assert.equal(st.paid, 3500); assert.equal(st.closing, 2500);
    const over = J(w, `Invoicing.receive('${key}', 'Acme', 'KES', 5000, '2026-03-25', 'Cash', '')`);
    assert.equal(over.credit, 5000 - 2500, 'more than is owed: the extra is kept as credit on account');
    assert.equal(J(w, `Invoicing.statement('${key}', 'KES', '', '')`).closing, -2500);
    const a = J(w, "Invoicing.ageing('KES', '2026-06-30')"); assert.equal(a.total.all, 0);
    const from = J(w, `Invoicing.statement('${key}', 'KES', '2026-02-01', '')`); assert.equal(from.opening, 1000, 'opening balance before the period is carried (invoice 1 was unpaid on 1 Feb)');
  } finally { d.close && d.close(); }
});

test('bank statement matching: by reference, then amount + date', async () => {
  const d = await boot('index.html', { storage: {}, wait: 600 });
  try {
    const w = d.w;
    const lines = J(w, `Invoicing.parseStatement(${JSON.stringify('12/11/2026  QWE1234ABC  Received from JOHN  15,000.00  120,500.00\n2026-11-13 Deposit 8,000.00\n14 Nov 2026 Cheque 777 4,000.00\nheader line without numbers')}, 'first')`);
    assert.equal(lines.length, 3); assert.equal(lines[0].amount, 15000); assert.equal(lines[0].ref, 'QWE1234ABC'); assert.equal(lines[0].date, '2026-11-12'); assert.equal(lines[1].date, '2026-11-13');
    const pays = [{ id: 'a', no: 'I1', client: 'X', amount: 15000, date: '2026-11-12', ref: 'QWE1234ABC' }, { id: 'b', no: 'I2', client: 'Y', amount: 8000, date: '2026-11-14', ref: '' }, { id: 'c', no: 'I3', client: 'Z', amount: 999, date: '2026-11-14', ref: '' }];
    const m = J(w, `Invoicing.matchPayments(${JSON.stringify(pays)}, ${JSON.stringify(lines)}, 5)`);
    assert.deepEqual(m.matched.map((x) => [x.pay.id, x.how]), [['a', 'reference'], ['b', 'amount + date']]);
    assert.deepEqual(m.missing.map((p) => p.id), ['c']); assert.equal(m.extra.length, 1);
    const second = J(w, `Invoicing.parseStatement('12/11/2026 Paid in 15,000.00 balance 120,500.00', 'last')`); assert.equal(second[0].amount, 120500);
  } finally { d.close && d.close(); }
});

test('the PDF writer makes a valid file (header, xref offsets, page count)', async () => {
  const d = await boot('index.html', { storage: {}, wait: 600 });
  try {
    const w = d.w; const out = w.eval("Array.from(Invoicing.buildPdf([{ w: 100, h: 140, bytes: new Uint8Array([255,216,255,217]) }, { w: 100, h: 60, bytes: new Uint8Array([255,216,255,217]) }]))");
    const buf = Buffer.from(out); const s = buf.toString('latin1');
    assert.ok(s.startsWith('%PDF-1.4')); assert.ok(s.trimEnd().endsWith('%%EOF')); assert.match(s, /\/Count 2/);
    const sx = Number(/startxref\n(\d+)/.exec(s)[1]); assert.equal(s.slice(sx, sx + 4), 'xref');
    const n = Number(/xref\n0 (\d+)/.exec(s.slice(sx))[1]); const lines = s.slice(sx).split('\n').slice(2, 2 + n);
    lines.slice(1).forEach((l, i) => { const off = Number(l.slice(0, 10)); assert.ok(s.slice(off).startsWith((i + 1) + ' 0 obj'), 'object ' + (i + 1) + ' sits at its recorded offset'); });
  } finally { d.close && d.close(); }
});

for (const app of APPS) {
  test(`${app}: the Invoicing tab exists, saves an invoice, KES by default, default currency can change`, async () => {
    const d = await boot(app, { storage: { pos_biz_name: 'Biz' }, wait: 1800 });
    try {
      const w = d.w; w.eval("showToast = function () {}; window.confirm = () => true;");
      assert.ok(w.document.getElementById('invoicing-tab'), 'tab panel present'); assert.ok(w.document.getElementById('invoicing-tab-btn'), 'tab button present');
      assert.equal(w.eval('Invoicing.__v'), 373);
      assert.ok(w.eval("typeof LOCKABLE_TABS === 'undefined' || LOCKABLE_TABS.some(t => t.id === 'invoicing-tab')"), 'can be locked / given as a role');
      w.eval("Invoicing.go('edit')");
      assert.equal(w.eval('Invoicing.state.ed.cur'), 'KES', 'KES is the default');
      w.eval("Invoicing.field('client','Test Client'); Invoicing.line(0,'desc','Service'); Invoicing.line(0,'qty','2'); Invoicing.line(0,'price','1500'); Invoicing.setTax('exclusive'); Invoicing.saveEd();");
      const inv = J(w, 'Invoicing.data().invoices');
      assert.equal(inv.length, 1); assert.equal(inv[0].no, 'INV-0001'); assert.equal(J(w, `Invoicing.totals(${JSON.stringify(inv[0])})`).total, 3480);
      const doc = w.eval("Invoicing.invoiceDoc(Invoicing.data().invoices[0])"); assert.match(doc, /KES 3,480\.00/); assert.match(doc, /Test Client/); assert.match(doc, /VAT 16%/);
      // change the default currency -> the next invoice starts in it
      w.eval("Invoicing.setS('defaultCur','USD'); Invoicing.go('list'); Invoicing.go('edit');");
      assert.equal(w.eval('Invoicing.state.ed.cur'), 'USD'); assert.equal(w.eval('Invoicing.state.ed.no'), 'INV-0002');
      // the second invoice in USD, then the list renders both currencies
      w.eval("Invoicing.field('client','Overseas Ltd'); Invoicing.line(0,'desc','Consulting'); Invoicing.line(0,'price','100'); Invoicing.saveEd(); Invoicing.go('list');");
      const html = w.document.getElementById('vx-body').innerHTML; assert.match(html, /USD 100\.00/); assert.match(html, /KES 3,480\.00/);
      // sales counter: the second currency shows under the payable total
      w.eval("Invoicing.setS('salesAlso','USD')"); const g = w.document.getElementById('cart-grand-total'); assert.ok(g);
      g.textContent = 'Total: KES 1,290.00'; await sleep(250); assert.match(g.textContent, /≈ USD 10\.00/);
    } finally { d.close && d.close(); }
  });
}

test('owner/index.html: the Owner Console has the Invoicing tab and can save an invoice with its own business name', async () => {
  const d = await boot('owner/index.html', { storage: {}, wait: 1800 });
  try {
    const w = d.w; w.eval("window.confirm = () => true;");
    assert.ok(w.document.getElementById('invoicing-tab-btn')); assert.ok(w.document.getElementById('invoicing-tab'));
    w.eval("Invoicing.go('settings'); Invoicing.setS('bizName','Owner Co'); Invoicing.setS('payInfo','M-Pesa Till 123456'); Invoicing.go('edit'); Invoicing.field('client','Shop One'); Invoicing.line(0,'desc','Monthly subscription'); Invoicing.line(0,'price','2500'); Invoicing.saveEd();");
    const doc = w.eval("Invoicing.invoiceDoc(Invoicing.data().invoices[0])");
    assert.match(doc, /Owner Co/); assert.match(doc, /Till 123456/); assert.match(doc, /KES 2,500\.00/);
  } finally { d.close && d.close(); }
});

test('payments can be removed, an invoice can be voided, and the sales line does not loop', async () => {
  const d = await boot('index.html', { storage: { pos_biz_name: 'Biz' }, wait: 1200 });
  try {
    const w = d.w; w.eval("showToast = function () {}; window.confirm = () => true;");
    w.eval("Invoicing.go('edit'); Invoicing.field('client','Zed'); Invoicing.line(0,'desc','Thing'); Invoicing.line(0,'price','1000'); Invoicing.saveEd();");
    const id = w.eval('Invoicing.data().invoices[0].id');
    w.eval(`Invoicing.pay('${id}'); document.getElementById('vx-pa').value = '400'; Invoicing.savePay('${id}');`);
    assert.equal(J(w, `Invoicing.totals(Invoicing.data().invoices[0])`).due, 600);
    const pid = w.eval('Invoicing.data().invoices[0].payments[0].id');
    w.eval(`Invoicing.delPay('${id}', '${pid}')`); assert.equal(J(w, `Invoicing.totals(Invoicing.data().invoices[0])`).due, 1000, 'removed payment no longer counts');
    w.eval(`Invoicing.pay('${id}'); document.getElementById('vx-pa').value = '2000'; Invoicing.savePay('${id}');`);
    assert.equal(J(w, 'Invoicing.data().invoices[0].payments.filter(p => !p._deleted).length'), 0, 'cannot pay more than the balance on one invoice');
    w.eval(`Invoicing.voidInv('${id}')`); assert.equal(J(w, `Invoicing.totals(Invoicing.data().invoices[0])`).status, 'void');
    // the sales line settles (no endless re-adding)
    w.eval("Invoicing.setS('salesAlso','USD')"); const g = w.document.getElementById('cart-grand-total'); g.textContent = 'Total: KES 2,580.00';
    let adds = 0; new w.MutationObserver((m) => { adds += m.length; }).observe(g, { childList: true }); await sleep(900);
    assert.ok(adds <= 4, 'the second-currency line was written ' + adds + ' times'); assert.match(g.textContent, /≈ USD 20\.00/);
  } finally { d.close && d.close(); }
});
