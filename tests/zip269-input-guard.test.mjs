import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Zip 269 - a box someone is typing in must survive the page redrawing itself around it (a timer, another device's change), and still be
// cleared when a form clears itself after the person pressed Enter / tapped.
const APPS = ['index.html', 'hotel/index.html', 'hospital/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html', 'water/index.html', 'owner/index.html'];
const MARK = '<input type="text" id="ig-q" placeholder="Search"><div id="ig-list">one</div><input type="number" id="ig-n"><textarea id="ig-t"></textarea>';

for (const app of APPS) {
  test(`${app}: a redraw by the page keeps the text, the cursor and the focus; a redraw the person caused still clears`, async () => {
    const b = await boot(app, { wait: 500 }); const { w, d } = b;
    await new Promise((r) => setTimeout(r, 1700));                      // the page's own start-up taps are over (the guard waits 1.5 s after a tap)
    const host = d.createElement('div'); host.id = 'ig-host'; host.innerHTML = MARK; d.body.appendChild(host);
    const q = () => d.getElementById('ig-q');
    // 1. typing, then the page redraws the whole panel by itself (not caused by the person)
    q().focus(); q().value = 'mang'; q().setSelectionRange(2, 3);
    const old = q();
    host.innerHTML = MARK;                                              // what a timer / a sync does
    assert.notEqual(q(), old, 'the page really drew a new box');
    assert.equal(q().value, 'mang', 'what was typed is still there');
    assert.equal(d.activeElement, q(), 'and the cursor is still in the box');
    assert.deepEqual([q().selectionStart, q().selectionEnd], [2, 3], 'at the same place');
    // number box and text area too
    d.getElementById('ig-n').focus(); d.getElementById('ig-n').value = '125';
    host.innerHTML = MARK;
    assert.equal(d.getElementById('ig-n').value, '125'); assert.equal(d.activeElement, d.getElementById('ig-n'));
    d.getElementById('ig-t').focus(); d.getElementById('ig-t').value = 'a note';
    host.innerHTML = MARK;
    assert.equal(d.getElementById('ig-t').value, 'a note'); assert.equal(d.activeElement, d.getElementById('ig-t'));
    // 2. the person presses Enter: the form clears itself (that redraw is wanted)
    q().focus(); q().value = 'saved';
    q().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    host.innerHTML = MARK;
    assert.equal(q().value, '', 'a form still clears after Enter');
    // 3. a tap does the same
    q().focus(); q().value = 'tapped';
    d.body.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    host.innerHTML = MARK;
    assert.equal(q().value, '', 'a form still clears after a tap');
    // 4. a redraw that does not contain the focused box, or a focused button, is a plain redraw
    q().focus(); const list = d.getElementById('ig-list'); list.innerHTML = 'two';
    assert.equal(list.textContent, 'two'); assert.equal(d.activeElement, q());
    b.close();
  });
}

test('hospital: the patient search box keeps what is typed while its tab refreshes', async () => {
  const b = await boot('hospital/index.html', { storage: { pos_patients: JSON.stringify([{ id: 'PT-1', name: 'Mary Wanjiku', age: 30, sex: 'female', phone: '0700000001', registeredAt: Date.now() }]) }, wait: 700 });
  const { w, d } = b;
  w.eval("renderPatientSearchPicker('lab-tab-patient-picker', 'lab-tab-patient-select', 'Search')");
  const q = () => d.getElementById('lab-tab-patient-picker-q');
  q().focus(); q().value = 'Mar'; q().dispatchEvent(new w.Event('input', { bubbles: true }));
  const first = q();
  w.eval('populateLabTabPatientSelect()');                              // the tab refreshing itself
  assert.equal(q(), first, 'the very same box (not rebuilt)'); assert.equal(q().value, 'Mar'); assert.equal(d.activeElement, q());
  q().value = ''; q().blur();
  w.eval('populateLabTabPatientSelect()');
  assert.equal(q().value, '', 'an empty box can be rebuilt as before');
  b.close();
});
