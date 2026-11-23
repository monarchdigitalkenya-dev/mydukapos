import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { makeServer, openDevice } from './e2e-harness.mjs';
import { ROOT } from './helpers.mjs';

// Serialized units, variant attributes and the bulk-import ENGINE (pure logic; the screens are still to be built - see docs/HANDOFF.md).
const boot = () => openDevice('index.html', makeServer(), { pos_inventory: '[]' }, 900);
const E = (w, code) => JSON.parse(w.eval(`JSON.stringify(${code})`));

test('serial identifiers: parsing, dual-IMEI = ONE unit, duplicates in batch / already registered / missing are reported by row', async () => {
  const { w } = await boot();
  assert.deepEqual(E(w, "serialParseList('111\\n222|333, 444;\\n\\n555')"), [['111'], ['222', '333'], ['444'], ['555']]);
  assert.equal(E(w, "serialNorm(' 35-4567 89:01/2 ')"), '354567890' + '12');
  const existing = [{ id: 'u0', code: 'P', name: 'Phone', status: 'in_stock', ids: [{ value: '999', norm: '999' }] }];
  const v = E(w, `serialValidateBatch(${JSON.stringify(existing)}, [['111'], ['111'], ['999'], [], ['222','333']], {})`);
  assert.equal(v.ok, false);
  const msgs = v.errors.map((e) => e.row + ':' + e.msg);
  assert.ok(msgs.some((m) => /^2:.*repeats row 1/.test(m)), 'duplicate inside the batch'); assert.ok(msgs.some((m) => /^3:.*already registered/.test(m)), 'already registered'); assert.ok(msgs.some((m) => /^4:Missing/.test(m)), 'missing');
  assert.equal(v.units.length, 2, 'good rows are kept: row 1 and the dual-IMEI row');
  assert.equal(v.units[1].ids.length, 2, 'two IMEIs = one unit');
  assert.equal(E(w, "serialValidateBatch([], [['a'],['b'],['c']], {expected: 2})").ok, false, 'more than expected');
});

test('ten identical phones: one product, ten units, deterministic ids (a retried batch is idempotent), quantity derived from units', async () => {
  const { w } = await boot();
  const rows = Array.from({ length: 10 }, (_, i) => [String(350000000000000 + i)]);
  const v = E(w, `serialValidateBatch([], ${JSON.stringify(rows)}, {expected: 10})`);
  assert.ok(v.ok);
  const mk = () => E(w, `serialMakeUnits(${JSON.stringify(v.units)}, {batchId:'b1', code:'A15', variantId:'v1', name:'Galaxy A15 128GB Black', by:'S', now: 1000})`);
  const a = mk(), b = mk();
  assert.equal(a.length, 10); assert.deepEqual(a.map((u) => u.id), b.map((u) => u.id), 'same batch -> same unit ids');
  assert.ok(a.every((u) => u.status === 'in_stock' && u.history.length === 1));
  const product = { code: 'A15', serialized: true, variants: [{ id: 'v1', serialUnregistered: 0 }] };
  assert.equal(E(w, `serialQtyFor(${JSON.stringify(a)}, ${JSON.stringify(product)}, ${JSON.stringify(product.variants[0])})`), 10);
  assert.equal(E(w, `serialQtyFor(${JSON.stringify(a)}, ${JSON.stringify(product)}, ${JSON.stringify({ id: 'v1', serialUnregistered: 3 })})`), 13, 'legacy unregistered stock is counted but cannot be sold');
  const c = E(w, `serialCounts(${JSON.stringify(a.map((u, i) => i < 2 ? { ...u, status: 'sold' } : i === 2 ? { ...u, status: 'damaged' } : u))}, 'A15', 'v1')`);
  assert.deepEqual([c.total, c.sold, c.damaged, c.available], [10, 2, 1, 7]);
});

test('selling, returning and lifecycle: only in-stock units sell; wrong variant / double pick rejected; a return goes to inspection and cannot be returned twice', async () => {
  const { w } = await boot();
  const mk = (id, st, vid = 'v1') => ({ id, code: 'A15', variantId: vid, name: 'Phone', status: st, ids: [{ value: id, norm: id }], history: [], saleId: null });
  const units = [mk('u1', 'in_stock'), mk('u2', 'sold'), mk('u3', 'in_stock', 'v2'), mk('u4', 'damaged')];
  const chk = (lines) => E(w, `serialCheckSale(${JSON.stringify(units)}, ${JSON.stringify(lines)}, {})`);
  assert.ok(chk([{ code: 'A15', variantId: 'v1', qty: 1, unitIds: ['u1'] }]).ok);
  assert.equal(chk([{ code: 'A15', variantId: 'v1', qty: 2, unitIds: ['u1'] }]).ok, false, 'two sold needs two units');
  assert.equal(chk([{ code: 'A15', variantId: 'v1', qty: 1, unitIds: ['u2'] }]).ok, false, 'already sold');
  assert.equal(chk([{ code: 'A15', variantId: 'v1', qty: 1, unitIds: ['u3'] }]).ok, false, 'other variant');
  assert.equal(chk([{ code: 'A15', variantId: 'v1', qty: 1, unitIds: ['u4'] }]).ok, false, 'damaged');
  assert.equal(chk([{ code: 'A15', variantId: 'v1', qty: 2, unitIds: ['u1', 'u1'] }]).ok, false, 'same unit twice');
  const sold = E(w, `serialTransition(${JSON.stringify(units[0])}, 'sold', {by:'S', ref:'sale1', patch:{saleId:'sale1'}})`);
  assert.ok(sold.ok); assert.equal(sold.unit.history.length, 1); assert.equal(sold.unit.saleId, 'sale1');
  assert.equal(E(w, `serialTransition(${JSON.stringify(sold.unit)}, 'sold', {})`).ok, false, 'cannot be sold twice');
  assert.equal(E(w, `serialReturnUnit(${JSON.stringify(sold.unit)}, {by:'S', reason:' '})`).ok, false, 'reason required');
  const ret = E(w, `serialReturnUnit(${JSON.stringify(sold.unit)}, {by:'S', reason:'Faulty screen', condition:'cracked'})`);
  assert.ok(ret.ok); assert.equal(ret.unit.status, 'awaiting_inspection'); assert.equal(ret.unit.returnedFromSale, 'sale1');
  assert.deepEqual(ret.unit.history.map((h) => h.to), ['sold', 'returned', 'awaiting_inspection']);
  assert.equal(E(w, `serialReturnUnit(${JSON.stringify(ret.unit)}, {by:'S', reason:'again'})`).ok, false, 'no duplicate return');
  assert.equal(E(w, `serialCheckSale([${JSON.stringify(ret.unit)}], [{code:'A15', variantId:'v1', qty:1, unitIds:['u1']}], {})`).ok, false, 'a returned unit is not sellable until inspected');
  assert.ok(E(w, `serialTransition(${JSON.stringify(ret.unit)}, 'in_stock', {})`).ok, 'inspection can clear it');
  assert.equal(E(w, `serialTransition({status:'written_off'}, 'in_stock', {})`).ok, false, 'written off is final');
});

test('variants: combinations generated then de-duplicated by normalised attributes', async () => {
  const { w } = await boot();
  const combos = E(w, "variantGenerate([{name:'Size', values:['S','M']}, {name:'Colour', values:['Black','White']}])");
  assert.equal(combos.length, 4); assert.equal(E(w, "variantLabel({Size:'S', Colour:'Black'})"), 'S / Black');
  const p = { variants: [{ id: 'a', attrs: { Size: 'S', Colour: 'Black' } }] };
  assert.ok(E(w, `variantFindDuplicate(${JSON.stringify(p)}, {colour:'black', size:' s '})`), 'case/space-insensitive duplicate');
  assert.equal(E(w, `variantFindDuplicate(${JSON.stringify(p)}, {Size:'M', Colour:'Black'})`), null);
  assert.equal(E(w, "variantGenerate([])").length, 0);
});

const HDR = ['Parent SKU', 'Variant SKU', 'Model', 'Storage', 'Colour', 'Cost', 'Selling Price', 'Quantity'];
const ROWS = [['SAM-A15', 'SAM-A15-128-BLK', 'A15', '128 GB', 'Black', '12000', '15000', '10'], ['SAM-A15', 'SAM-A15-128-BLU', 'A15', '128 GB', 'Blue', '12000', '15000', '5'], ['SAM-A15', 'SAM-A15-256-BLK', 'A15', '256 GB', 'Black', '15000', '18000', '4']];

test('import variants INTO an existing parent: parent reused, 3 variants created, re-import skips, unmatched/ambiguous parents flagged, nothing guessed', async () => {
  const { w } = await boot();
  const inv = [{ code: 'SAM-A15', name: 'Samsung Galaxy A15', qty: 0, price: 0 }, { code: 'X1', name: 'Twin', qty: 0 }, { code: 'X2', name: 'Twin', qty: 0 }];
  const map = E(w, `importGuessMapping(${JSON.stringify(HDR)})`);
  assert.equal(map.parentSku, 0); assert.equal(map.variantSku, 1); assert.equal(map.cost, 5); assert.equal(map.price, 6); assert.equal(map.quantity, 7);
  const plan = E(w, `importPlan(${JSON.stringify(ROWS)}, ${JSON.stringify(map)}, 'variants', {inventory: ${JSON.stringify(inv)}, units: []})`);
  assert.equal(plan.failed, 0); assert.equal(plan.creatable, 3); assert.equal(plan.rows[0].n, 2, 'row numbers match the spreadsheet');
  const state = { inventory: JSON.parse(JSON.stringify(inv)), units: [] };
  w.eval(`window.__st = ${JSON.stringify(state)}`);
  const res = E(w, `(() => { const r = importApply(${JSON.stringify(plan)}, window.__st, {importId:'imp1', by:'S'}); return { r, inv: window.__st.inventory }; })()`);
  assert.equal(res.inv.length, 3, 'no duplicate parent'); const parent = res.inv[0];
  assert.equal(parent.variants.length, 3); assert.equal(parent.qty, 19); assert.equal(parent.hasVariants, true);
  assert.equal(parent.variants[2].attrs.Storage, '256 GB'); assert.equal(res.r.created, 3); assert.equal(res.r.movements.length, 3);
  // importing the same variants again (policy skip): nothing changes
  const plan2 = E(w, `importPlan(${JSON.stringify(ROWS)}, ${JSON.stringify(map)}, 'variants', {inventory: window.__st.inventory, units: [], policy:'skip'})`);
  assert.equal(plan2.skipped, 3); assert.equal(plan2.creatable, 0);
  // update policy updates prices but NEVER stock
  const plan3 = E(w, `importPlan(${JSON.stringify(ROWS.map((r) => { const c = r.slice(); c[6] = '16000'; c[7] = '99'; return c; }))}, ${JSON.stringify(map)}, 'variants', {inventory: window.__st.inventory, units: [], policy:'update_info'})`);
  w.eval(`importApply(${JSON.stringify(plan3)}, window.__st, {importId:'imp2'})`);
  assert.equal(w.eval('window.__st.inventory[0].variants[0].price'), 16000); assert.equal(w.eval('window.__st.inventory[0].variants[0].qty'), 10, 'quantity untouched by an update');
  // parent problems
  const bad = E(w, `importPlan([['NOPE','V1','A','','','','','1'], ['Twin','V2','A','','','','','1']], ${JSON.stringify(map)}, 'variants', {inventory: ${JSON.stringify(inv)}, units: []})`);
  assert.match(bad.rows[0].errors[0], /not found/); assert.match(bad.rows[1].errors[0], /ambiguous|matches 2/); assert.equal(bad.failed, 2);
  // a plain parent that already has stock is not guessed into variants
  const plain = E(w, `importPlan([['P','PV','A','','','','','1']], ${JSON.stringify(map)}, 'variants', {inventory: [{code:'P', name:'Plain', qty: 7}], units: []})`);
  assert.match(plain.rows[0].errors[0], /plain item with 7 in stock/);
});

test('import quantity semantics: opening never overwrites, add is applied once (row keys), serialized stock needs identifiers; serial file registers units and rejects duplicates / missing', async () => {
  const { w } = await boot();
  const inv = [{ code: 'S1', name: 'Soda', qty: 20 }, { code: 'S2', name: 'Fresh', qty: 0 }, { code: 'PH', name: 'Phone', qty: 0, serialized: true }, { code: 'PL', name: 'Plain', qty: 0 }];
  const hdr = ['SKU', 'Quantity'], map = E(w, `importGuessMapping(${JSON.stringify(hdr)})`);
  const open = E(w, `importPlan([['S1','10'],['S2','10']], ${JSON.stringify(map)}, 'stock', {inventory: ${JSON.stringify(inv)}, units: [], mode:'opening'})`);
  assert.match(open.rows[0].errors[0], /Opening stock refused: already has 20/); assert.equal(open.rows[1].op, 'stock_open');
  const add = E(w, `importPlan([['S1','10']], ${JSON.stringify(map)}, 'stock', {inventory: ${JSON.stringify(inv)}, units: [], mode:'add'})`);
  w.eval(`window.__s2 = ${JSON.stringify({ inventory: inv, units: [] })}`);
  const r1 = E(w, `importApply(${JSON.stringify(add)}, window.__s2, {importId:'i1'})`);
  assert.equal(w.eval('window.__s2.inventory[0].qty'), 30, 'added to 20, not replaced');
  const r2 = E(w, `importApply(${JSON.stringify(add)}, window.__s2, {importId:'i1', doneKeys: ${JSON.stringify(r1.rowKeys)}})`);
  assert.equal(w.eval('window.__s2.inventory[0].qty'), 30, 'a repeated import does not add twice'); assert.equal(r2.skipped, 1);
  const serQty = E(w, `importPlan([['PH','10']], ${JSON.stringify(map)}, 'stock', {inventory: ${JSON.stringify(inv)}, units: [], mode:'add'})`);
  assert.match(serQty.rows[0].errors[0], /Serialized item/);
  // serial file: 10 units with IMEIs
  const shdr = ['SKU', 'IMEI'], smap = E(w, `importGuessMapping(${JSON.stringify(shdr)})`);
  const rows = Array.from({ length: 10 }, (_, i) => ['PH', String(860000000000000 + i)]);
  const sp = E(w, `importPlan(${JSON.stringify(rows)}, ${JSON.stringify(smap)}, 'serials', {inventory: ${JSON.stringify(inv)}, units: []})`);
  assert.equal(sp.failed, 0); assert.equal(sp.creatable, 10);
  w.eval(`window.__s3 = ${JSON.stringify({ inventory: JSON.parse(JSON.stringify(inv)), units: [] })}`);
  const ap = E(w, `importApply(${JSON.stringify(sp)}, window.__s3, {importId:'i9', by:'S'})`);
  assert.equal(ap.unitsCreated, 10); assert.equal(w.eval('window.__s3.units.length'), 10); assert.equal(w.eval('window.__s3.inventory[2].qty'), 10);
  assert.ok(E(w, 'window.__s3.units').every((u) => u.status === 'in_stock'));
  // same IMEIs again -> rejected row by row; a missing identifier; a product that is not serialized
  const dup = E(w, `importPlan(${JSON.stringify([rows[0], ['PH', ''], ['PL', 'ZZZ1']])}, ${JSON.stringify(smap)}, 'serials', {inventory: window.__s3.inventory, units: window.__s3.units})`);
  assert.match(dup.rows[0].errors[0], /already registered/); assert.match(dup.rows[1].errors[0], /Missing identifier/); assert.match(dup.rows[2].errors.join(' '), /not set to track/);
  assert.equal(dup.failed, 3);
  // converting existing stock: 3 legacy units, register 2 -> qty unchanged, 1 still unregistered
  w.eval(`window.__s4 = ${JSON.stringify({ inventory: [{ code: 'PH', name: 'Phone', qty: 3, serialized: true, serialUnregistered: 3 }], units: [] })}`);
  const cp = E(w, `importPlan([['PH','A1'],['PH','A2']], ${JSON.stringify(smap)}, 'serials', {inventory: window.__s4.inventory, units: []})`);
  w.eval(`importApply(${JSON.stringify(cp)}, window.__s4, {importId:'i4'})`);
  assert.equal(w.eval('window.__s4.inventory[0].qty'), 3); assert.equal(w.eval('window.__s4.inventory[0].serialUnregistered'), 1);
});

test('server merge of serial units: a stale copy cannot make a sold unit available; the same unit sold on two devices is flagged', async () => {
  const m = await import(pathToFileURL(path.join(ROOT, 'functions/api/_merge.js')).href);
  const base = { id: 'su1', status: 'in_stock', updatedAt: 1, history: [{ id: 'h0', at: 1, to: 'in_stock' }] };
  const a = { ...base, status: 'sold', updatedAt: 5, history: [...base.history, { id: 'h1', at: 5, to: 'sold', ref: 'saleA' }] };
  const b = { ...base, status: 'sold', updatedAt: 6, history: [...base.history, { id: 'h2', at: 6, to: 'sold', ref: 'saleB' }] };
  const stale = m.mergeNestedRecord('serialUnits', a, { ...base, updatedAt: 99 });
  assert.equal(stale.status, 'sold'); assert.ok(!stale.conflict);
  const both = m.mergeNestedRecord('serialUnits', a, b);
  assert.equal(both.history.length, 3); assert.equal(both.conflict.kind, 'double-sale'); assert.deepEqual(both.conflict.saleIds.sort(), ['saleA', 'saleB']);
});
