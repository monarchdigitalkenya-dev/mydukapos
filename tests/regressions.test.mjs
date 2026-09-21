import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, SAMPLE_SALE, decodeEscPos, until } from './helpers.mjs';

test('water: report Download/Share text and attendance-roster edit no longer throw', async () => {
  const { w, d, errors, close } = await boot('water/index.html', {
    storage: { aqua_attendance_roster: JSON.stringify([{ id: 'p1', name: 'Jane', expectedClockIn: '', expectedClockOut: '' }]) },
  });
  w.eval("updateAttendanceRosterExpectedTime('p1','expectedClockIn','08:00')");
  assert.equal(JSON.parse(w.localStorage.getItem('aqua_attendance_roster'))[0].expectedClockIn, '08:00');
  d.getElementById('sales-report-body').innerHTML = '<h3>Daily Sales Report</h3><p>Bottle 500ml</p>';
  await new Promise((r) => setTimeout(r, 50));
  assert.match(w.eval('lastReportText'), /Daily Sales Report/);
  assert.match(w.eval('reportFilenameBase()'), /^report-/);
  assert.deepEqual(errors, []);
  close();
});

for (const app of ['hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html']) {
  test(`${app}: USB/Bluetooth receipt prints sectioned (centred + bold business name)`, async () => {
    const { w, close } = await boot(app, { storage: { pos_biz_name: 'Mama Njeri Hardware' } });
    w.eval("receiptWidth='80'; receiptItemAlign='justified';");
    w.eval('renderReceipt(' + JSON.stringify(SAMPLE_SALE) + ')');
    const r = decodeEscPos(w.eval('buildEscPosBytes(lastReceiptText)'));
    assert.ok(r.centred && r.bold, 'header centred and business name bold');
    assert.match(r.text, /MAMA NJERI HARDWARE/);
    close();
  });
}

test('storage: "Shrink product photos" shrinks oversized photos and leaves small ones alone', async () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(200000);
  const small = 'data:image/jpeg;base64,' + 'B'.repeat(5000);
  const items = [{ code: '1', name: 'Big', qty: 5, price: 10, image: big }, { code: '2', name: 'Small', qty: 5, price: 10, image: small }, { code: '3', name: 'NoImg', qty: 1, price: 1 }];
  const { w, d, close } = await boot('index.html', {
    storage: { pos_inventory: JSON.stringify(items) },
    getContext: () => ({ fillRect() {}, drawImage() {}, fillStyle: '' }),
    toDataURL: () => 'data:image/jpeg;base64,' + 'C'.repeat(9000),
    Image: class { set src(v) { this._s = v; setTimeout(() => { this.width = 1200; this.height = 900; this.onload && this.onload(); }, 1); } get src() { return this._s; } },
  });
  d.getElementById('settings-section-install').classList.add('active');
  await new Promise((r) => setTimeout(r, 100));
  d.getElementById('sh-shrink-btn').click();
  await until(() => { try { return JSON.parse(w.localStorage.getItem('pos_inventory'))[0].image.length < 20000; } catch (e) { return false; } });
  const stored = JSON.parse(w.localStorage.getItem('pos_inventory'));
  assert.ok(stored[0].image.length < 20000, 'big photo shrunk');
  assert.equal(stored[1].image, small, 'small photo untouched');
  assert.equal(stored[2].image, undefined);
  close();
});
