// functions/api/_demo-seeds.js — zip 262
// The sample data for the SHARED public demos (see _shared-demos.js). Everything here is PURE: given `now` it returns the patch the app stores
// (same keys the app pushes in collectSyncPayload), with every date RELATIVE to `now` so the demo never looks stale. Nothing is random per
// visit: a fixed seed means the same shop every time, so two visitors see the same thing and a re-seed produces the same records (same ids).
// Pictures are never embedded: `image` is a short path to a shared, cached SVG (/demo-img/<name>.svg), so no base64 ever lands in a database.

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r2 = (n) => Math.round(n * 100) / 100;
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const pad = (n, w) => String(n).padStart(w, '0');
const PEOPLE = ['Wanjiku Kamau', 'Otieno Odhiambo', 'Amina Hassan', 'Kiprono Rotich', 'Mercy Achieng', 'Brian Mutua', 'Faith Wairimu', 'Hassan Abdi', 'Grace Njeri', 'Peter Kariuki', 'Lucy Akinyi', 'Samuel Kipchoge', 'Esther Moraa', 'Daniel Mwangi', 'Zawadi Mwende', 'Joseph Ouma', 'Naomi Chebet', 'Collins Kiplagat', 'Halima Yusuf', 'Dennis Njoroge', 'Rose Wangari', 'Victor Ochieng', 'Beatrice Atieno', 'Moses Kimani'];
const phone = (i) => '07' + (10 + (i * 7) % 90) + pad(100000 + i * 3719 % 899999, 6).slice(0, 6);
const img = (n) => '/demo-img/' + n + '.svg';

// ---- generic item/sales helpers (shop-shaped apps) ----
function item(code, name, category, price, cost, qty, unit, image, extra) {
  return { code, type: 'product', name, category, price, wholesalePrice: cost, qty, unit: unit || 'pcs', vatCategory: 'A', image: img(image || 'box'), barcode: code, ...(extra || {}) };
}
function buildSales(R, now, inventory, opts) {
  const days = opts.days || 30, perDay = opts.perDay || 5, staff = opts.staff || ['Admin'];
  const out = []; let seq = 1000;
  for (let d = days; d >= 0; d--) {
    const n = Math.max(1, Math.round(perDay * (0.6 + R() * 0.9)));
    for (let k = 0; k < n; k++) {
      const t = now - d * DAY - Math.floor(R() * 10 * 3600000) - 3600000;
      if (t > now) continue;
      const lines = []; const nl = 1 + Math.floor(R() * 3);
      for (let j = 0; j < nl; j++) {
        const p = inventory[Math.floor(R() * inventory.length)];
        const dec = ['kg', 'g', 'm', 'l', 'ft'].includes(p.unit);
        const q = dec ? r2(0.5 + Math.floor(R() * 8) * 0.5) : 1 + Math.floor(R() * 3);
        if (lines.some((l) => l.code === p.code)) continue;
        lines.push({ code: p.code, name: p.name, qty: q, price: p.price, wholesalePrice: p.wholesalePrice, unit: p.unit, vatCategory: 'A' });
      }
      if (!lines.length) continue;
      const total = r2(lines.reduce((s, l) => s + l.price * l.qty, 0));
      const m = R(); const method = m < 0.5 ? 'cash' : m < 0.9 ? 'mpesa' : 'card';
      const ci = Math.floor(R() * PEOPLE.length); const named = R() < 0.3;
      out.push({ id: 'ds' + pad(seq, 6), refNumber: 'R-' + pad(seq, 6), timestamp: iso(t), paid: true, paymentMethod: method, cashAmount: method === 'cash' ? total : 0, mpesaAmount: method === 'mpesa' ? total : 0, cardAmount: method === 'card' ? total : 0, amountTendered: method === 'cash' ? total : 0, change: 0, servedBy: staff[Math.floor(R() * staff.length)], customerName: named ? PEOPLE[ci] : '', customerPhone: named ? phone(ci) : '', items: lines });
      seq++;
    }
  }
  return out;
}
function buildCustomersAndDebts(R, now, count, sales) {
  const customers = []; for (let i = 0; i < count; i++) customers.push({ id: 'dc' + pad(i + 1, 3), name: PEOPLE[i % PEOPLE.length], phone: phone(i), tokens: Math.floor(R() * 120), createdAt: now - (60 - i) * DAY });
  const debts = [], bills = [];
  [[2, 4200, 14], [5, 1850, 6], [9, 760, 3]].forEach(([ci, amt, ago], i) => { const c = customers[ci % customers.length]; debts.push({ id: 'dd' + (i + 1), customerName: c.name, phone: c.phone, amount: amt, notes: 'Goods on credit', createdAt: iso(now - ago * DAY), source: 'manual', payments: i === 0 ? [{ id: 'dp1', amount: 1000, method: 'cash', timestamp: iso(now - 5 * DAY) }] : [] }); });
  const c = customers[1]; const items = [{ code: 'MANUAL', name: 'Account purchase', qty: 1, price: 6400, unit: 'pcs', wholesalePrice: 0, isService: false, vatCategory: 'A' }];
  bills.push({ id: 'db1', refNumber: 'B-000001', timestamp: iso(now - 9 * DAY), paid: false, servedBy: 'Admin', customerName: c.name, customerPhone: c.phone, items, amountPaid: 2000, dueDate: ymd(now + 5 * DAY), fulfillmentType: 'carried_immediately', fulfillmentStatus: 'fulfilled', inventoryDeducted: true, paymentHistory: [{ id: 'dbp1', timestamp: iso(now - 7 * DAY), amount: 2000, method: 'mpesa', reference: 'DEMO7K2P9Q', balanceAfter: 4400 }], manual: true });
  return { customers, debts, bills };
}
function buildExpenses(now) {
  return [['Rent', 'Shop rent', 45000, 25], ['Utilities', 'Electricity tokens', 6200, 18], ['Transport', 'Delivery fuel', 3100, 11], ['Salaries', 'Casual labour', 9800, 7], ['Restock', 'Weekly supplier order', 28500, 4]].map(([category, description, amount, ago], i) => ({ id: 'de' + (i + 1), timestamp: iso(now - ago * DAY), category, description, amount }));
}
function stockMoves(now, inventory) { return inventory.slice(0, 12).map((p, i) => ({ id: 'dm' + (i + 1), timestamp: iso(now - (i + 2) * DAY), code: p.code, name: p.name, delta: 20 + i * 2, type: 'added', note: 'Opening stock / supplier delivery' })); }
function shopBase(R, now, name, inventory, o) {
  const sales = buildSales(R, now, inventory, { days: 30, perDay: o.perDay || 5 });
  const cd = buildCustomersAndDebts(R, now, 14);
  return {
    businessName: name, ownerName: 'Owner', inventory, salesLog: sales, customers: cd.customers, debts: cd.debts, bills: cd.bills, expenses: buildExpenses(now),
    stockMovementLog: stockMoves(now, inventory), suppliers: (o.suppliers || ['Prime Wholesalers', 'Kenya Distributors', 'Sunrise Supplies']).map((n, i) => ({ id: 'sup-d' + (i + 1), name: n, phone: phone(40 + i) })),
    returns: [], lowStockThreshold: 5, loyaltyEnabled: true, tokenValueKES: 1, nextReceiptRefSeq: 1000 + sales.length + 1,
    phoneTill: { cols: 3 }, catTilesOn: true,   // zip 263: three photos per row and category tiles by default in every sample shop
  };
}

// ======================= RETAIL =======================
function retail(now) {
  const R = rng(262001);
  const I = [
    ['Food and Groceries', 'Unga Maize Flour 2kg', 'maize', 210, 175, 80, 'pcs'], ['Food and Groceries', 'Rice Pishori 1kg', 'rice', 260, 215, 60, 'kg'], ['Food and Groceries', 'Cooking Oil 1L', 'oil', 330, 285, 45, 'l'], ['Food and Groceries', 'Sugar 1kg', 'sugar', 190, 160, 70, 'kg'], ['Food and Groceries', 'Wheat Flour 2kg', 'flour', 245, 205, 50, 'pcs'], ['Food and Groceries', 'Tomatoes (loose)', 'veg', 120, 80, 25.5, 'kg'],
    ['Household Items', 'Plastic Basin 20L', 'basin', 450, 340, 18, 'pcs'], ['Household Items', 'Mosquito Coil (pack)', 'coil', 90, 65, 40, 'pcs'], ['Household Items', 'Charcoal 2kg', 'charcoal', 150, 110, 35, 'pcs'], ['Household Items', 'Candles (pack of 6)', 'candle', 120, 85, 30, 'pcs'],
    ['Personal Care', 'Bathing Soap 175g', 'soap', 85, 62, 90, 'pcs'], ['Personal Care', 'Toothpaste 100ml', 'paste', 180, 135, 50, 'pcs'], ['Personal Care', 'Body Lotion 400ml', 'lotion', 420, 320, 22, 'pcs'], ['Personal Care', 'Sanitary Pads (pack)', 'pads', 130, 95, 44, 'pcs'],
    ['Cleaning Products', 'Laundry Detergent 1kg', 'detergent', 290, 230, 38, 'pcs'], ['Cleaning Products', 'Bleach 750ml', 'bleach', 160, 120, 28, 'pcs'], ['Cleaning Products', 'Dish Soap 500ml', 'dish', 140, 105, 33, 'pcs'],
    ['Snacks', 'Biscuits Assorted', 'biscuit', 60, 44, 120, 'pcs'], ['Snacks', 'Potato Crisps 50g', 'crisps', 50, 36, 100, 'pcs'], ['Snacks', 'Peanuts 100g', 'nuts', 70, 50, 60, 'pcs'],
    ['Beverages', 'Soda 500ml', 'soda', 70, 52, 150, 'pcs'], ['Beverages', 'Fresh Milk 500ml', 'milk', 65, 52, 80, 'pcs'], ['Beverages', 'Tea Leaves 250g', 'tea', 135, 105, 55, 'pcs'], ['Beverages', 'Bottled Water 1L', 'water', 60, 40, 140, 'pcs'],
    ['Stationery', 'Exercise Book 96pg', 'book', 55, 38, 90, 'pcs'], ['Stationery', 'Ballpoint Pen (blue)', 'pen', 20, 12, 200, 'pcs'],
    ['Baby Products', 'Baby Diapers (pack of 20)', 'diaper', 780, 640, 15, 'pcs'], ['Baby Products', 'Baby Wipes (pack)', 'wipes', 240, 180, 26, 'pcs'], ['Other', 'Phone Airtime Voucher 100', 'airtime', 100, 94, 60, 'pcs'], ['Other', 'Batteries AA (pair)', 'battery', 80, 56, 48, 'pcs'],
  ].map((a, i) => item(pad(100 + i, 5), a[1], a[0], a[3], a[4], a[5], a[6], a[2]));
  I[0].qty = 4;      // low stock so the low-stock alert shows
  return shopBase(R, now, 'Retail Shop', I, { perDay: 6 });
}

// ======================= HARDWARE (units: pcs, bag, kg, g, m, ft, l) =======================
function hardware(now) {
  const R = rng(262002);
  const H = [
    ['Cement', 'Portland', 'Cement 50kg (Bag)', 'cement', 780, 700, 120, 'pcs'], ['Cement', 'Portland', 'White Cement 5kg', 'cement', 540, 460, 24, 'pcs'],
    ['Steel and Reinforcement', 'Deformed bars', 'Y12 Reinforcement Bar 12m', 'steel', 1280, 1130, 85, 'pcs'], ['Steel and Reinforcement', 'Wire', 'Binding Wire', 'wire', 210, 160, 40.5, 'kg'], ['Steel and Reinforcement', 'Mesh', 'Weld Mesh A142', 'mesh', 5200, 4600, 14, 'pcs'],
    ['Plumbing', 'PVC pipes', 'PVC Pipe 1/2" (3m)', 'pipe', 380, 300, 60, 'pcs'], ['Plumbing', 'Fittings', 'Elbow 1/2"', 'fitting', 35, 22, 200, 'pcs'], ['Plumbing', 'Taps', 'Bib Tap Chrome', 'tap', 450, 340, 26, 'pcs'],
    ['Electrical Supplies', 'Cable', 'Twin & Earth Cable 2.5mm', 'cable', 95, 70, 300, 'm'], ['Electrical Supplies', 'Switches', '1-Gang Switch', 'switch', 180, 125, 70, 'pcs'], ['Electrical Supplies', 'Lighting', 'LED Bulb 9W', 'bulb', 150, 100, 110, 'pcs'],
    ['Paints and Accessories', 'Emulsion', 'Emulsion Paint White', 'paint', 640, 520, 90, 'l'], ['Paints and Accessories', 'Brushes', 'Paint Brush 4"', 'brush', 220, 150, 40, 'pcs'], ['Paints and Accessories', 'Thinners', 'Paint Thinner', 'thinner', 290, 230, 35, 'l'],
    ['Timber', 'Cypress', 'Timber 2x2 (ft)', 'timber', 55, 38, 600, 'ft'], ['Timber', 'Plywood', 'Plywood 8x4 18mm', 'ply', 3300, 2850, 22, 'pcs'],
    ['Roofing', 'Iron sheets', 'Iron Sheet Gauge 30 (3m)', 'roof', 1150, 980, 75, 'pcs'], ['Roofing', 'Accessories', 'Roofing Nails (kg)', 'nails', 260, 200, 35.5, 'kg'],
    ['Nails and Fasteners', 'Nails', 'Nails 3" (kg)', 'nails', 230, 175, 80, 'kg'], ['Nails and Fasteners', 'Nails', 'Nails 2" (g)', 'nails', 0.25, 0.18, 8000, 'g'], ['Nails and Fasteners', 'Screws', 'Wood Screw 1.5"', 'screw', 3, 1.8, 2500, 'pcs'], ['Nails and Fasteners', 'Bolts', 'Bolt & Nut M10', 'bolt', 28, 18, 400, 'pcs'],
    ['Hand Tools', 'Hammers', 'Claw Hammer 16oz', 'hammer', 650, 480, 30, 'pcs'], ['Hand Tools', 'Saws', 'Hand Saw 22"', 'saw', 780, 580, 18, 'pcs'], ['Hand Tools', 'Measuring', 'Measuring Tape 5m', 'tape', 350, 240, 36, 'pcs'],
    ['Power Tools', 'Drills', 'Cordless Drill 18V', 'drill', 7800, 6400, 8, 'pcs'], ['Power Tools', 'Grinders', 'Angle Grinder 115mm', 'grinder', 5200, 4300, 10, 'pcs'],
    ['Building Finishes', 'Tiles', 'Floor Tile 60x60', 'tile', 1450, 1180, 45, 'pcs'], ['Building Finishes', 'Adhesive', 'Tile Adhesive 20kg', 'adhesive', 980, 820, 32, 'pcs'],
    ['General Hardware', 'Locks', 'Padlock 50mm', 'lock', 420, 300, 40, 'pcs'], ['General Hardware', 'Hinges', 'Door Hinge 4"', 'hinge', 120, 80, 150, 'pcs'], ['General Hardware', 'Wheelbarrows', 'Wheelbarrow', 'barrow', 4800, 3900, 9, 'pcs'],
  ].map((a, i) => item(pad(200 + i, 5), a[2], a[0], a[4], a[5], a[6], a[7], a[3], { subcategory: a[1] }));
  const g = H.find((p) => p.name.indexOf('2" (g)') > -1); if (g) g.price = 0.3;   // priced per gram so the g unit demonstrates fractions
  return shopBase(R, now, 'Hardware Store', H, { perDay: 4, suppliers: ['Bamburi Depot', 'Mabati Rolling Mills', 'Crown Paints Dist.'] });
}

// zip 263: a SHOT is a made-from-ingredients item (type 'service' + recipe): every shot sold takes its share of the bottle from stock (25 ml of a 750 ml
// bottle = 1/30, a double 1/15), the same way a dish takes its ingredients. specs: [bottle name, single price, spirit group].
function shotItems(inv, specs, cat, firstCode) {
  return specs.flatMap(([name, price, group], i) => {
    const b = inv.find((p) => p.name === name);
    const mk = (suffix, ml, pr, k) => ({ code: pad(firstCode + i * 2 + k, 5), type: 'service', name: name.replace(/ 750ml$/, '') + ' ' + suffix, category: cat, subcategory: group, price: pr, wholesalePrice: 0, qty: 0, unit: 'pcs', vatCategory: 'A', image: b.image, barcode: pad(firstCode + i * 2 + k, 5), recipe: [{ code: b.code, qtyPerUnit: +(ml / 750).toFixed(6) }] });
    return [mk('Shot (25ml)', 25, price, 0), mk('Double (50ml)', 50, price * 2 - 20, 1)];
  });
}

// ======================= LIQUOR (category › subcategory) =======================
function liquor(now) {
  const R = rng(262003);
  const L = [
    ['Brandy', 'VSOP', 'Brandy VSOP 750ml', 'brandy', 2400, 1900, 18, 'pcs'], ['Brandy', 'VS', 'Brandy VS 350ml', 'brandy', 950, 740, 30, 'pcs'],
    ['Whisky', 'Scotch', 'Scotch 12yr 750ml', 'whisky', 4200, 3500, 12, 'pcs'], ['Whisky', 'Blended', 'Blended Whisky 750ml', 'whisky', 2100, 1700, 24, 'pcs'],
    ['Vodka', 'Plain', 'Vodka 750ml', 'vodka', 1500, 1200, 28, 'pcs'], ['Vodka', 'Flavoured', 'Vodka Citrus 750ml', 'vodka', 1650, 1300, 14, 'pcs'],
    ['Gin', 'London Dry', 'Gin 750ml', 'gin', 1800, 1450, 20, 'pcs'], ['Rum', 'Dark', 'Dark Rum 750ml', 'rum', 1700, 1350, 16, 'pcs'], ['Tequila', 'Silver', 'Tequila Silver 750ml', 'tequila', 3200, 2600, 9, 'pcs'],
    ['Wines', 'Red', 'Red Wine 750ml', 'wine', 1300, 980, 26, 'pcs'], ['Wines', 'White', 'White Wine 750ml', 'wine', 1250, 950, 22, 'pcs'], ['Wines', 'Sparkling', 'Sparkling 750ml', 'wine', 2800, 2200, 10, 'pcs'],
    ['Beer', 'Lager Bottle', 'Lager 500ml', 'beer', 230, 180, 240, 'pcs'], ['Beer', 'Lager Can', 'Lager Can 500ml', 'beer', 220, 175, 192, 'pcs'], ['Beer', 'Crate', 'Lager Crate (24)', 'crate', 4900, 4200, 14, 'pcs'], ['Beer', 'Stout', 'Stout 500ml', 'beer', 250, 195, 96, 'pcs'],
    ['Cider', 'Apple', 'Apple Cider 330ml', 'cider', 260, 200, 72, 'pcs'], ['Ready-to-Drink', 'Spirit mixers', 'Vodka Lemon RTD', 'rtd', 280, 215, 60, 'pcs'],
    ['Non-alcoholic Beverages', 'Soft drinks', 'Cola 500ml', 'soda', 70, 52, 200, 'pcs'], ['Non-alcoholic Beverages', 'Water', 'Water 1L', 'water', 60, 40, 150, 'pcs'], ['Non-alcoholic Beverages', 'Juice', 'Juice 1L', 'juice', 190, 145, 48, 'pcs'],
    ['Mixers', 'Tonic', 'Tonic Water 300ml', 'mixer', 110, 78, 90, 'pcs'], ['Mixers', 'Soda water', 'Soda Water 300ml', 'mixer', 100, 70, 90, 'pcs'], ['Mixers', 'Ginger ale', 'Ginger Ale 300ml', 'mixer', 120, 85, 60, 'pcs'],
  ].map((a, i) => item(pad(300 + i, 5), a[2], a[0], a[4], a[5], a[6], a[7], a[3], { subcategory: a[1], category: a[0] }));
  const base = shopBase(R, now, 'Liquor Store', L, { perDay: 8, suppliers: ['Prime Spirits Ltd', 'Highland Brewers', 'Cape Wine Merchants'] });
  L.push(...shotItems(L, [['Scotch 12yr 750ml', 250, 'Whisky'], ['Blended Whisky 750ml', 130, 'Whisky'], ['Brandy VSOP 750ml', 150, 'Brandy'], ['Vodka 750ml', 100, 'Vodka'], ['Gin 750ml', 120, 'Gin'], ['Dark Rum 750ml', 110, 'Rum'], ['Tequila Silver 750ml', 200, 'Tequila']], 'Shots', 350));   // after the sales history is built: shots are not in it
  return base;
}

// ======================= HOTEL / RESTAURANT =======================
function hotel(now) {
  const R = rng(262004);
  const M = [
    ['Mains', 'Grilled Tilapia', 'fish', 950, 520, 40], ['Mains', 'Chicken Stew + Ugali', 'stew', 650, 340, 60], ['Mains', 'Beef Pilau', 'pilau', 600, 310, 70], ['Mains', 'Nyama Choma 1/2kg', 'meat', 1100, 640, 35], ['Mains', 'Vegetable Curry', 'curry', 520, 250, 30],
    ['Starters', 'Samosa (2)', 'samosa', 150, 70, 100], ['Starters', 'Soup of the Day', 'soup', 250, 110, 50], ['Sides', 'Chips', 'chips', 250, 110, 80], ['Sides', 'Kachumbari', 'salad', 120, 45, 60],
    ['Drinks', 'Fresh Juice', 'juice', 220, 90, 60], ['Drinks', 'Coffee', 'coffee', 180, 55, 90], ['Drinks', 'Soda 330ml', 'soda', 100, 55, 120], ['Drinks', 'Bottled Water', 'water', 80, 40, 100], ['Bar', 'Lager 500ml', 'beer', 300, 210, 120], ['Bar', 'House Wine Glass', 'wine', 450, 220, 40], ['Desserts', 'Fruit Platter', 'fruit', 350, 160, 25],
    ['Room Services', 'Laundry (per item)', 'laundry', 100, 30, 500, 'pcs'],
  ].map((a, i) => item(pad(400 + i, 5), a[1], a[0], a[3], a[4], a[5], a[6] || 'pcs', a[2]));
  const base = shopBase(R, now, 'Hotel & Restaurant', M, { perDay: 9 });
  const spirits = [['Scotch 12yr 750ml', 'whisky', 5200, 3500, 12, 'Whisky'], ['Vodka 750ml', 'vodka', 2400, 1200, 18, 'Vodka'], ['Gin 750ml', 'gin', 2600, 1450, 14, 'Gin'], ['Dark Rum 750ml', 'rum', 2500, 1350, 10, 'Rum'], ['Brandy VSOP 750ml', 'brandy', 3300, 1900, 12, 'Brandy']]
    .map((a, i) => item(pad(480 + i, 5), a[0], 'Bar Stock', a[2], a[3], a[4], 'pcs', a[1], { subcategory: a[5] }));
  base.inventory.push(...spirits, ...shotItems(spirits, [['Scotch 12yr 750ml', 250, 'Whisky'], ['Vodka 750ml', 100, 'Vodka'], ['Gin 750ml', 120, 'Gin'], ['Dark Rum 750ml', 110, 'Rum'], ['Brandy VSOP 750ml', 150, 'Brandy']], 'Shots', 490));   // the bar: bottles + shots
  const rooms = ['Room 101', 'Room 102', 'Room 103', 'Room 201', 'Room 202', 'Room 203', 'Suite 301'];
  const tables = ['Table 1', 'Table 2', 'Table 3', 'Table 4', 'Table 5', 'Table 6', 'Patio 1', 'Patio 2'];
  const stay = (name, p, ago, nights, rate, dep, i) => ({ guestName: name, guestPhone: p, guestId: String(23000000 + i * 777), numGuests: 1 + (i % 3), checkInAt: iso(now - ago * DAY), checkOutDue: ymd(now + (nights - ago) * DAY), nightlyRate: rate, depositAmount: dep, creditLimit: null, tabId: null });
  const roomStays = { 'Room 102': stay(PEOPLE[3], phone(3), 1, 3, 4500, 2000, 1), 'Room 201': stay(PEOPLE[8], phone(8), 2, 5, 5200, 3000, 2), 'Suite 301': stay(PEOPLE[11], phone(11), 0, 2, 9800, 5000, 3) };
  const roomStates = {}; rooms.forEach((r) => { roomStates[r] = roomStays[r] ? { status: 'occupied' } : { status: r === 'Room 203' ? 'cleaning' : 'available' }; });
  const tableStates = {}; tables.forEach((t, i) => { tableStates[t] = { status: i === 1 || i === 4 ? 'occupied' : 'available' }; });
  return { ...base, rooms, tables, roomStays, roomStates, tableStates };
}

// ======================= PHARMACY =======================
function pharmacy(now) {
  const R = rng(262005);
  const D = [
    ['Analgesics', 'Paracetamol 500mg (strip)', 'pill', 40, 24, 400, 365], ['Analgesics', 'Ibuprofen 400mg (strip)', 'pill', 60, 35, 260, 300], ['Antibiotics', 'Amoxicillin 500mg (10 caps)', 'caps', 180, 110, 120, 220], ['Antibiotics', 'Azithromycin 500mg (3 tabs)', 'caps', 320, 210, 45, 90], ['Antibiotics', 'Ciprofloxacin 500mg (10)', 'caps', 240, 150, 6, 40],
    ['Antimalarials', 'Artemether/Lumefantrine (6x4)', 'pill', 350, 240, 80, 400], ['Antihistamines', 'Cetirizine 10mg (10)', 'pill', 90, 50, 140, 500], ['Gastrointestinal', 'ORS Sachet', 'sachet', 35, 20, 150, 700], ['Gastrointestinal', 'Omeprazole 20mg (14)', 'caps', 210, 130, 70, 250],
    ['Cough & Cold', 'Cough Syrup 100ml', 'syrup', 280, 190, 55, 28], ['Vitamins', 'Vitamin C 1000mg (20)', 'tube', 450, 300, 60, 600], ['Chronic Care', 'Metformin 500mg (30)', 'pill', 220, 130, 90, 450], ['Chronic Care', 'Amlodipine 5mg (30)', 'pill', 260, 150, 75, 480], ['First Aid', 'Plaster Strips (pack)', 'plaster', 80, 45, 100, 900], ['First Aid', 'Hydrogen Peroxide 100ml', 'bottle', 110, 70, 40, 520], ['Personal Care', 'Hand Sanitizer 250ml', 'bottle', 250, 160, 60, 800], ['Baby Care', 'Zinc Tablets (10)', 'pill', 120, 70, 85, 430],
  ].map((a, i) => { const exp = ymd(now + a[6] * DAY); const it = item(pad(500 + i, 5), a[1], a[0], a[3], a[4], a[5], 'pcs', a[2], { expiryDate: exp, batches: [{ id: 'bt' + (i + 1), batchNumber: 'B' + pad(24100 + i, 5), expiryDate: exp, qty: a[5] }] }); return it; });
  D[9].batches.push({ id: 'bt-x', batchNumber: 'B-OLD', expiryDate: ymd(now - 10 * DAY), qty: 3 });   // one expired batch for the expiry report
  const base = shopBase(R, now, 'Pharmacy', D, { perDay: 7, suppliers: ['Kenya Pharma Distributors', 'Afya Medical Supplies'] });
  const patients = PEOPLE.slice(0, 8).map((n, i) => ({ id: 'dp' + (i + 1), name: n, age: 20 + i * 6, sex: i % 2 === 0 ? 'F' : 'M', phone: phone(i), allergies: i === 2 ? 'Penicillin' : '', registeredAt: now - (40 - i) * DAY }));
  return { ...base, patients, labRequests: [] };
}

// ======================= PRODUCTION (manufacturing / bakery) =======================
function production(now) {
  const R = rng(262006);
  const P = [
    ['Bakery', 'White Bread 400g', 'bread', 55, 33, 120], ['Bakery', 'Brown Bread 600g', 'bread', 90, 56, 80], ['Bakery', 'Mandazi (6)', 'mandazi', 60, 32, 140], ['Bakery', 'Cake 1kg (Vanilla)', 'cake', 1100, 640, 12], ['Bakery', 'Scones (4)', 'scone', 120, 66, 60],
    ['Dairy', 'Yoghurt 500ml', 'yoghurt', 130, 85, 70], ['Dairy', 'Mala 500ml', 'milk', 90, 58, 85], ['Packaged Foods', 'Peanut Butter 400g', 'nuts', 340, 210, 50], ['Packaged Foods', 'Chilli Sauce 250ml', 'sauce', 190, 110, 45],
    ['Raw Materials', 'Wheat Flour (50kg bag)', 'flour', 4800, 4300, 20], ['Raw Materials', 'Sugar (50kg bag)', 'sugar', 7600, 7100, 10], ['Raw Materials', 'Yeast 500g', 'yeast', 540, 420, 25],
  ].map((a, i) => item(pad(600 + i, 5), a[1], a[0], a[3], a[4], a[5], 'pcs', a[2]));
  const base = shopBase(R, now, 'Bakery & Production', P, { perDay: 6, suppliers: ['Millers', 'Dairy Co-op'] });
  const productionHistory = [0, 1, 2, 3, 4, 5].map((i) => ({ id: 'dprod' + (i + 1), timestamp: iso(now - (i * 2 + 1) * DAY), productCode: P[i % 5].code, productName: P[i % 5].name, qtyProduced: 100 + i * 20, costPerUnit: P[i % 5].wholesalePrice, notes: 'Batch ' + (i + 1) }));
  return { ...base, productionHistory, rentals: [] };
}

// ======================= SERVICES (one demo per business type) =======================
// Each type has its own business name and price list (the till history and the Sales/Services screens use them). The jobs, customers,
// vehicles and devices are created in the browser by the svc-demo block, through the app's own job code, so they match each type's forms.
const SVC_PROFILES = {
  services: { name: 'Glow Salon & Spa', sup: ['Beauty Supplies'], seed: 262007, base: 700, items: [['Hair', 'Haircut (Men)', 'scissors', 300, 40], ['Hair', 'Braids (Medium)', 'braid', 2500, 300], ['Hair', 'Hair Treatment', 'treat', 1200, 250], ['Nails', 'Manicure', 'nails', 700, 90], ['Nails', 'Pedicure', 'nails', 900, 110], ['Beauty', 'Facial', 'facial', 1500, 300], ['Beauty', 'Makeup', 'makeup', 2000, 400], ['Massage', 'Full Body Massage (60m)', 'massage', 3000, 500]] },
  carwash: { name: 'Sparkle Car Wash', sup: ['Auto Care Supplies'], seed: 262011, base: 800, items: [['Wash', 'Basic Wash', 'car', 500, 80], ['Wash', 'Premium Wash', 'car', 1500, 250], ['Wash', 'Motorbike Wash', 'car', 300, 50], ['Wash', 'Tuk-tuk Wash', 'car', 300, 50], ['Interior', 'Interior Cleaning', 'car', 800, 150], ['Detailing', 'Wax & Polish', 'car', 2500, 500], ['Exterior', 'Engine Wash', 'car', 1000, 200], ['Carpets & Fabrics', 'Carpet Cleaning', 'car', 1000, 180], ['Carpets & Fabrics', 'Seat Cover Wash', 'car', 600, 100]] },
  phonerepair: { name: 'FixIt Phone Repair', sup: ['Spares Hub Nairobi'], seed: 262012, base: 900, items: [['Screen', 'Screen Replacement', 'phone', 3500, 2200], ['Battery', 'Battery Replacement', 'phone', 2000, 1100], ['Charging', 'Charging Port Repair', 'phone', 1500, 600], ['Software', 'Software / Flashing', 'phone', 1000, 100], ['Water damage', 'Water Damage Treatment', 'phone', 2500, 400], ['Accessories', 'Screen Protector', 'phone', 300, 60], ['Other', 'Diagnostic Fee', 'phone', 300, 0]] },
  garage: { name: 'Kamau Auto Garage', sup: ['Autospares Industrial Area'], seed: 262013, base: 1000, items: [['Service', 'Oil & Filter Service', 'tools', 3500, 2400], ['Service', 'Full Service', 'tools', 8000, 5200], ['Brakes', 'Brake Pad Replacement', 'tools', 4500, 2800], ['Tyres', 'Wheel Alignment', 'tools', 2000, 300], ['Diagnostics', 'Diagnostic Scan', 'tools', 1500, 100], ['Electrical', 'Battery Replacement', 'tools', 9000, 7200]] },
  barber: { name: 'Sharp Cuts Barbershop', sup: ['Barber Supplies Ltd'], seed: 262014, base: 1100, items: [['Cuts', 'Haircut', 'scissors', 300, 20], ['Cuts', 'Kids Cut', 'scissors', 200, 15], ['Beard', 'Beard Trim', 'scissors', 250, 15], ['Beard', 'Shave', 'scissors', 200, 15], ['Colour', 'Hair Dye', 'scissors', 600, 200], ['Wash', 'Hair Wash', 'scissors', 150, 20]] },
  laundry: { name: 'FreshFold Laundry', sup: ['Detergent Wholesalers'], seed: 262015, base: 1200, items: [['Wash & Fold', 'Wash & Fold (per kg)', 'laundry', 150, 40], ['Ironing', 'Ironing (per item)', 'laundry', 50, 5], ['Dry Cleaning', 'Suit (2 piece)', 'laundry', 800, 250], ['Dry Cleaning', 'Shirt', 'laundry', 250, 60], ['Household', 'Duvet', 'laundry', 600, 150], ['Household', 'Curtains (per panel)', 'laundry', 400, 100], ['Household', 'Bedsheet Set', 'laundry', 200, 50]] },
  cleaning: { name: 'BrightHome Cleaning', sup: ['Cleaning Chemicals Co.'], seed: 262016, base: 1300, items: [['Home', 'Home Cleaning', 'clean', 3000, 900], ['Commercial', 'Office Cleaning', 'clean', 5000, 1600], ['Upholstery', 'Sofa Cleaning', 'clean', 2000, 500], ['Carpets', 'Carpet Shampoo', 'clean', 1500, 400], ['Deep clean', 'Post-construction Cleaning', 'clean', 8000, 2800], ['Windows', 'Window Cleaning', 'clean', 1200, 300]] },
  electronics: { name: 'Zuri Electronics Repair', sup: ['Electronics Spares Moi Avenue'], seed: 262017, base: 1400, items: [['TV', 'TV Repair', 'tools', 2500, 900], ['Appliances', 'Fridge Repair', 'tools', 3000, 1200], ['Appliances', 'Microwave Repair', 'tools', 1500, 500], ['Computers', 'Laptop Repair', 'tools', 2500, 900], ['Audio', 'Sound System Repair', 'tools', 2000, 700], ['Other', 'Diagnostic Fee', 'tools', 500, 0]] },
  tailoring: { name: 'Stitch & Style Tailors', sup: ['Gikomba Fabrics'], seed: 262018, base: 1500, items: [['Alterations', 'Dress Alteration', 'stitch', 800, 100], ['Alterations', 'Trouser Hem', 'stitch', 300, 30], ['Alterations', 'Zip Replacement', 'stitch', 250, 60], ['Made to measure', 'Kitenge Dress', 'stitch', 3500, 1400], ['Made to measure', 'Suit Tailoring', 'stitch', 8000, 4200], ['Uniforms', 'School Uniform', 'stitch', 1500, 700]] }
};
function services(now, key) {
  const P = SVC_PROFILES[key || 'services'];
  const R = rng(P.seed);
  const S = P.items.map((a, i) => item(pad(P.base + i, 5), a[1], a[0], a[3], a[4], 999, 'pcs', a[2], { isService: true }));
  const base = shopBase(R, now, P.name, S, { perDay: 5, suppliers: P.sup });
  // serviceJobs / bookings stay empty: the old "classic" counter would otherwise take over. The sample jobs are made in the browser (svc-demo block).
  return { ...base, bookings: [], serviceJobs: [] };
}

// ======================= WATER (Aqua POS) =======================
function water(now) {
  const R = rng(262008);
  const sites = [{ id: 'site-shop-1', name: 'Water Shop', type: 'shop' }];
  const W = [['500ml Sealed Bottle', 500, 30, 21, 600], ['1L Sealed Bottle', 1000, 50, 35, 500], ['5L Sealed Bottle', 5000, 120, 85, 220], ['20L Refill Dispenser', 20000, 100, 70, 0], ['10L Sealed Bottle', 10000, 200, 140, 120], ['2L Sealed Bottle', 2000, 80, 55, 300], ['Bale 24 x 500ml', 12000, 620, 480, 40]]
    .map((a, i) => ({ code: pad(i + 1, 5), name: a[0], siteId: sites[0].id, category: a[1] === 20000 ? 'refill' : 'bottled', sizeML: a[1], price: a[2], wholesalePrice: a[3], qty: a[4], stock: { [sites[0].id]: a[4] }, customQuote: false, priceTiers: [], bom: [], vatCategory: 'A', expiryDate: null, image: img('water') }));
  const sales = buildSales(R, now, W.filter((p) => p.qty > 0).map((p) => ({ ...p, unit: 'pcs' })), { days: 30, perDay: 7 });
  const cd = buildCustomersAndDebts(R, now, 10);
  const tanks = [{ id: 'tank-' + sites[0].id, siteId: sites[0].id, name: 'Tank 1', capacityLiters: 5000, currentVolumeLiters: 3200, lowStockThresholdLiters: 500, refillLog: [{ id: 'dr1', timestamp: iso(now - 3 * DAY), liters: 2000, note: 'Bowser delivery' }] }];
  return { businessName: 'Aqua Water', ownerName: 'Owner', sites, products: W, tanks, salesLog: sales, customers: cd.customers, debts: cd.debts, bills: cd.bills, expenses: buildExpenses(now), stockMovementLog: [], returns: [], suppliers: [], lowStockThreshold: 5, nextReceiptRefSeq: 1000 + sales.length + 1 };
}

// ======================= HOSPITAL / HMIS =======================
function hospital(now) {
  const R = rng(262009);
  const ICD = [['J06.9', 'Acute upper respiratory infection'], ['B50.9', 'Malaria, unspecified'], ['A09', 'Gastroenteritis'], ['I10', 'Essential hypertension'], ['E11.9', 'Type 2 diabetes mellitus'], ['N39.0', 'Urinary tract infection'], ['J45.9', 'Asthma'], ['K29.7', 'Gastritis'], ['M54.5', 'Low back pain'], ['L20.9', 'Atopic dermatitis']];
  const MEDS = [
    ['Paracetamol 500mg Tabs', 'pill', 5, 2.5, 600, 400, 'tablet'], ['Amoxicillin 500mg Caps', 'caps', 20, 11, 300, 240, 'capsule'], ['Artemether/Lumefantrine 80/480', 'pill', 350, 240, 60, 300, 'course'], ['Metformin 500mg Tabs', 'pill', 8, 4, 500, 500, 'tablet'], ['Amlodipine 5mg Tabs', 'pill', 10, 5, 400, 480, 'tablet'], ['ORS Sachets', 'sachet', 35, 20, 150, 700, 'sachet'], ['Omeprazole 20mg Caps', 'caps', 15, 8, 250, 300, 'capsule'],
    ['Salbutamol Inhaler', 'inhaler', 450, 300, 24, 420, 'inhaler'], ['Ceftriaxone 1g Inj', 'inj', 280, 180, 0, 360, 'vial'], ['Normal Saline 500ml', 'drip', 160, 100, 90, 600, 'bag'], ['Ibuprofen 400mg Tabs', 'pill', 6, 3, 8, 30, 'tablet'], ['Cetirizine 10mg Tabs', 'pill', 9, 4, 350, 520, 'tablet'],
  ].map((a, i) => { const exp = ymd(now + a[5] * DAY); return item(pad(800 + i, 5), a[0], 'Pharmacy', a[2], a[3], a[4], 'pcs', a[1], { expiryDate: exp, batches: a[4] ? [{ id: 'hb' + (i + 1), batchNumber: 'H' + pad(7000 + i, 4), expiryDate: exp, qty: a[4] }] : [] }); });
  const SV = [['Consultation - General', 500], ['Consultation - Specialist', 1500], ['Full Blood Count', 600], ['Malaria Test (RDT)', 250], ['Urinalysis', 300], ['Blood Sugar (RBS)', 200], ['X-Ray Chest', 1800], ['Ultrasound Abdomen', 2500]].map((a, i) => item(pad(850 + i, 5), a[0], 'Services', a[1], 0, 9999, 'pcs', 'lab', { isService: true }));
  const inventory = MEDS.concat(SV);
  const patients = PEOPLE.map((n, i) => ({ id: 'PT-' + (10001 + i), name: n, age: 3 + ((i * 11) % 70), dob: ymd(now - (3 + ((i * 11) % 70)) * 365 * DAY), sex: i % 2 === 0 ? 'F' : 'M', phone: phone(i), nextOfKinName: PEOPLE[(i + 5) % PEOPLE.length], nextOfKinPhone: phone(i + 5), nextOfKinRelationship: ['Spouse', 'Parent', 'Sibling', 'Child'][i % 4], bloodType: ['O+', 'A+', 'B+', 'AB+', 'O-'][i % 5], allergies: i % 6 === 2 ? 'Penicillin' : (i % 8 === 5 ? 'Sulfa drugs' : ''), county: ['Nairobi', 'Kiambu', 'Kisumu', 'Mombasa', 'Nakuru'][i % 5], registeredAt: now - (80 - i * 2) * DAY }));
  const visits = [], patientCharges = [], labResults = [];
  const DOCS = ['Dr. Achieng', 'Dr. Mwangi', 'Dr. Hassan'];
  let ref = 5000, cid = 0;
  for (let i = 0; i < 40; i++) {
    const p = patients[i % patients.length]; const dx = ICD[i % ICD.length]; const ts = Math.round(now - (i * 0.75 + 0.1) * DAY); const myRef = 'V' + ymd(ts).slice(2).replace(/-/g, '') + '-' + (ref++).toString(36).toUpperCase().padStart(4, '0');
    const med1 = MEDS[i % 4], med2 = MEDS[(i + 3) % MEDS.length];
    const meds = [{ code: med1.code, name: med1.name, qty: 6 + (i % 3) * 3, unit: 'pcs', dosage: '1 tab 8 hourly x 5 days' }, { code: med2.code, name: med2.name, qty: 1, unit: 'pcs', dosage: 'As directed' }];
    if (i % 5 === 0) meds.push({ name: 'Cefixime 200mg Tabs', notStocked: true, qty: 10, unit: '', dosage: '1 tab 12 hourly x 5 days' });   // NA on the SAME prescription (not stocked here)
    if (i % 7 === 0) meds.push({ code: MEDS[8].code, name: MEDS[8].name, qty: 2, unit: 'pcs', dosage: 'IV once daily' });                    // out of stock -> NA
    const sys = 105 + Math.floor(R() * 50), dia = 65 + Math.floor(R() * 30), wt = 45 + Math.floor(R() * 45), ht = 150 + Math.floor(R() * 35);
    const paid = i >= 3;                                                                                                                  // the 3 newest visits are still unpaid: they wait at the cashier
    visits.push({ id: 'hv' + pad(i + 1, 3), ref: myRef, patientId: p.id, timestamp: ts, seenBy: DOCS[i % 3], visitType: i % 9 === 0 ? 'Emergency' : 'Outpatient', diagnosis: dx[1], icd10Code: dx[0], icd10Label: dx[1], diagnosisType: 'confirmed', consultationFee: 500, medications: meds, services: [{ code: SV[0].code, name: 'Consultation - General', qty: 1, price: 500 }], notes: '', chargeMode: 'counter', billTo: 'self', institutionId: null, institutionName: null, triageLevel: 'routine',
      vitals: { bp: sys + '/' + dia, pulse: 62 + Math.floor(R() * 50), temp: r2(36.2 + R() * 2.4), spo2: 93 + Math.floor(R() * 7), weightKg: wt, heightCm: ht, bmi: r2(wt / ((ht / 100) * (ht / 100))) },
      soap: { s: 'Presents with ' + dx[1].toLowerCase() + ' symptoms for ' + (1 + (i % 5)) + ' days.', o: 'Alert, chest clear, abdomen soft.', a: dx[1], p: 'Treat as prescribed; review in 1 week or if worse.' } });
    const base = { ref: myRef, visitId: 'hv' + pad(i + 1, 3), patientId: p.id, patientName: p.name, status: paid ? 'paid' : 'unpaid', createdAt: ts, createdBy: DOCS[i % 3], updatedAt: ts };
    patientCharges.push({ id: 'hc' + pad(++cid, 4), ...base, kind: 'consultation', name: 'Consultation Fee', code: '', qty: 1, price: 500, unit: 'use', isService: true, vatCategory: 'A' });
    meds.filter((m) => m.code).forEach((m) => { const inv = inventory.find((x) => x.code === m.code) || {}; patientCharges.push({ id: 'hc' + pad(++cid, 4), ...base, kind: 'medication', name: m.name, code: m.code, qty: m.qty, price: inv.price || 0, unit: 'pcs', isService: false, vatCategory: 'A' }); });
    if (i % 3 === 0) {
      const tests = [['Full Blood Count', 'Hb 12.8 g/dL (ref 12.0-16.0); WBC 7.2 x10^9/L (ref 4.0-11.0); Platelets 260 x10^9/L (ref 150-400)'], ['Malaria Test (RDT)', i % 2 ? 'Positive (P. falciparum)' : 'Negative'], ['Blood Sugar (RBS)', (4.5 + R() * 6).toFixed(1) + ' mmol/L (ref 3.9-7.8)'], ['Urinalysis', 'Leucocytes ++, Nitrites +, Protein trace']][i % 4];
      labResults.push({ id: 'hl' + pad(i + 1, 3), patientId: p.id, testName: tests[0], requestedAt: ts, requestedBy: DOCS[i % 3], resultAt: ts + 3600000, resultText: tests[1], status: 'completed' });
    }
  }
  labResults.push({ id: 'hl-pending', patientId: patients[3].id, testName: 'Full Blood Count', requestedAt: now - 3600000, requestedBy: DOCS[0], resultAt: null, resultText: '', status: 'pending' });
  const BEDS = [['Ward A - Bed 1', 'General'], ['Ward A - Bed 2', 'General'], ['Ward A - Bed 3', 'General'], ['Ward A - Bed 4', 'General'], ['Ward A - Bed 5', 'General'], ['Private - Room 1', 'Private'], ['Private - Room 2', 'Private'], ['HDU - Bed 1', 'HDU'], ['HDU - Bed 2', 'HDU'], ['ICU - Bed 1', 'ICU']];
  const rooms = BEDS.map((b) => b[0]), bedTypes = {}; BEDS.forEach((b) => { bedTypes[b[0]] = b[1]; });
  const ADM = [['Ward A - Bed 3', 'General', 1500, 500, 3000], ['Ward A - Bed 5', 'General', 1500, 500, 5000], ['Private - Room 1', 'Private', 4500, 1000, 8000], ['HDU - Bed 1', 'HDU', 6000, 2000, 15000]];
  const roomStates = {}; const admissions = ADM.map((a, i) => { roomStates[a[0]] = { status: 'occupied', reservation: null }; return { id: 'ha' + (i + 1), patientId: patients[i + 6].id, bedLabel: a[0], wardType: a[1], diagnosis: ICD[(i + 1) % 10][1], admittedAt: now - (i + 1) * DAY, dischargedAt: null, status: 'admitted', depositAmount: a[4], dailyBedRate: a[2], dailyNursingRate: a[3], dischargeSummary: '', notes: [{ id: 'han' + (i + 1), timestamp: now - i * 3600000 * 6, type: 'progress', text: 'Vitals stable. Tolerating oral fluids. Continue current plan.', staffName: 'Nurse Wafula' }] }; });
  const appointments = [0, 1, 2, 3, 4, 5].map((i) => ({ id: 'hap' + (i + 1), patientId: patients[i + 10].id, patientName: patients[i + 10].name, scheduledFor: Math.ceil((now + (i + 1) * 3600000 * 5) / 1800000) * 1800000, reason: ['Hypertension review', 'Diabetes follow-up', 'Antenatal visit', 'Wound dressing', 'Asthma review', 'Post-op check'][i], doctorAssigned: DOCS[i % 3], type: 'follow-up', status: 'scheduled', createdAt: now - DAY }));
  const patientNotes = [0, 1, 2, 3, 4, 5].map((i) => ({ id: 'hn' + (i + 1), patientId: patients[i].id, timestamp: now - (i + 1) * DAY, addedBy: DOCS[i % 3], text: ['Counselled on adherence to antihypertensives.', 'Advised diet review; HbA1c due next visit.', 'Allergy to penicillin re-confirmed; avoid beta-lactams.', 'Wound clean, no signs of infection.', 'Inhaler technique reviewed.', 'Referred for ultrasound.'][i] }));
  const queue = [['triage', 'urgent', 'T'], ['consultation', 'routine', 'C'], ['consultation', 'routine', 'C']].map((q, i) => { const t = now - (i + 1) * 600000; return { id: 'hq' + (i + 1), patientId: patients[i + 16].id, arrivedAt: t, triageLevel: q[1], status: 'waiting', vitals: null, notes: '', stage: q[0], stationStatus: 'waiting', stationAt: t, service: q[0] === 'triage' ? 'Triage' : 'General Clinic', queueNo: q[2] + pad(i + 1, 3), registeredBy: 'Reception', stageHistory: [{ stage: q[0], at: t, by: 'Reception', from: 'reception', queueNo: q[2] + pad(i + 1, 3), reason: '' }], events: [], visitIds: [], updatedAt: t }; });
  const base = { businessName: 'County Hospital (HMIS)', ownerName: 'Administrator', inventory, salesLog: [], customers: [], debts: [], bills: [], expenses: buildExpenses(now), stockMovementLog: stockMoves(now, MEDS), suppliers: [{ id: 'sup-h1', name: 'Medical Stores', phone: phone(50) }], returns: [], lowStockThreshold: 10, nextReceiptRefSeq: 1000 };
  return { ...base, patients, visits, patientCharges, labResults, admissions, appointments, patientNotes, queue, rooms, bedTypes, roomStates, tables: ['Ward A', 'Private Wing', 'HDU', 'ICU'], institutions: [], hmisConfig: {} };
}


// ======================= CAR WASH & CLEANING (zip 361: the standalone app's own records) =======================
// Customers with vehicles, a month of car jobs and cleaning jobs with payments, the loyalty ledger those payments earned (one customer has a
// FREE wash waiting, others are close), today's live jobs in every stage, staff with roles and a cleaning team. Ids are fixed: re-seeding
// produces the same records. Demo staff sign in with PIN 0000.
// zip 362: the standard (Splash & Dash) price list. Index -> [compact service, large service] (one price whatever the type, picked by vehicle size)
const CW_SVCS = [
  [['sd-wash-compact', 'Wash Compact Vehicle', 400, 20], ['sd-wash-large', 'Wash Large Vehicle', 500, 25]],
  [['sd-wash-compact-vac', 'Wash Compact Vehicle with Vacuum', 700, 35], ['sd-wash-large-vac', 'Wash Large Vehicle with Vacuum', 800, 40]],
  [['sd-dressing', 'Dressing', 300, 15]],
  [['sd-engine', 'Engine Wash Normal', 500, 25]],
  [['sd-polish-wax', 'Body Polish Waxing', 1000, 45]]];
const CW_CARS = [['Toyota', 'Axio'], ['Toyota', 'Fielder'], ['Mazda', 'Demio'], ['Nissan', 'Note'], ['Subaru', 'Forester'], ['Toyota', 'Prado'], ['Honda', 'Fit'], ['Mercedes', 'C200'], ['Toyota', 'Probox'], ['Nissan', 'X-Trail'], ['VW', 'Golf'], ['Isuzu', 'D-Max']];
function carwash(now) {
  const R = rng(262111);
  const PIN0 = '9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0';
  const staff = [['dst-1', 'Peter Kamau', 'attendant', 'Bay 1 washing'], ['dst-2', 'John Otieno', 'attendant', 'Bay 2, interiors'], ['dst-3', 'Mary Wanjiru', 'cashier', 'Reception & payments'], ['dst-4', 'Grace Akinyi', 'cleaner', 'Carpets & house cleaning'], ['dst-5', 'Tom Mwangi', 'cleaner', 'Carpets & delivery'], ['dst-6', 'Sam Kiprop', 'manager', 'Floor manager']]
    .map((a, i) => ({ id: a[0], name: a[1], pinHash: PIN0, roles: [], lockedDates: [], isManager: a[2] === 'manager', salesTabMigrated: true, cwRole: a[2], cwPhone: '2547' + pad(11000000 + i * 1234567, 8).slice(0, 8), cwNo: 'ST' + pad(i + 1, 3), cwDuties: a[3], cwActive: true, createdAt: now - 60 * DAY, updatedAt: now - 60 * DAY }));
  const attendants = ['dst-1', 'dst-2'];
  const plates = ['KDA 123X', 'KCB 456Y', 'KDG 789Z', 'KBZ 321A', 'KDC 654B', 'KCX 987C', 'KDD 147D', 'KCA 258E', 'KDE 369F', 'KBT 741G', 'KDF 852H', 'KCS 963J', 'KDH 159K', 'KCR 357L', 'KDJ 486M', 'KCQ 624N', 'KDK 735P', 'KCP 846Q'];
  const customers = [], vehicles = [];
  for (let i = 0; i < 18; i++) {
    const ph = '254' + ['7', '7', '1', '7'][i % 4] + pad(10000000 + (12345678 + i * 45678913) % 89999999, 8);
    customers.push({ id: 'dcwc-' + (i + 1), name: PEOPLE[i], phone: ph, altPhone: '', email: i % 3 === 0 ? PEOPLE[i].split(' ')[0].toLowerCase() + '@example.com' : '', contactPref: ['sms', 'whatsapp', 'call'][i % 3], type: i % 6 === 5 ? 'office' : i % 4 === 3 ? 'home' : 'car_owner', location: ['Westlands', 'Kilimani', 'Lavington', 'South B', 'Kileleshwa', 'Parklands'][i % 6], estate: ['Olive Court', 'Riverside', 'Green Park', 'Sunrise', 'Palm Grove'][i % 5], town: 'Nairobi', building: i % 3 === 0 ? 'Block ' + String.fromCharCode(65 + i % 4) : '', house: String(10 + i) + (i % 2 ? 'B' : 'A'), floor: String(i % 5), notes: '', createdAt: now - (75 - i * 3) * DAY, createdBy: 'Mary Wanjiru', updatedAt: now - (75 - i * 3) * DAY });
    const m = CW_CARS[i % CW_CARS.length];
    const cat = /Prado|Forester|X-Trail/.test(m[1]) ? 'suv' : /D-Max/.test(m[1]) ? 'truck' : /Probox/.test(m[1]) ? 'large' : i % 7 === 3 ? 'cab' : 'compact';
    vehicles.push({ id: 'dcwv-' + (i + 1), plate: plates[i].replace(/\s/g, ''), make: m[0], model: m[1], year: String(2008 + (i * 3) % 14), colour: ['White', 'Silver', 'Black', 'Blue', 'Grey', 'Red'][i % 6], category: cat, customerId: 'dcwc-' + (i + 1), notes: '', createdAt: now - (75 - i * 3) * DAY, updatedAt: now - (75 - i * 3) * DAY });
  }
  vehicles.push({ id: 'dcwv-19', plate: 'KDL951R', make: 'Toyota', model: 'Harrier', colour: 'Black', category: 'suv', customerId: 'dcwc-1', notes: 'Second car', createdAt: now - 40 * DAY, updatedAt: now - 40 * DAY });
  const big = (v) => ['large', 'suv', 'truck'].includes(v.category);
  const svcFor = (k, v) => { const o = CW_SVCS[k]; return o.length > 1 && big(v) ? o[1] : o[0]; };
  const jobs = [], payments = [], loyalty = [], sms = [];
  let seq = 0;
  const hist = (id, list) => list.map((x, k) => ({ id: 'dsh-' + id + '-' + k, s: x[0], at: x[1], by: x[2] || 'Mary Wanjiru', byId: x[3] || 'dst-3', note: '' }));
  const lkey = (c, v) => 'car|' + c.phone + '|' + v.plate;
  const day = (ms) => { const d = new Date(ms + 3 * 3600000); return String(d.getUTCFullYear()).slice(2) + pad(d.getUTCMonth() + 1, 2) + pad(d.getUTCDate(), 2); };
  const mk = (t, c, v, svcIdx, staffId, stage, payMethod, opts = {}) => {
    seq++;
    const id = 'dcwj-' + pad(seq, 4), no = 'CW-' + day(t) + '-' + pad(seq % 1000, 3);
    const items = svcIdx.map((k, n) => { const x = svcFor(k, v); return { id: 'dli-' + seq + '-' + n, serviceId: x[0], name: x[1], price: x[2], qty: 1 }; });
    const mins = svcIdx.reduce((s, k) => s + svcFor(k, v)[3], 0), sname = staff.find((x) => x.id === staffId).name;
    const h = [['received', t], ['assigned', t + 60000]];
    if (stage >= 1) h.push(['washing', t + 5 * 60000, sname, staffId]);
    if (stage >= 2) { h.push(['completed', t + (mins + 10) * 60000, sname, staffId]); h.push(['ready', t + (mins + 10) * 60000 + 1, sname, staffId]); }
    if (stage >= 3) h.push(['collected', t + (mins + 30) * 60000]);
    const status = h[h.length - 1][0];
    const total = opts.free ? 0 : items.reduce((s, x) => s + x.price, 0);
    const job = { id, no, kind: 'car', customerId: c.id, vehicleId: v.id, items, discount: opts.free ? items.reduce((s, x) => s + x.price, 0) : 0, instructions: '', condition: '', estMinutes: mins, receivedAt: t, createdAt: t, createdBy: 'Mary Wanjiru', createdById: 'dst-3', device: 'demo', dueAt: t + mins * 60000,
      cleaning: null, assignments: [{ id: 'das-' + seq, staffId, name: sname, teamId: '', at: t + 60000, by: 'Mary Wanjiru', removedAt: null, rev: 0 }], statusHistory: hist(id, h), photos: [], teamId: '', free: !!opts.free, loyaltyKey: lkey(c, v), collection: stage >= 3 ? { at: t + (mins + 30) * 60000, releasedBy: sname, releasedById: staffId, confirmed: true, note: '', payStatus: payMethod || opts.free ? (opts.free ? 'free' : 'paid') : 'unpaid', balance: payMethod ? 0 : total } : null,
      invoiceNo: 'INV-' + no.slice(3), status, statusAt: h[h.length - 1][1], phase: { collected: 3, ready: 2, washing: 1, assigned: 0 }[status], closedAt: stage >= 3 ? t + (mins + 30) * 60000 : null, completedAt: stage >= 2 ? t + (mins + 10) * 60000 : null, updatedAt: t + (mins + 30) * 60000 };
    jobs.push(job);
    if (payMethod && total > 0) {
      const at = t + (mins + 25) * 60000;
      payments.push({ id: 'dcwp-' + seq, jobId: id, jobNo: no, customerId: c.id, amount: total, method: payMethod, ref: payMethod === 'mpesa' ? 'S' + 'GHJKLMNPQRSTUVW'.charAt(seq % 15) + pad(seq * 7919 % 99999999, 8) : '', type: 'payment', at, by: 'Mary Wanjiru', byId: 'dst-3', byName: 'Mary Wanjiru', note: '', device: 'demo', updatedAt: at });
      loyalty.push({ id: 'cwl-earn-' + id + '-0', key: job.loyaltyKey, type: 'earn', jobId: id, jobNo: no, at, by: 'Mary Wanjiru', updatedAt: at });
    }
    if (opts.free && stage >= 2) loyalty.push({ id: 'cwl-redeem-' + id + '-0', key: job.loyaltyKey, type: 'redeem', jobId: id, jobNo: no, at: t + (mins + 10) * 60000, by: sname, updatedAt: t + (mins + 10) * 60000 });
    sms.push({ id: 'cws-checkin-' + id, event: 'checkin', jobId: id, jobNo: no, customerId: c.id, to: c.phone, message: 'Hello ' + c.name.split(' ')[0] + ', your car ' + plates[Number(v.id.split('-')[1]) - 1 || 0] + ' has been received for ' + items.map((x) => x.name).join(' + ') + ' (KES ' + total + '). It will be handled by ' + sname + '. Thank you for choosing Sparkle Car Wash.', status: 'sent', tries: 1, at: t, sentAt: t + 3000, by: 'Mary Wanjiru', dev: 'demo', error: '', updatedAt: t + 3000 });
    return job;
  };
  // 30 days of history: customer 1 (KDA 123X) has 9 paid washes -> a FREE wash waiting; customer 2 has 8 (one to go)
  for (let d = 30; d >= 1; d--) {
    const n = 3 + Math.floor(R() * 3);      // zip 381: 3-5 jobs a day (was 4-7): the demo stayed over its 400 KB size budget (478 KB), so it loaded slowly
    for (let k = 0; k < n; k++) {
      let ci = 2 + Math.floor(R() * 16);
      if (d % 3 === 0 && k === 0) ci = 0;
      if (d % 3 === 1 && k === 0 && d > 4) ci = 1;
      const c = customers[ci], v = vehicles[ci];
      const t = now - d * DAY - (8 + k * 1.3 + R()) * 3600000;
      const svc = R() < 0.5 ? [1] : R() < 0.5 ? [0, 3] : [1, 2, 3];
      mk(t, c, v, svc, attendants[(d + k) % 2], 3, R() < 0.55 ? 'mpesa' : 'cash');
    }
  }
  // today: live jobs in every stage (customer 1's free wash among them)
  const tday = now - 3 * 3600000;
  mk(tday, customers[0], vehicles[18], [1, 2], 'dst-1', 1, null);
  mk(tday + 20 * 60000, customers[3], vehicles[3], [0, 3], 'dst-2', 2, null);
  mk(tday + 40 * 60000, customers[5], vehicles[5], [1], 'dst-1', 3, 'mpesa');
  mk(tday + 70 * 60000, customers[7], vehicles[7], [1, 4], 'dst-2', 1, null);
  mk(now - 25 * 60000, customers[9], vehicles[9], [0], 'dst-1', 0, null);
  // cleaning jobs (carpet pickups, a sofa, a house cleaning)
  const cleans = [['carpet', '6x9', 1, 2000, 200, 'Carpet/Rug Large', 'sd-rug-large', 6, 'delivered'], ['carpet', '5x8', 2, 1500, 200, 'Carpet/Rug Medium', 'sd-rug-medium', 4, 'ready_delivery'], ['carpet', '4x6', 3, 1000, 0, 'Carpet/Rug Small', 'sd-rug-small', 2, 'in_cleaning'], ['sofa', '', 5, 500, 0, 'Sofa cleaning (per seat)', '', 1, 'received'], ['carpet', '7x10', 1, 2000, 150, 'Carpet/Rug Large', 'sd-rug-large', 9, 'delivered']];
  cleans.forEach((x, i) => {
    seq++;
    const c = customers[10 + i], t = now - x[7] * DAY + 9 * 3600000, id = 'dcwj-' + pad(seq, 4), no = 'CL-' + day(t) + '-' + pad(i + 1, 3);
    const flow = x[0] === 'house' ? ['received'] : ['received', 'picked_up', 'in_cleaning', 'quality_check', 'ready_delivery', 'out_delivery', 'delivered'];
    const upto = flow.indexOf(x[8]);
    const h = flow.slice(0, upto + 1).map((s, k) => [s, t + k * 5 * 3600000, k ? 'Grace Akinyi' : 'Mary Wanjiru', k ? 'dst-4' : 'dst-3']);
    const total = x[3] * x[2] + x[4];
    jobs.push({ id, no, kind: 'clean', customerId: c.id, vehicleId: '', items: [{ id: 'dli-c' + i, serviceId: x[6], name: x[5] + (x[1] ? ' (' + x[1] + ')' : ''), price: x[3], qty: x[2] }], discount: 0, instructions: i === 1 ? 'Call before delivery' : '', condition: i === 0 ? 'Wine stain in one corner' : '', estMinutes: 1440, receivedAt: t, createdAt: t, createdBy: 'Mary Wanjiru', createdById: 'dst-3', device: 'demo', dueAt: t + DAY,
      cleaning: { type: x[0], dims: x[1], qty: x[2], delivery: x[4], pickup: { location: c.location, estate: c.estate, building: c.building, house: c.house, floor: c.floor, landmark: 'Next to the gate' }, scheduledAt: t, expectedAt: t + DAY, deliveredAt: x[8] === 'delivered' ? t + 30 * 3600000 : null, deliveryConfirmedBy: x[8] === 'delivered' ? c.name.split(' ')[0] : '' },
      assignments: [{ id: 'das-c' + i, staffId: 'dst-4', name: 'Grace Akinyi', teamId: 'dtm-a', at: t, by: 'Mary Wanjiru', removedAt: null, rev: 0 }, { id: 'das-c2' + i, staffId: 'dst-5', name: 'Tom Mwangi', teamId: 'dtm-a', at: t, by: 'Mary Wanjiru', removedAt: null, rev: 0 }],
      statusHistory: hist(id, h), photos: [], teamId: 'dtm-a', free: false, loyaltyKey: 'clean|' + c.phone, collection: x[8] === 'delivered' ? { at: t + 30 * 3600000, releasedBy: 'Tom Mwangi', releasedById: 'dst-5', confirmed: true, note: '', payStatus: 'paid', balance: 0 } : null,
      invoiceNo: 'INV-' + no.slice(3), status: x[8], statusAt: h[h.length - 1][1], phase: { delivered: 3, ready_delivery: 2, in_cleaning: 1, received: 0 }[x[8]], closedAt: x[8] === 'delivered' ? t + 30 * 3600000 : null, completedAt: upto >= 4 ? t + 20 * 3600000 : null, updatedAt: t + 30 * 3600000 });
    if (x[8] === 'delivered' || x[8] === 'ready_delivery') {
      const amt = x[8] === 'delivered' ? total : 500, at = t + 2 * 3600000;
      payments.push({ id: 'dcwp-c' + i, jobId: id, jobNo: no, customerId: c.id, amount: amt, method: 'mpesa', ref: 'SKC' + pad(1000000 + i * 7919, 7), type: x[8] === 'delivered' ? 'payment' : 'deposit', at, by: 'Mary Wanjiru', byId: 'dst-3', byName: 'Mary Wanjiru', note: '', device: 'demo', updatedAt: at });
      if (x[8] === 'delivered') loyalty.push({ id: 'cwl-earn-' + id + '-0', key: 'clean|' + c.phone, type: 'earn', jobId: id, jobNo: no, at, by: 'Mary Wanjiru', updatedAt: at });
    }
  });
  const cwConfig = [{ id: 'cfg', v: 1, catalog: 'sd1', business: { name: 'Sparkle Car Wash', logo: '', address: 'Ngong Road, opposite the Mall', phone: '0712 345 678', email: 'hello@sparklecarwash.co.ke', location: 'Nairobi' },
    payments: { methods: ['cash', 'mpesa', 'card'], custom: [], till: '5123456', paybill: '', account: '', invoiceNotes: 'Thank you for choosing Sparkle Car Wash.' },
    teams: [{ id: 'dtm-a', name: 'Team A', memberIds: ['dst-4', 'dst-5'], active: true }], updatedAt: now - 60 * DAY }];
  const cwAudit = jobs.slice(-12).map((j, i) => ({ id: 'dcwa-' + i, at: j.receivedAt, by: 'Mary Wanjiru', byId: 'dst-3', role: 'cashier', act: 'job.create', ref: j.no, jobId: j.id, detail: j.items.map((x) => x.name).join(' + '), updatedAt: j.receivedAt }));
  return { businessName: 'Sparkle Car Wash', ownerName: 'Owner', staff, cwCustomers: customers, cwVehicles: vehicles, cwJobs: jobs, cwPayments: payments, cwLoyalty: loyalty, cwSms: sms, cwAudit, cwComplaints: [{ id: 'dcwk-1', jobId: jobs[jobs.length - 9].id, jobNo: jobs[jobs.length - 9].no, customerId: jobs[jobs.length - 9].customerId, kind: 'complaint', text: 'Water spots left on the bonnet.', involved: ['dst-1', 'dst-2'], attributedTo: [], at: now - 2 * DAY, by: 'Sam Kiprop', resolved: false, updatedAt: now - 2 * DAY }], cwConfig, inventory: [], salesLog: [], customers: [], expenses: [], stockMovementLog: [], returns: [], suppliers: [], bills: [], debts: [] };
}

const svcBuilder = (k) => (now) => services(now, k);
export const SEED_BUILDERS = { retail, hardware, liquor, hotel, pharmacy, production, services: svcBuilder('services'), carwash, phonerepair: svcBuilder('phonerepair'), garage: svcBuilder('garage'), barber: svcBuilder('barber'), laundry: svcBuilder('laundry'), cleaning: svcBuilder('cleaning'), electronics: svcBuilder('electronics'), tailoring: svcBuilder('tailoring'), water, hospital };
export function buildDemoSeed(kind, now) {
  const b = SEED_BUILDERS[kind];
  if (!b) throw new Error('No demo data for ' + kind);
  return b(now || Date.now());
}
