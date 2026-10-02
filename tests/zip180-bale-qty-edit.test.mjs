// zip 180: a bale's quantity can be edited directly in the AquaPOS inventory (tracked, linked and plain bales)
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

test('editing a bale quantity adjusts the real stock source', async () => {
  const { w, close } = await boot('water/index.html', { wait: 800 });
  try {
    const r = w.eval(`(function(){
      products.push({code:'BT',name:'Bottle',category:'bottled',price:20,qty:48,vatCategory:'A'});
      products.push({code:'BL',name:'Linked bale',category:'bale',price:400,qty:2,linkedBottleCode:'BT',bottlesPerBale:24,trackBottles:false,vatCategory:'A'});
      products.push({code:'BK',name:'Tracked bale',category:'bale',price:400,qty:1,trackBottles:true,bottleStock:24,bottlesPerBale:24,vatCategory:'A'});
      products.push({code:'BP',name:'Plain bale',category:'bale',price:400,qty:3,vatCategory:'A'});
      updateProductField('BL','qty','5'); updateProductField('BK','qty','3.5'); updateProductField('BP','qty','7');
      const g=c=>products.find(p=>p.code===c);
      const html=document.querySelector('#products-table tbody').innerHTML;
      return {bottle:g('BT').qty, linked:effectiveBaleQty(g('BL')), tracked:g('BK').qty, trackedBottles:g('BK').bottleStock, plain:g('BP').qty, disabledQty:/disabled title="Derived/.test(html)};
    })()`);
    assert.equal(r.bottle, 120);          // 5 bales x 24
    assert.equal(r.linked, 5);
    assert.equal(r.tracked, 3.5);
    assert.equal(r.trackedBottles, 84);   // 3.5 x 24
    assert.equal(r.plain, 7);
    assert.equal(r.disabledQty, false);
  } finally { close(); }
});
