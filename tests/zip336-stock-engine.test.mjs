// zip 336: the Stock Engine (src/shared/blocks/stock-engine.html) - FIFO / FEFO batches, packaging levels, transfer identity, the cost-fix overlay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSE } from './se-load.mjs';

const TODAY = '2026-10-27';
const plain = (x) => JSON.parse(JSON.stringify(x));   // the engine runs in its own context: compare plain copies

test('Test B - FIFO: 10 @ 100 then 20 @ 120, sell 12 = COGS 1,240; A empty, B 18; a later cost edit does not change the sale', () => {
  const c = loadSE(); const SE = c.SE;
  c.localStorage.setItem('se_lot_policy', 'fifo');
  const p = { code: 'A1', name: 'Gloves', unit: 'pcs', wholesalePrice: 100, batches: [], qty: 0 };
  const a = SE.receive(p, { qty: 10, cost: 100, at: 1000 });
  const b = SE.receive(p, { qty: 20, cost: 120, at: 2000 });
  assert.equal(p.qty, 30);
  const line = { code: 'A1', qty: 12, price: 150 };
  const res = SE.consume(p, 12, { today: TODAY });
  SE.stampLine(line, res, p);
  assert.equal(res.cost, 1240);
  assert.equal(res.short, 0);
  assert.deepEqual(plain(res.allocs.map((x) => [x.id, x.q, x.c])), [[a.id, 10, 100], [b.id, 2, 120]]);
  assert.equal(p.batches.find((x) => x.id === a.id), undefined, 'batch A is used up');
  assert.equal(p.batches.find((x) => x.id === b.id).qty, 18);
  assert.equal(p.qty, 18);
  assert.equal(SE.r2(line.wholesalePrice * line.qty), 1240, 'the line carries the cost of the batches it used');
  p.wholesalePrice = 999;                       // the current cost price changes later
  assert.equal(SE.lineCogs(line), 1240, 'the old sale keeps its own cost');
});

test('Test C - FEFO: the earlier expiry goes first; expired, quarantined and recalled batches are never sold; FIFO breaks a tie', () => {
  const c = loadSE(); const SE = c.SE;
  const p = { code: 'M1', name: 'Amoxicillin 250mg', unit: 'caps', wholesalePrice: 5, batches: [], qty: 0 };
  const later = SE.receive(p, { qty: 50, cost: 6, expiry: '2027-06-30', at: 1000 });
  const sooner = SE.receive(p, { qty: 30, cost: 5, expiry: '2027-01-31', at: 2000 });
  const r = SE.consume(p, 10, { today: TODAY });
  assert.deepEqual(plain(r.allocs.map((x) => x.id)), [sooner.id], 'batch A (expires earlier) first');
  assert.equal(p.batches.find((x) => x.id === sooner.id).qty, 20);
  assert.equal(p.batches.find((x) => x.id === later.id).qty, 50, 'batch B untouched');
  // an expired batch that is also the OLDEST received is still never sold
  const q = { code: 'M2', name: 'X', unit: 'tabs', batches: [], qty: 0 };
  const expired = SE.receive(q, { qty: 40, cost: 1, expiry: '2026-09-30', at: 10 });
  const quarantined = SE.receive(q, { qty: 40, cost: 1, expiry: '2027-01-01', at: 20 }); quarantined.status = 'quarantine';
  const recalled = SE.receive(q, { qty: 40, cost: 1, expiry: '2027-01-02', at: 30 }); recalled.status = 'recalled';
  const good = SE.receive(q, { qty: 5, cost: 2, expiry: '2028-01-01', at: 40 });
  assert.equal(SE.usableQty(q, TODAY), 5);
  const r2 = SE.consume(q, 5, { today: TODAY });
  assert.deepEqual(plain(r2.allocs.map((x) => x.id)), [good.id]);
  const r3 = SE.consume(q, 1, { today: TODAY });
  assert.equal(r3.allocs.length, 0, 'nothing usable left');
  assert.equal(r3.short, 1);
  assert.equal(q.batches.find((x) => x.id === expired.id).qty, 40, 'the expired batch is still there - not sold');
  // force (goods that already left the counter) never takes a RECALLED batch, and flags what it took
  const r4 = SE.consume(q, 45, { today: TODAY, force: true });
  assert.ok(r4.allocs.every((x) => x.forced));
  assert.ok(!r4.allocs.some((x) => x.id === recalled.id), 'a recalled batch is never taken');
  // same expiry: the one received first goes first
  const t = { code: 'M3', unit: 'pcs', batches: [], qty: 0 };
  const t2 = SE.receive(t, { qty: 5, expiry: '2027-03-01', at: 200 });
  const t1 = SE.receive(t, { qty: 5, expiry: '2027-03-01', at: 100 });
  assert.equal(SE.consume(t, 1, { today: TODAY }).allocs[0].id, t1.id);
  void t2;
});

test('stock without a batch on file is kept (one "Stock before batches" batch, no cost invented)', () => {
  const c = loadSE(); const SE = c.SE;
  const p = { code: 'K', unit: 'pcs', qty: 7, wholesalePrice: 50 };             // stock from before batches were kept
  SE.receive(p, { qty: 3, cost: 60, expiry: '2027-01-01' });
  assert.equal(p.qty, 10, 'the 7 already on hand are not lost');
  const pre = p.batches.find((b) => b.batchNumber === 'Stock before batches');
  assert.equal(pre.qty, 7); assert.equal(pre.cost, null); assert.equal(pre.receivedAt, 0);
  assert.equal(SE.lotSummary(p, TODAY).noCost, 7);
  // in hospital the batch number field is batchNo
  const h = { code: 'H', unit: 'pcs', qty: 0, batches: [] };
  const hb = SE.receive(h, { qty: 2, batch: 'B-9', hospital: true });
  assert.equal(hb.batchNo, 'B-9'); assert.equal(hb.batchNumber, 'B-9');
});

test('a void / return goes back into the very batches the sale used (an emptied batch is recreated with its expiry and cost)', () => {
  const c = loadSE(); const SE = c.SE;
  const p = { code: 'R', unit: 'pcs', batches: [], qty: 0 };
  const a = SE.receive(p, { qty: 4, cost: 10, expiry: '2027-01-01', batch: 'A' });
  const b = SE.receive(p, { qty: 10, cost: 12, expiry: '2027-05-01', batch: 'B' });
  const line = {}; SE.stampLine(line, SE.consume(p, 6, { today: TODAY }), p);
  assert.equal(p.batches.find((x) => x.id === a.id), undefined);
  assert.equal(line.wholesalePrice, 10.6667);
  SE.restore(p, line.lots, 1);                       // a partial return: the last batch taken first
  assert.equal(p.batches.find((x) => x.id === b.id).qty, 9);
  SE.restore(p, line.lots, 5, 1);                    // ... then the rest (1 already back), recreating batch A
  const back = p.batches.find((x) => x.id === a.id);
  assert.deepEqual(plain([back.qty, back.cost, back.expiryDate, back.batchNumber]), [4, 10, '2027-01-01', 'A']);
  assert.equal(p.batches.find((x) => x.id === b.id).qty, 10, 'batch B got back exactly the 2 it gave - not more');
  assert.equal(p.qty, 14);
});

test('Test D - packaging: carton = 10 packets, packet = 20 mini-packets; receive 2 cartons = 400; sell 3 packets + 7 = 333', () => {
  const c = loadSE(); const SE = c.SE;
  const built = SE.buildLevels([{ name: 'Carton', parent: 'Packet', count: 10 }, { name: 'Packet', parent: 'base', count: 20 }], 'mini-packet', []);
  assert.equal(built.ok, true, built.error);
  const p = { code: 'S', name: 'Sweets', unit: 'mini-packet', qty: 0, packs: built.packs };
  const carton = built.packs.find((l) => l.name === 'Carton'), packet = built.packs.find((l) => l.name === 'Packet');
  assert.equal(carton.per, 200); assert.equal(packet.per, 20);
  assert.equal(carton.parent, packet.id, 'the parent is stored as the level id');
  p.qty += SE.toBase(p, 2, carton.id);
  assert.equal(p.qty, 400);
  assert.equal(SE.label(p, 400), '2 Carton');
  p.qty -= SE.toBase(p, 3, packet.id);
  assert.equal(p.qty, 340);
  p.qty -= 7;
  assert.equal(p.qty, 333);
  assert.equal(SE.label(p, 333), '1 Carton + 6 Packet + 13 mini-packet');
  // cost: a carton at KES 2,000 holds 200 -> KES 10 per mini-packet (not 2,000 each)
  assert.equal(SE.baseCostFrom(p, carton.id, 2000), 10);
  assert.equal(SE.levelCost(p, packet.id, 10), 200);
  // a line sold by packet: 3 packets; its multiplier was recorded at the time of sale
  const line = { code: 'S', qty: 3, saleMode: 'pack:' + packet.id, packPer: 20 };
  assert.equal(SE.linePer(line, p), 20);
  p.packs = SE.buildLevels([{ name: 'Packet', parent: 'base', count: 25 }], 'mini-packet', p.packs).packs;   // the packet size changes later
  assert.equal(SE.linePer(line, p), 20, 'an old line keeps the size it was sold at');
  // scanning a package barcode
  const q = { code: 'Q', unit: 'pcs', packs: SE.buildLevels([{ name: 'Box', parent: 'base', count: 12, barcode: '6001' }], 'pcs', []).packs };
  assert.equal(SE.findPackBarcode([p, q], '6001').product, q);
});

test('packaging levels are validated (whole numbers for counted units, no loops, no duplicates, no 1-unit level)', () => {
  const { SE } = loadSE();
  assert.match(SE.buildLevels([{ name: 'Strip', parent: 'base', count: 2.5 }], 'tabs').error, /whole number/);
  assert.equal(SE.buildLevels([{ name: 'Jug', parent: 'base', count: 2.5 }], 'litre').ok, true, 'a measured unit may be fractional');
  assert.match(SE.buildLevels([{ name: 'A', parent: 'B', count: 2 }, { name: 'B', parent: 'A', count: 3 }], 'pcs').error, /does not exist|itself/);
  assert.match(SE.buildLevels([{ name: 'Box', parent: 'base', count: 10 }, { name: 'box', parent: 'base', count: 12 }], 'pcs').error, /Two levels/);
  assert.match(SE.buildLevels([{ name: 'Box', parent: 'base', count: 1 }], 'pcs').error, /just one/);
  assert.match(SE.buildLevels([{ name: 'Box', parent: 'base', count: 10 }, { name: 'Case', parent: 'base', count: 10 }], 'pcs').error, /same amount/);
  assert.match(SE.buildLevels([{ name: 'pcs', parent: 'base', count: 10 }], 'pcs').error, /base unit/);
});

test('transfer identity: same code; a remembered link; ONE same-name + same-unit item; several look-alikes are ambiguous (never guessed)', () => {
  const { SE } = loadSE();
  const inv = [
    { code: '00012', name: 'Hospital gloves', unit: 'bags', qty: 10 },
    { code: 'P500', name: 'Paracetamol 500mg', unit: 'tabs', qty: 5 },
    { code: 'P250', name: 'Paracetamol 250mg', unit: 'tabs', qty: 5 },
    { code: 'S1', name: 'Syringe', unit: 'pcs', qty: 5 }, { code: 'S2', name: 'Syringe', unit: 'pcs', qty: 5 },
    { code: 'V', name: 'Gauze', unit: 'pcs', hasVariants: true, variants: [{ id: 'v1', code: 'GZ-S', name: 'Small', qty: 1 }] },
    { code: 'SV', name: 'Consultation', type: 'service' },
  ];
  assert.equal(SE.matchLine(inv, { code: '00012', name: 'x' }).product.code, '00012');
  // the gloves case: the Store line had its own code (or none) - it is still the same product, not a second item
  const g = SE.matchLine(inv, { code: 'G-STORE-1', name: 'Hospital gloves', unit: 'bags' });
  assert.deepEqual([g.kind, g.product.code], ['item', '00012']);
  assert.equal(SE.matchLine(inv, { code: null, name: 'hospital  GLOVES', unit: 'bags' }).product.code, '00012');
  assert.equal(SE.matchLine(inv, { name: 'Hospital gloves', unit: 'box' }).kind, 'ambiguous', 'a different unit is not assumed to be the same product');
  assert.equal(SE.matchLine(inv, { name: 'Paracetamol 250mg', unit: 'tabs' }).product.code, 'P250', 'a different strength stays distinct');
  assert.equal(SE.matchLine(inv, { name: 'Syringe', unit: 'pcs' }).kind, 'ambiguous');
  assert.equal(SE.matchLine(inv, { storeItemId: 'st9', name: 'Syringe', unit: 'pcs' }, { st9: 'S2' }).product.code, 'S2', 'the store line it went to before');
  assert.equal(SE.matchLine(inv, { code: 'V::v1', name: 'Gauze (Small)' }).variant.code, 'GZ-S');
  assert.equal(SE.matchLine(inv, { code: 'GZ-S', name: 'Gauze small' }).kind, 'variant');
  assert.equal(SE.matchLine(inv, { code: 'NEW', name: 'Brand new thing' }).kind, 'new');
  assert.equal(SE.matchLine(inv, { code: 'SV', name: 'Consultation' }).kind, 'new', 'a service code never receives stock');
  assert.equal(SE.duplicateItems(inv).length, 1, 'the two Syringe items are listed as possible duplicates');
});

test('cost corrections (restate) are laid over the sale lines in their date range - the sales themselves are not changed', () => {
  const c = loadSE(); const SE = c.SE;
  const s1 = { timestamp: '2026-10-10T08:00:00+03:00', items: [{ code: 'X', qty: 2, price: 50, wholesalePrice: 2000 }] };          // carton cost typed per piece
  const s2 = { timestamp: '2026-10-20T08:00:00+03:00', items: [{ code: 'X', qty: 1, price: 50, wholesalePrice: 2000 }, { code: 'Y', qty: 1, price: 9, wholesalePrice: 5 }] };
  const s3 = { timestamp: '2026-09-01T08:00:00+03:00', items: [{ code: 'X', qty: 1, price: 50, wholesalePrice: 2000 }] };          // before the correction's range
  c.salesLog = [s1, s2, s3];
  const before = JSON.stringify(c.salesLog);
  assert.equal(SE.lineCogs(s1.items[0]), 4000);
  SE.setCorrections([{ corr_id: 'k1', code: 'X', mode: 'restate', old_cost: 2000, new_cost: 10, date_from: '2026-10-01', date_to: '2026-10-31' }]);
  assert.equal(SE.lineCogs(s1.items[0]), 20);
  assert.equal(SE.lineCogs(s2.items[0]), 10);
  assert.equal(SE.lineCogs(s2.items[1]), 5, 'another item is untouched');
  assert.equal(SE.lineCogs(s3.items[0]), 2000, 'a sale before the range keeps its cost');
  assert.equal(JSON.stringify(c.salesLog), before, 'no sale record was modified');
  // a "forward" correction never touches past sales
  SE.setCorrections([{ corr_id: 'k2', code: 'X', mode: 'forward', old_cost: 2000, new_cost: 10 }]);
  assert.equal(SE.lineCogs(s1.items[0]), 4000);
  // a batch correction only touches the lines that used that batch
  const s4 = { timestamp: '2026-10-21T08:00:00+03:00', items: [{ code: 'Z', qty: 3, price: 10, wholesalePrice: 7, lots: [{ id: 'L1', q: 2, c: 9 }, { id: 'L2', q: 1, c: 3 }] }] };
  c.salesLog = [s4];
  SE.setCorrections([{ corr_id: 'k3', code: 'Z', lot_id: 'L1', mode: 'restate', old_cost: 9, new_cost: 4, date_from: '2026-10-01' }]);
  assert.equal(SE.lineCogs(s4.items[0]), 21 - 18 + 8);
});

test('the cost check lists a cost above the price, a carton cost typed per piece, sales at a loss and stock without a cost', () => {
  const { SE } = loadSE();
  const inv = [{ code: 'A', name: 'A', price: 50, wholesalePrice: 2000, qty: 5 }, { code: 'B', name: 'B', price: 50, wholesalePrice: 30, qty: 5 }, { code: 'C', name: 'C', price: 20, wholesalePrice: 0, qty: 3 }];
  const sales = [{ refNumber: 'R1', timestamp: '2026-10-01T10:00:00Z', items: [{ code: 'A', qty: 1, price: 50, wholesalePrice: 2000 }] }, { voided: true, items: [{ code: 'B', qty: 1, price: 1, wholesalePrice: 30 }] }];
  const out = SE.suspiciousCosts(inv, sales);
  assert.deepEqual(plain(out.map((x) => x.code).sort()), ['A', 'C']);
  const a = out.find((x) => x.code === 'A');
  assert.ok(a.reasons.some((r) => /above the selling price/.test(r)) && a.reasons.some((r) => /20x/.test(r)) && a.reasons.some((r) => /at a loss/.test(r)));
  assert.ok(out.find((x) => x.code === 'C').reasons.includes('no cost price'));
});

test('Test H - two tills sell the same batch offline: the server counts every sale once, the batches end up adding to the stock, and the over-sold batch is reported', async () => {
  const c = loadSE(); const SE = c.SE;
  const path = await import('node:path'); const { pathToFileURL } = await import('node:url'); const { ROOT } = await import('./helpers.mjs');
  const { applyStockLedger } = await import(pathToFileURL(path.join(ROOT, 'functions/api/_merge.js')).href);
  const base = { code: 'M', name: 'Amox', unit: 'caps', qty: 0, batches: [], _sv: 1 };
  SE.receive(base, { qty: 10, cost: 100, expiry: '2027-01-31', at: 1, id: 'A' });
  SE.receive(base, { qty: 20, cost: 120, expiry: '2027-06-30', at: 2, id: 'B' });
  const stored = JSON.parse(JSON.stringify(base));
  // each till, offline, sells 8 from its own copy (both take them from batch A)
  const till = () => { const p = JSON.parse(JSON.stringify(stored)); const line = {}; SE.stampLine(line, SE.consume(p, 8, { today: '2026-10-27' }), p); return { p, line }; };
  const t1 = till(), t2 = till();
  const now = 2_000_000_000_000;
  const r1 = applyStockLedger({ existingInv: [stored], mergedInv: [t1.p], newMoves: [{ id: 'm1', code: 'M', delta: -8, timestamp: now - 5000 }], laterMoves: () => [], serverNow: now });
  const after1 = r1.inventory[0];
  const r2 = applyStockLedger({ existingInv: [after1], mergedInv: [t2.p], newMoves: [{ id: 'm2', code: 'M', delta: -8, timestamp: now - 4000 }], laterMoves: () => [], serverNow: now + 1 });
  const fin = r2.inventory[0];
  assert.equal(fin.qty, 14, '30 - 8 - 8: both sales counted once each');
  assert.equal(SE.r3(fin.batches.reduce((t, b) => t + b.qty, 0)), 14, 'the batches add up to the stock');
  const over = SE.lotOverAllocation([Object.assign({}, fin, { batches: [...fin.batches, { id: 'A', origQty: 10, qty: 0 }] })], [{ items: [Object.assign({ code: 'M' }, t1.line)] }, { items: [Object.assign({ code: 'M' }, t2.line)] }]);
  assert.equal(over.length, 1, 'batch A gave out 16 of its 10 on paper - listed for a manager');
  assert.deepEqual(JSON.parse(JSON.stringify([over[0].lotId, over[0].held, over[0].sold])), ['A', 10, 16]);
});

test('an authorised "sell this batch first" override is used, but never for an expired or blocked batch; it ends by itself when the batch is gone', () => {
  const { SE } = loadSE();
  const p = { code: 'O', unit: 'pcs', batches: [], qty: 0 };
  const early = SE.receive(p, { qty: 5, expiry: '2027-01-01', at: 1 });
  const late = SE.receive(p, { qty: 5, expiry: '2027-12-01', at: 2 });
  p.lotFirst = { id: late.id, reason: 'damaged outer packs, sell first', by: 'Mary' };
  assert.equal(SE.consume(p, 2, { today: TODAY }).allocs[0].id, late.id);
  late.status = 'quarantine';
  assert.equal(SE.consume(p, 1, { today: TODAY }).allocs[0].id, early.id, 'a blocked batch is never the override');
  late.status = 'ok';
  SE.consume(p, 3, { today: TODAY });
  SE.consume(p, 1, { today: TODAY });
  assert.ok(!p.batches.some((b) => b.id === late.id));
  SE.consume(p, 1, { today: TODAY });
  assert.equal(p.lotFirst, undefined, 'the override ended with its batch');
});
