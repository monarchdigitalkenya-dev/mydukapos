import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 248 - Aqua: pressing Dispatch while the Shop was on screen took stock out of the Shop and put it back into the Shop (nothing reached the branch).
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
async function app() {
  const b = await boot('water/index.html', { url: 'https://demo.mydukapos.store/' });
  b.w.eval("showToast = function (m, e) { (window.__toasts = window.__toasts || []).push((e ? 'ERR ' : '') + m); }; window.confirm = () => true; setActiveSite('site-production');");
  b.w.eval("products.push({ code:'BT1', name:'Bottle 500', category:'bottled', qty:100, price:10, wholesalePrice:5, stock:{'site-production':100,'site-shop-1':3} });");
  b.w.eval("tanks.push({id:'tp',name:'T',siteId:'site-production',capacityLiters:1000,currentVolumeLiters:500,refillLog:[]}); tanks.push({id:'ts',name:'TS',siteId:'site-shop-1',capacityLiters:1000,currentVolumeLiters:10,refillLog:[]});");
  b.w.eval("setActiveSite('site-shop-1')");
  return b;
}

test('D1: Dispatch pressed while viewing the Shop moves to Production and really sends the goods to the Shop', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("renderDispatchTab()");
  [...d.querySelectorAll('#factory-stock-table-body button')].find(x => /Dispatch/.test(x.textContent)).click();
  assert.equal(w.eval('activeSiteId'), 'site-production');
  assert.match(d.getElementById('site-dispatch-subtitle').textContent, /100 in stock at Production/);
  d.getElementById('site-dispatch-qty-input').value = '5';
  w.eval('confirmSiteDispatch()');
  assert.deepEqual(J(w, "products.find(x=>x.code==='BT1').stock"), { 'site-production': 95, 'site-shop-1': 8 });
  b.close();
});

test('D2: the bell shortcut and the shop-request Dispatch button work from the Shop too', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("dispatchFromNotifBell('BT1')");
  assert.equal(w.eval('activeSiteId'), 'site-production');
  assert.equal(d.getElementById('site-dispatch-modal').style.display, 'flex');
  b.close();
});

test('D3: refill dispatch from the Shop moves to Production first and sends the litres', async () => {
  const b = await app(); const { w, d } = b;
  w.eval('openRefillDispatchModal()');
  assert.equal(w.eval('activeSiteId'), 'site-production');
  d.getElementById('refill-dispatch-mode').value = 'litres';
  d.getElementById('refill-dispatch-qty').value = '20';
  w.eval('confirmRefillDispatch()');
  assert.equal(J(w, "tanks.find(t=>t.id==='tp').currentVolumeLiters"), 480);
  assert.equal(J(w, "tanks.find(t=>t.id==='ts').currentVolumeLiters"), 30);
  b.close();
});

test('D4: a staff login locked to the Shop CAN dispatch (temporary switch to Production), and is put back on the Shop afterwards', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("currentServer = { id: 'st1', name: 'Amy' };");
  w.eval("openDispatchModal('BT1')");
  assert.equal(d.getElementById('site-dispatch-modal').style.display, 'flex');
  assert.equal(w.eval('activeSiteId'), 'site-production');
  d.getElementById('site-dispatch-qty-input').value = '2';
  w.eval('confirmSiteDispatch()');
  assert.equal(w.eval('activeSiteId'), 'site-shop-1');
  assert.deepEqual(J(w, "products.find(x=>x.code==='BT1').stock"), { 'site-production': 98, 'site-shop-1': 5 });
  b.close();
});

test('D5: staff who could use Production keep the Dispatch tab (it used to be part of Production); others stay without', async () => {
  const b = await app(); const { w, d } = b;
  w.eval("staff.push({ id: 'st2', name: 'Bo', roles: ['production-tab'] }, { id: 'st3', name: 'Cy', roles: ['sales-tab'] });");
  w.eval("currentServer = { id: 'st2', name: 'Bo' }");
  assert.equal(w.eval("isTabLocked('dispatch-tab')"), false);
  w.eval("currentServer = { id: 'st3', name: 'Cy' }");
  assert.equal(w.eval("isTabLocked('dispatch-tab')"), true);
  b.close();
});

// ---- base link lists everyone; #shop / #production narrow it ----
async function picker(url) {
  const b = await boot('water/index.html', { url });
  b.w.eval("staff.length = 0; staff.push({ id:'s1', name:'Shopper', siteId:'site-shop-1', roles:['sales-tab'] }, { id:'s2', name:'Maker', siteId:'site-production', roles:['production-tab'] }); renderLoginPicker();");
  return b;
}
test('P1: the plain link lists ALL staff (both sites) plus Admin', async () => {
  const b = await picker('https://demo.mydukapos.store/'); const t = b.d.getElementById('login-picker-list').textContent;
  assert.match(t, /Shopper/); assert.match(t, /Maker/); assert.match(t, /Admin/);
  b.close();
});
test('P2: #production shows only Production staff; #shop only Shop staff', async () => {
  let b = await picker('https://demo.mydukapos.store/#production'); let t = b.d.getElementById('login-picker-list').textContent;
  assert.match(t, /Maker/); assert.doesNotMatch(t, /Shopper/); b.close();
  b = await picker('https://demo.mydukapos.store/#shop'); t = b.d.getElementById('login-picker-list').textContent;
  assert.match(t, /Shopper/); assert.doesNotMatch(t, /Maker/); b.close();
});
test('P3: on the plain link a Production staff member lands on Production without the link being rewritten', async () => {
  const b = await picker('https://demo.mydukapos.store/'); const { w } = b;
  w.eval("staffHomeSiteApply(staff.find(s => s.id === 's2'))");
  assert.equal(w.eval('activeSiteId'), 'site-production');
  assert.equal(w.eval('location.hash'), '');
  b.close();
});
