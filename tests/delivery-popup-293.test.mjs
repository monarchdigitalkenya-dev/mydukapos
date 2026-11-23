import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice } from './e2e-harness.mjs';

// zip 293: the Delivery button opens the delivery form as a wide popup; Done keeps the sale a delivery; Walk-in closes it.
for (const app of ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'water/index.html']) {
  test(`${app}: Delivery opens a popup with every field, Done keeps delivery with a summary, Walk-in closes it`, async () => {
    const dev = await openDevice(app, makeServer(), {});
    const { w, d } = dev;
    const g = d.getElementById('delivery-details-group');
    assert.ok(g.classList.contains('dlv-pop') && g.classList.contains('dlv-closed'), 'closed at start');
    d.getElementById('order-delivery-btn').click();
    assert.ok(!g.classList.contains('dlv-closed'), 'popup open');
    assert.ok(d.getElementById('dlv-back').classList.contains('on'));
    for (const id of ['delivery-client-name-input', 'delivery-address-input', 'delivery-zone-select', 'delivery-phone-input', 'delivery-fee-input', 'free-delivery-toggle', 'delivery-agent-select', 'delivery-pay-now-btn', 'delivery-pay-pod-btn']) {
      assert.ok(g.querySelector('#' + id), id + ' is inside the popup');
    }
    d.getElementById('delivery-client-name-input').value = 'John';
    d.getElementById('delivery-fee-input').value = '150';
    w.eval('dlvDone()');
    assert.ok(g.classList.contains('dlv-closed'));
    assert.equal(w.eval('orderType'), 'delivery', 'still a delivery');
    assert.match(d.getElementById('dlv-summary').textContent, /John.*150/);
    assert.ok(d.getElementById('dlv-summary').classList.contains('on'));
    w.eval('dlvOpen()'); assert.ok(!g.classList.contains('dlv-closed'));
    w.eval('dlvWalkin()');
    assert.equal(w.eval('orderType'), 'walkin');
    assert.ok(g.classList.contains('dlv-closed') && !d.getElementById('dlv-summary').classList.contains('on'));
    dev.close();
  });
}
