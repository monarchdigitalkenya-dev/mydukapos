import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MONEY: when a cart mixes this branch's items with another branch's, the other branch's share of the payment
// belongs to that branch. The local sale record must scale cash, M-Pesa AND card by the same ratio, otherwise
// a card sale counts the other branch's money in this branch's Daily Sales and X/Z reports.
for (const app of ['index.html', 'hotel/index.html', 'pharmacy/index.html', 'production/index.html', 'services/index.html']) {
  test(`${app}: local sale record scales cardAmount by the cross-branch ratio`, () => {
    const html = readFileSync(new URL(`../${app}`, import.meta.url), 'utf8');
    for (const m of ['cash', 'mpesa', 'card']) {
      assert.ok(
        html.includes(`${m}Amount: Math.round(${m}Amount * (1 - crossBranchRatio) * 100) / 100,`) ||
          html.includes(`${m}Amount: round2(${m}Amount * (1 - crossBranchRatio)),`),
        `${m}Amount must be scaled by (1 - crossBranchRatio)`
      );
    }
  });
}
