import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
// zip 226 — the payslip "Approved by" name can be typed; it shows on the slip and in the PDF.
test('payslip: typed Approved by name appears in the slip model and the PDF', async () => {
  const { w, errors, close } = await boot('index.html', { storage: { pos_biz_name: 'Duka' }, wait: 3000 });
  w.eval("Payroll.setApprovedBy('Jane Wanjiru')");
  assert.equal(w.localStorage.getItem('prl_approved_by'), 'Jane Wanjiru');
  const d = { item: { payslip_no: 'PS-1', emp_name: 'John', basic: 1000, rate_unit: 'period', units: 1, rate: 1000, additions: 0, deductions: 0, net: 1000 }, run: { ref: 'PR-1', kind: 'regular', status: 'paid', period_start: '2026-10-01', period_end: '2026-10-31', pay_date: '2026-10-31' }, lines: [] };
  w.__d = d;
  const m = w.eval('Payroll.calc.slipModel(__d)');
  assert.equal(m.approvedBy, 'Jane Wanjiru');
  const blob = await w.eval('Payroll.calc.slipPdfBlob(Payroll.calc.slipModel(__d))');
  const text = await new Promise((res) => { const r = new w.FileReader(); r.onload = () => res(String(r.result)); r.readAsBinaryString(blob); });
  assert.match(text, /Jane Wanjiru/);
  assert.deepEqual(errors, []); close();
});
