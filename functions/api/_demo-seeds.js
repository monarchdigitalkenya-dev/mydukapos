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

// ======================= SERVICES (salon / repair / laundry etc.) =======================
function services(now) {
  const R = rng(262007);
  const S = [
    ['Hair', 'Haircut (Men)', 'scissors', 300, 40], ['Hair', 'Braids (Medium)', 'braid', 2500, 300], ['Hair', 'Hair Treatment', 'treat', 1200, 250], ['Nails', 'Manicure', 'nails', 700, 90], ['Nails', 'Pedicure', 'nails', 900, 110], ['Beauty', 'Facial', 'facial', 1500, 300], ['Beauty', 'Makeup', 'makeup', 2000, 400], ['Massage', 'Full Body Massage (60m)', 'massage', 3000, 500],
  ].map((a, i) => item(pad(700 + i, 5), a[1], a[0], a[3], a[4], 999, 'pcs', a[2], { isService: true }));
  const base = shopBase(R, now, 'Salon & Services', S, { perDay: 5, suppliers: ['Beauty Supplies'] });
  const bookings = [0, 1, 2, 3, 4].map((i) => ({ id: 'BK-d' + (i + 1), customerName: PEOPLE[i], customerPhone: phone(i), serviceCode: S[i].code, staffId: '', date: ymd(now + (i % 3) * DAY), startTime: pad(9 + i, 2) + ':00', endTime: pad(10 + i, 2) + ':00', status: 'confirmed', notes: '', createdAt: now - DAY }));
  const serviceJobs = [0, 1, 2].map((i) => ({ id: 'JOB-d' + (i + 1), createdAt: iso(now - (i + 1) * DAY), clientName: PEOPLE[i + 5], clientPhone: phone(i + 5), idNumber: '', itemDetails: ['Bridal hair trial', 'Gel manicure set', 'Weekend styling'][i], servicesRequired: S[i].name, serviceNotes: '', quoteAmount: S[i].price, promisedPickup: ymd(now + i * DAY), status: ['in-progress', 'ready', 'received'][i], components: [], laborFee: 0, finalAmount: null, saleId: null }));
  return { ...base, bookings, serviceJobs };
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

export const SEED_BUILDERS = { retail, hardware, liquor, hotel, pharmacy, production, services, water, hospital };
export function buildDemoSeed(kind, now) {
  const b = SEED_BUILDERS[kind];
  if (!b) throw new Error('No demo data for ' + kind);
  return b(now || Date.now());
}
