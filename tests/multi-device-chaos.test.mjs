import test from 'node:test';
import assert from 'node:assert/strict';
import { makeServer, openDevice, deviceStorage, sleep } from './e2e-harness.mjs';
import { until } from './helpers.mjs';

// Zip 152 — THE OWNER'S MULTI-DEVICE MATRIX, run for real: several devices on ONE shop link, real app code in a simulated browser, the real
// sync server over a fake store. Devices sell, drop offline, come back, are closed and reopened, at random (a fixed seed, so a failure repeats).
// At the end every device must hold every sale (same ids, same reference numbers), the stock must be exactly opening minus everything sold, and
// nothing may be duplicated. "Each device only sees its own sales" would fail here.
const ITEMS = [
  { code: 'A', type: 'item', name: 'Alpha', price: 100, wholesalePrice: 50, qty: 1000, unit: 'pcs', vatCategory: 'A' },
  { code: 'B', type: 'item', name: 'Beta', price: 60, wholesalePrice: 30, qty: 1000, unit: 'pcs', vatCategory: 'A' },
];
const quiet = (w) => w.eval("showToast = function () {}; window.confirm = () => true; window.print = () => {}");
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// one fetch per device so ONE device can lose its line while the others stay online
function deviceLine(server) {
  const line = { down: false };
  line.fetch = (url, opts) => { if (line.down) return Promise.reject(new Error('offline')); return server.fetch(url, opts); };
  return line;
}
async function sell(dev, code, qty) {
  dev.w.eval(`addToCart('${code}'); ${qty > 1 ? `currentCart['${code}'].qty = ${qty};` : ''} currentPaymentMethod = 'cash'`);
  dev.w.document.getElementById('cash-tendered-input').value = '100000';
  await dev.w.eval('checkoutCart()');
  return dev.w.eval('salesLog[salesLog.length - 1].id');
}
const salesOf = (dev) => dev.w.eval('JSON.stringify(salesLog.filter(s => !s._deleted).map(s => [s.id, s.refNumber]))');
const stockOf = (dev, code) => dev.w.eval(`inventory.find(i => i.code === '${code}').qty`);

async function settle(devs, server, lines) {
  lines.forEach((l) => { l.down = false; });
  server.state.down = false;
  for (let round = 0; round < 3; round++) {
    for (const d of devs) { d.w.eval('window.__pushBackoffUntil = 0'); try { await d.w.eval('flushThenPull()'); } catch (e) { /* retried next round */ } }
    await sleep(60);
  }
}

// Cloudflare KV is eventually consistent: a read can return a copy a moment old. `stale` makes the fake store do that (only for the shop record).
function makeStale(server, r) {
  const kv = server.kv; const hist = new Map(); const ctl = { on: true };
  const g = kv.get.bind(kv), gm = kv.getWithMetadata.bind(kv), pt = kv.put.bind(kv);
  kv.put = async (k, v, o) => { if (k.startsWith('pos-data:state:')) { const h = hist.get(k) || []; const cur = kv.data.get(k); if (cur) h.push({ value: cur.value, metadata: cur.metadata }); hist.set(k, h.slice(-3)); } return pt(k, v, o); };
  const pick = (k) => { if (!ctl.on || !k.startsWith('pos-data:state:') || r() > 0.35) return null; const h = hist.get(k) || []; return h.length ? h[Math.floor(r() * h.length)] : null; };
  kv.get = async (k) => { const s = pick(k); return s ? s.value : g(k); };
  kv.getWithMetadata = async (k) => { const s = pick(k); return s ? { value: s.value, metadata: s.metadata ?? null } : gm(k); };
  return ctl;
}

for (const [seed, steps, stale] of [[152, 48, false], [7, 70, false], [2026, 70, true], [99, 90, true]]) test(`4 devices, random sales / offline / restarts (seed ${seed}, ${steps} steps${stale ? ', stale reads from the store' : ''}): every device ends with every sale, same references, exact stock, no duplicates`, async () => {
  const server = makeServer();
  const staleCtl = stale ? makeStale(server, rng(seed + 1)) : null;
  const lines = [];
  const devs = [];
  const open = async (storage, i) => { const line = lines[i] || (lines[i] = deviceLine(server)); const d = await openDevice('index.html', server, storage, 700, { fetch: line.fetch }); quiet(d.w); return d; };
  devs.push(await open({ pos_inventory: JSON.stringify(ITEMS) }, 0));
  await devs[0].w.eval('pushNow()'); await devs[0].w.eval('pullState()');
  for (let i = 1; i < 4; i++) {
    const st = deviceStorage(devs[0].w); delete st.pos_device_id; delete st.pos_till_no; delete st.pos_till_ref_seq; delete st.pos_last_synced_at;
    devs.push(await open(st, i)); await devs[i].w.eval('pushNow()'); await devs[i].w.eval('pullState()');
  }
  const r = rng(seed);
  const soldIds = []; const sold = { A: 0, B: 0 };
  for (let step = 0; step < steps; step++) {
    const i = Math.floor(r() * 4); const dev = devs[i]; const roll = r();
    if (roll < 0.62) {
      const code = r() < 0.5 ? 'A' : 'B'; const qty = 1 + Math.floor(r() * 3);
      soldIds.push(await sell(dev, code, qty)); sold[code] += qty;
    } else if (roll < 0.78) { lines[i].down = !lines[i].down; }
    else if (roll < 0.9) {                                  // the app is closed and opened again (from what it saved on the device)
      const st = deviceStorage(dev.w); await sleep(30); dev.close(); devs[i] = await open(st, i);
    } else { try { await dev.w.eval('pullState()'); } catch (e) { /* offline */ } }
    await sleep(15);
  }
  await settle(devs, server, lines);
  if (process.env.CHAOS_DIAG) console.log('DIAG after settle with stale ON:', server.serverState().salesLog.filter((s) => !s._deleted).length, 'of', soldIds.length);
  if (staleCtl) { staleCtl.on = false; await settle(devs, server, lines); }   // KV staleness is transient (about a minute): once it heals, every device must converge
  const serverSales = server.serverState().salesLog.filter((s) => !s._deleted);
  assert.equal(serverSales.length, soldIds.length, 'the server holds every sale that was rung up');
  const truth = JSON.stringify(serverSales.map((s) => [s.id, s.refNumber]).sort());
  for (let i = 0; i < 4; i++) {
    const mine = JSON.stringify(JSON.parse(salesOf(devs[i])).sort());
    assert.equal(mine, truth, `device ${i + 1} holds exactly the shop's sales`);
    assert.equal(stockOf(devs[i], 'A'), 1000 - sold.A, `device ${i + 1} stock A`);
    assert.equal(stockOf(devs[i], 'B'), 1000 - sold.B, `device ${i + 1} stock B`);
  }
  assert.equal(new Set(serverSales.map((s) => s.refNumber)).size, serverSales.length, 'every reference number is different');
  devs.forEach((d) => d.close());
});
