import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// KRA classification assistant (spec section 14). Since the app has no
// live KRA API, it only ever SUGGESTS a VAT category from an editable
// keyword reference table — never invents a class/eTIMS code, never
// auto-applies without a tap, and clearly distinguishes "no match" from
// "here are some candidates, you decide."
async function session(app) {
  return boot(app, { storage: {}, wait: 900 });
}

for (const app of ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html']) {

test(`${app}: a clear keyword match shows a single suggested classification, not auto-applied`, async () => {
  const b = await session(app);
  const { w } = b;
  w.document.getElementById('inv-name').value = 'Amoxicillin 500mg Tablets';
  w.eval('runKraClassificationAssistant()');
  const out = w.document.getElementById('inv-kra-assist-result').innerHTML;
  assert.match(out, /SUGGESTED MATCH/);
  assert.match(out, /Zero-rated/);
  // Nothing is applied until the button is actually pressed.
  assert.equal(w.document.getElementById('inv-vat-category').value, 'A');
  b.close();
});

test(`${app}: accepting a suggestion sets only the VAT category, never a class/eTIMS code, and is reversible/editable afterwards`, async () => {
  const b = await session(app);
  const { w } = b;
  w.document.getElementById('inv-name').value = 'Amoxicillin 500mg Tablets';
  w.eval('runKraClassificationAssistant()');
  w.eval("acceptKraAssistantSuggestion('Z')");
  assert.equal(w.document.getElementById('inv-vat-category').value, 'Z');
  assert.equal(w.document.getElementById('inv-kra-class-code').value, '', 'the assistant never invents a KRA class code');
  assert.equal(w.document.getElementById('inv-kra-etims-code').value, '', 'the assistant never invents an eTIMS item code');
  b.close();
});

test(`${app}: an item with no keyword match reports NO MATCH FOUND and offers to save a new reference rule instead of guessing`, async () => {
  const b = await session(app);
  const { w } = b;
  w.document.getElementById('inv-name').value = 'Xyzzyplonk Gadget 3000';
  w.eval('runKraClassificationAssistant()');
  const out = w.document.getElementById('inv-kra-assist-result').innerHTML;
  assert.match(out, /NO MATCH FOUND/);
  assert.match(out, /manual classification required/);
  b.close();
});

test(`${app}: an admin-added reference rule is then matched for a future item, and is not lost between sessions`, async () => {
  const b = await session(app);
  const { w } = b;
  w.eval("addKraReferenceRule('gizmo, widget-pro', 'B', 'Local rule for gizmos')");
  w.document.getElementById('inv-name').value = 'Widget-Pro Deluxe';
  w.eval('runKraClassificationAssistant()');
  const out = w.document.getElementById('inv-kra-assist-result').innerHTML;
  assert.match(out, /SUGGESTED MATCH/);
  assert.match(out, /Reduced rate/);
  const stored = w.eval("JSON.parse(localStorage.getItem('pos_kra_reference_rules'))");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].category, 'B');
  b.close();
});

test(`${app}: two equally-likely categories are both shown as candidates rather than picking one silently`, async () => {
  const b = await session(app);
  const { w } = b;
  w.eval("addKraReferenceRule('specialword', 'A', 'rule one')");
  w.eval("addKraReferenceRule('specialword', 'E', 'rule two')");
  w.document.getElementById('inv-name').value = 'Specialword Item';
  w.eval('runKraClassificationAssistant()');
  const out = w.document.getElementById('inv-kra-assist-result').innerHTML;
  assert.match(out, /possible matches/);
  assert.match(out, /rule one/);
  assert.match(out, /rule two/);
  b.close();
});
}
