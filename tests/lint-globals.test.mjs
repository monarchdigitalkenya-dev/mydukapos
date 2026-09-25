import test from 'node:test';
import assert from 'node:assert/strict';
import { lintApp, lintHandlers } from '../tools/lint-globals.mjs';

// A name that is used on a page but declared nowhere on it (or a button that calls a function that does not exist) is a ReferenceError waiting
// for the day someone taps it — like "inventory is not defined" in Aqua POS. Catch them before they are deployed.
const APPS = ['index.html', 'water/index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html', 'owner/index.html'];
for (const app of APPS) {
  test(`${app}: no name is used without being declared, and every onclick/onchange calls a function that exists`, () => {
    const names = [...lintApp(app)].map(([n, lines]) => `${n} (line ${lines[0]})`);
    assert.deepEqual(names, [], 'used but never declared');
    const handlers = [...lintHandlers(app)].map(([n, lines]) => `${n}() (line ${lines[0]})`);
    assert.deepEqual(handlers, [], 'inline handlers calling a missing function');
  });
}
