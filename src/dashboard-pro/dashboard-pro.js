/* zip 186 - Dashboard "command center" (Shop; zip 187: also Pharmacy, Production and Services, each with a few extras behind feature detection). Reads ONLY the POS's own records (salesLog, inventory, expenses, returns, bills, debts, customers,
   staff, stockMovementLog) and the POS's own money helpers (reportSaleTotal / reportSaleCost / saleDeliveryFee / billTotalOf), so every figure
   reconciles with Daily Sales and the Reports tab. Nothing is invented: a figure the data cannot support is hidden or says "No data".
   Pure computation (DashPro.compute) is separate from drawing so it can be tested. */
(function () {
    'use strict';
    var D = window.DashPro = window.DashPro || {};
    var LS_KEY = 'pos_dash_pro_v1';
    var PRESETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['lastweek', 'Last week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['year', 'This year'], ['custom', 'Custom']];
    var WIDGETS = [
        ['trend', 'Sales performance'], ['profit', 'Profitability'], ['top', 'Top sellers'], ['category', 'Sales by category'],
        ['inventory', 'Inventory health'], ['slow', 'Slow-moving stock'], ['movement', 'Stock movement'], ['staff', 'Staff performance'],
        ['payments', 'Payment methods'], ['hours', 'Busiest hours'], ['days', 'Sales by weekday'], ['customers', 'Customers'],
        ['credit', 'Credit & debts'], ['expenses', 'Expenses'], ['returns', 'Returns'], ['insights', 'Business insights'],
        ['alerts', 'Needs attention'], ['activity', 'Recent activity'], ['actions', 'Quick actions']
    ];
    // zip 187: what this particular app has, found by looking (never by app name), so one engine serves every app. The Shop sees none of the extras.
    var F = D.features = { expiry: false, production: false, services: false };
    try { F.expiry = !!document.getElementById('inv-has-batches'); } catch (e) { /* none */ }                                         // Pharmacy: batches with expiry dates
    try { F.production = typeof productionHistory !== 'undefined' && Array.isArray(productionHistory); } catch (e) { /* none */ }       // Production: runs + produced items
    try { F.services = !!document.getElementById('svc-dash-cards'); } catch (e) { /* none */ }                                         // Services: sells services, not stock
    (function () {
        var at = function (id) { for (var i = 0; i < WIDGETS.length; i++) if (WIDGETS[i][0] === id) return i; return WIDGETS.length - 1; };
        if (F.expiry) WIDGETS.splice(at('inventory') + 1, 0, ['expiry', 'Expiry watch']);
        if (F.production) WIDGETS.splice(at('movement') + 1, 0, ['production', 'Production']);
    })();
    var COLORS = ['var(--dp-c1)', 'var(--dp-c2)', 'var(--dp-c3)', 'var(--dp-c4)', 'var(--dp-c5)', 'var(--dp-c6)'];

    var S = D.state = { preset: 'today', from: '', to: '', metric: 'revenue', topBy: 'revenue', staffBy: 'revenue', hidden: {}, order: [], topAll: false, catFocus: '' };
    try { var saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (saved) { S.hidden = saved.hidden || {}; S.order = Array.isArray(saved.order) ? saved.order : []; S.preset = saved.preset || 'today'; } } catch (e) { /* defaults */ }
    function persist() { try { localStorage.setItem(LS_KEY, JSON.stringify({ hidden: S.hidden, order: S.order, preset: S.preset })); } catch (e) { /* this session only */ } }

    function n0(v) { v = Number(v); return isFinite(v) ? v : 0; }
    function esc(s) { return typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
    function kes(v) { return 'KES ' + Math.round(n0(v)).toLocaleString('en-US'); }
    function short(v) { v = n0(v); var a = Math.abs(v); if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'; if (a >= 1e4) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'; return Math.round(v).toLocaleString('en-US'); }
    function pct(a, b) { return b > 0 ? Math.round(a / b * 1000) / 10 : 0; }
    function fmtQty(v) { v = n0(v); return (Math.round(v * 100) / 100).toLocaleString('en-US'); }
    function arr(x) { return Array.isArray(x) ? x : []; }
    // the POS's own lists, read by name (each guarded: a missing list is simply empty)
    var G = {
        inventory: function () { return typeof inventory !== 'undefined' ? inventory : undefined; },
        salesLog: function () { return typeof salesLog !== 'undefined' ? salesLog : undefined; },
        expenses: function () { return typeof expenses !== 'undefined' ? expenses : undefined; },
        returns: function () { return typeof returns !== 'undefined' ? returns : undefined; },
        bills: function () { return typeof bills !== 'undefined' ? bills : undefined; },
        debts: function () { return typeof debts !== 'undefined' ? debts : undefined; },
        customers: function () { return typeof customers !== 'undefined' ? customers : undefined; },
        staff: function () { return typeof staff !== 'undefined' ? staff : undefined; },
        stockMovementLog: function () { return typeof stockMovementLog !== 'undefined' ? stockMovementLog : undefined; },
        orders: function () { return undefined; },
        productionHistory: function () { return typeof productionHistory !== 'undefined' ? productionHistory : undefined; },
        businessName: function () { return typeof businessName !== 'undefined' ? businessName : undefined; },
        LOW_STOCK_THRESHOLD: function () { return typeof LOW_STOCK_THRESHOLD !== 'undefined' ? LOW_STOCK_THRESHOLD : undefined; }
    };
    function g(name) { try { return G[name] ? G[name]() : undefined; } catch (e) { return undefined; } }

    /* ---------- dates (business days, same as Daily Sales) ---------- */
    function keyAdd(key, n) { var p = key.split('-').map(Number); var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)); return d.toISOString().slice(0, 10); }
    function keyDow(key) { var p = key.split('-').map(Number); return (new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() + 6) % 7; }   // Monday = 0
    function keyDiff(a, b) { var pa = a.split('-').map(Number), pb = b.split('-').map(Number); return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000); }
    function keyLabel(key) { var p = key.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }); }
    function lastOfMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function bounds(fromKey, toKey) {
        var a = bizDayBounds(fromKey), b = bizDayBounds(toKey);
        return a && b ? { from: a.from, to: b.to } : null;
    }
    D.rangeFor = function (preset, customFrom, customTo, nowKey) {
        var tk = nowKey || bizDayKey(Date.now()); var p = tk.split('-').map(Number);
        var from = tk, to = tk, label = 'Today';
        if (preset === 'yesterday') { from = to = keyAdd(tk, -1); label = 'Yesterday'; }
        else if (preset === 'week') { from = keyAdd(tk, -keyDow(tk)); label = 'This week'; }
        else if (preset === 'lastweek') { var mon = keyAdd(tk, -keyDow(tk)); from = keyAdd(mon, -7); to = keyAdd(mon, -1); label = 'Last week'; }
        else if (preset === 'month') { from = p[0] + '-' + pad(p[1]) + '-01'; label = 'This month'; }
        else if (preset === 'lastmonth') { var y = p[1] === 1 ? p[0] - 1 : p[0], m = p[1] === 1 ? 12 : p[1] - 1; from = y + '-' + pad(m) + '-01'; to = y + '-' + pad(m) + '-' + pad(lastOfMonth(y, m - 1)); label = 'Last month'; }
        else if (preset === 'year') { from = p[0] + '-01-01'; label = 'This year'; }
        else if (preset === 'custom') { if (/^\d{4}-\d{2}-\d{2}$/.test(customFrom || '')) from = customFrom; if (/^\d{4}-\d{2}-\d{2}$/.test(customTo || '')) to = customTo; else to = tk; if (!/^\d{4}-\d{2}-\d{2}$/.test(customFrom || '')) from = to; if (from > to) { var x = from; from = to; to = x; } label = 'Custom'; }
        var days = keyDiff(from, to) + 1;
        var prevTo = keyAdd(from, -1), prevFrom = keyAdd(prevTo, -(days - 1));
        var cur = bounds(from, to) || { from: 0, to: 0 }, prv = bounds(prevFrom, prevTo) || { from: 0, to: 0 };
        var cmp = preset === 'today' ? 'yesterday' : preset === 'yesterday' ? 'the day before' : 'the previous period';
        return { preset: preset, label: label, fromKey: from, toKey: to, days: days, from: cur.from, to: cur.to, prevFromKey: prevFrom, prevToKey: prevTo, prevFrom: prv.from, prevTo: prv.to, cmp: cmp,
            text: from === to ? keyLabel(from) : keyLabel(from) + ' – ' + keyLabel(to) };
    };

    /* ---------- computation ---------- */
    function tsOf(x) { var t = new Date(x && (x.timestamp || x.date || x.createdAt || x.at)).getTime(); return isFinite(t) ? t : 0; }
    function isPay(it) { return it && (it.unit === 'payment' || it.isPayment); }
    function saleTotalOf(s) { var t = typeof reportSaleTotal === 'function' ? reportSaleTotal(s) : arr(s.items).reduce(function (a, it) { return a + n0(it.price) * n0(it.qty); }, 0); if (typeof saleDeliveryFee === 'function') t += n0(saleDeliveryFee(s)); return t; }
    function hourOf(ts) { var off = null; try { off = bizTzOffsetMin(); } catch (e) { off = null; } if (off == null || !isFinite(off)) return new Date(ts).getHours(); return new Date(ts + off * 60000).getUTCHours(); }
    function invIndex() {
        var byCode = {}; arr(g('inventory')).forEach(function (p) { if (p && p.code != null) byCode[String(p.code)] = p; });
        return byCode;
    }
    function unitCost(it, byCode) {
        var c = n0(it.wholesalePrice); if (c > 0) return c;
        var p = it.code != null ? byCode[String(it.code)] : null; if (p) { if (it.variantId && arr(p.variants).length) { var v = p.variants.filter(function (x) { return x && String(x.id) === String(it.variantId); })[0]; if (v && n0(v.wholesalePrice) > 0) return n0(v.wholesalePrice); } return n0(p.wholesalePrice); }
        return 0;
    }
    function aggregate(sales, byCode) {
        var a = { revenue: 0, unpaid: 0, count: 0, unpaidCount: 0, items: 0, cogs: 0, missingCost: 0, costLines: 0, hour: [], dow: [], day: {}, method: { cash: { amt: 0, n: 0 }, mpesa: { amt: 0, n: 0 }, card: { amt: 0, n: 0 }, other: { amt: 0, n: 0 } }, cat: {}, item: {}, staff: {}, cust: {} };
        for (var h = 0; h < 24; h++) a.hour.push({ rev: 0, n: 0 });
        for (var d = 0; d < 7; d++) a.dow.push({ rev: 0, n: 0 });
        sales.forEach(function (s) {
            var total = saleTotalOf(s);
            if (s.paid === false) { a.unpaid += total; a.unpaidCount++; return; }
            var ts = tsOf(s), dk = bizDayKey(ts);
            a.revenue += total; a.count++;
            var cost = typeof reportSaleCost === 'function' ? reportSaleCost(s) : 0; a.cogs += cost;
            var qty = 0;
            arr(s.items).forEach(function (it) {
                if (isPay(it)) return;
                var q = n0(it.qty), line = n0(it.price) * q, uc = unitCost(it, byCode);
                qty += q; a.costLines++; if (!(uc > 0)) a.missingCost++;
                var key = (it.variantId ? it.code + '::' + it.variantId : String(it.code != null ? it.code : it.name)), p = it.code != null ? byCode[String(it.code)] : null;
                var o = a.item[key] || (a.item[key] = { name: it.name || (p && p.name) || '?', code: it.code, cat: (p && p.category) || it.category || 'Uncategorised', qty: 0, rev: 0, cost: 0, img: (p && p.image) || null, unit: it.unit });
                o.qty += q; o.rev += line; o.cost += (typeof moneyLineCost === "function" ? moneyLineCost(it, s) : uc * q);   // zip 390: the line's own cost, the same rule as the totals
                var c = a.cat[o.cat] || (a.cat[o.cat] = { rev: 0, qty: 0 }); c.rev += line; c.qty += q;
            });
            a.items += qty;
            var hr = hourOf(ts); a.hour[hr].rev += total; a.hour[hr].n++;
            var dw = keyDow(dk); a.dow[dw].rev += total; a.dow[dw].n++;
            var day = a.day[dk] || (a.day[dk] = { rev: 0, n: 0, items: 0, cogs: 0 }); day.rev += total; day.n++; day.items += qty; day.cogs += cost;
            // payment mix: the amounts the till recorded; a sale without them counts wholly under its method
            var m = String(s.paymentMethod || 'cash'), cash = s.cashAmount, mp = s.mpesaAmount, cd = s.cardAmount;
            var hasAmts = typeof cash === 'number' || typeof mp === 'number' || typeof cd === 'number';
            var parts = [];
            if (hasAmts) { if (n0(cash) > 0) parts.push(['cash', n0(cash)]); if (n0(mp) > 0) parts.push(['mpesa', n0(mp)]); if (n0(cd) > 0) parts.push(['card', n0(cd)]); }
            var sum = parts.reduce(function (x, y) { return x + y[1]; }, 0);
            if (!parts.length) parts = [[m === 'mpesa' || m === 'card' || m === 'cash' ? m : 'other', total]];
            else if (total - sum > 0.5) parts.push([m === 'mpesa' || m === 'card' || m === 'cash' ? m : 'other', total - sum]);
            parts.forEach(function (pp) { var b = a.method[pp[0]] || a.method.other; b.amt += pp[1]; b.n++; });
            var who = s.servedBy || 'Unassigned', st = a.staff[who] || (a.staff[who] = { rev: 0, n: 0, items: 0, last: 0 });
            st.rev += total; st.n++; st.items += qty; if (ts > st.last) st.last = ts;
            var ck = s.customerPhone || s.mpesaPhone; if (ck) { var cc = a.cust[ck] || (a.cust[ck] = { rev: 0, n: 0, name: s.customerName || '' }); cc.rev += total; cc.n++; if (!cc.name && s.customerName) cc.name = s.customerName; }
        });
        return a;
    }
    // zip 187: an item whose stock is worked out from other items (a produced item, a set, a recipe or combo, a poured/keg serve) has no stock level of
    // its own - counting it would show it as "out of stock". The app's own isStockedProduct() has the final say when it exists.
    function derivedStock(p) {
        try { if (typeof isStockedProduct === 'function' && !isStockedProduct(p)) return true; } catch (e) { /* fall through */ }
        return !!(p.pourOf || p.kegServe || p.type === 'set' || arr(p.productionRecipe).length || arr(p.recipe).length || arr(p.comboItems).length);
    }
    function stockRows() {
        var out = [];
        arr(g('inventory')).forEach(function (p) {
            if (!p || p.removed || p.type === 'service' || p._deleted || derivedStock(p)) return;
            if (p.hasVariants && arr(p.variants).length) p.variants.forEach(function (v) { if (v) out.push({ name: p.name + ' — ' + v.name, code: p.code, key: p.code + '::' + v.id, qty: n0(v.qty), cost: n0(v.wholesalePrice), price: n0(v.price), cat: p.category || 'Uncategorised', unit: p.unit, img: p.image || null, xv: 0 }); });
            else out.push({ name: p.name, code: p.code, key: String(p.code), qty: n0(p.qty), cost: n0(p.wholesalePrice), price: n0(p.price), cat: p.category || 'Uncategorised', unit: p.unit, img: p.image || null, xv: p.dualUnit ? n0(p.pieceQty) * n0(p.pieceWholesalePrice) : 0 });
        });
        return out;
    }
    function expiryWatch() {   // Pharmacy: stock that is expired or inside the app's own warning window (EXPIRY_WARNING_DAYS), per batch when batches are tracked
        var warn = typeof EXPIRY_WARNING_DAYS === 'number' && EXPIRY_WARNING_DAYS >= 0 ? EXPIRY_WARNING_DAYS : 30, today = new Date(); today.setHours(0, 0, 0, 0);
        var days = function (x) { var t = new Date(String(x).slice(0, 10) + 'T00:00:00'); return isNaN(t.getTime()) ? null : Math.round((t - today) / 86400000); };
        var expired = [], soon = [], withDates = 0;
        arr(g('inventory')).forEach(function (p) {
            if (!p || p.removed || p._deleted || derivedStock(p)) return;
            var ents = arr(p.batches).filter(function (b) { return b && n0(b.qty) > 0 && b.expiryDate; }).map(function (b) { return { batch: b.batchNumber || '', qty: n0(b.qty), exp: String(b.expiryDate) }; });
            if (!ents.length && p.expiryDate && n0(p.qty) > 0) ents = [{ batch: '', qty: n0(p.qty), exp: String(p.expiryDate) }];
            ents.forEach(function (e) {
                if (e.exp.slice(0, 4) === '9999') return;   // the app's "no expiry" placeholder
                var dl = days(e.exp); if (dl == null) return; withDates++;
                if (dl > warn) return;
                (dl < 0 ? expired : soon).push({ name: p.name, batch: e.batch, qty: e.qty, unit: p.unit, exp: e.exp.slice(0, 10), days: dl, value: e.qty * n0(p.wholesalePrice) });
            });
        });
        expired.sort(function (a, b) { return a.days - b.days; }); soon.sort(function (a, b) { return a.days - b.days; });
        var sum = function (l) { return l.reduce(function (s, r) { return s + r.value; }, 0); };
        return { warn: warn, expired: expired, soon: soon, withDates: withDates, valueExpired: sum(expired), valueSoon: sum(soon) };
    }
    function productionWatch(range) {   // Production: runs are logged when a produced item is sold (that is when its materials are taken), so they follow sales
        var runs = arr(g('productionHistory')).filter(function (h) { return h && tsOf(h) >= range.from && tsOf(h) <= range.to; });
        var made = {}, used = {}, units = 0;
        runs.forEach(function (h) {
            var k = String(h.itemCode != null ? h.itemCode : h.itemName), o = made[k] || (made[k] = { name: h.itemName || k, qty: 0, runs: 0, unit: h.unit });
            o.qty += n0(h.qtyProduced); o.runs++; units += n0(h.qtyProduced);
            arr(h.componentsUsed).forEach(function (c) { var u = used[c.code != null ? c.code : c.name] || (used[c.code != null ? c.code : c.name] = { name: c.name || c.code, qty: 0, unit: c.unit }); u.qty += n0(c.qty); });
        });
        var can = [];
        arr(g('inventory')).forEach(function (p) {
            if (!p || p.removed || p._deleted || !(arr(p.productionRecipe).length || (p.type === 'set' && arr(p.setComponents).length))) return;
            var n = null; try { if (typeof getAvailableStock === 'function') n = Number(getAvailableStock(p)); } catch (e) { n = null; }
            if (n != null && isFinite(n)) can.push({ name: p.name, n: Math.max(0, n), unit: p.unit });
        });
        can.sort(function (a, b) { return a.n - b.n; });
        return { runs: runs.length, units: units, made: Object.keys(made).map(function (k) { return made[k]; }).sort(function (a, b) { return b.qty - a.qty; }), used: Object.keys(used).map(function (k) { return used[k]; }).sort(function (a, b) { return b.qty - a.qty; }), can: can, ever: arr(g('productionHistory')).length };
    }
    function dOwed(d) { return Math.max(0, n0(d.amount) - n0(d.paidAmount) - arr(d.payments).reduce(function (s, p) { return s + n0(p.amount); }, 0)); }
    D.compute = function (range, opts) {
        opts = opts || {};
        var byCode = invIndex(), all = arr(g('salesLog'));
        var cur = [], prev = [], lastSale = {};
        all.forEach(function (s) {
            if (!s || s.voided) return;
            var t = tsOf(s);
            arr(s.items).forEach(function (it) { if (it && it.code != null && !isPay(it)) { var k = it.variantId ? it.code + '::' + it.variantId : String(it.code); if (!(lastSale[k] >= t)) lastSale[k] = t; } });
            if (t >= range.from && t <= range.to) cur.push(s); else if (t >= range.prevFrom && t <= range.prevTo) prev.push(s);
        });
        var A = aggregate(cur, byCode), P = aggregate(prev, byCode);
        var hasCost = A.costLines > 0 && A.missingCost < A.costLines;
        var exp = arr(g('expenses')).filter(function (e) { if (!e || e.removed) return false; var t = tsOf(e); return t >= range.from && t <= range.to; });
        var expPrev = arr(g('expenses')).filter(function (e) { if (!e || e.removed) return false; var t = tsOf(e); return t >= range.prevFrom && t <= range.prevTo; });
        var expTotal = exp.reduce(function (s, e) { return s + n0(e.amount); }, 0), expPrevTotal = expPrev.reduce(function (s, e) { return s + n0(e.amount); }, 0);
        var expCat = {}; exp.forEach(function (e) { var k = e.category || 'Other'; expCat[k] = (expCat[k] || 0) + n0(e.amount); });
        var rets = arr(g('returns')).filter(function (r) { if (!r || r._deleted) return false; var t = tsOf(r); return t >= range.from && t <= range.to; });
        var retProd = {}; rets.forEach(function (r) { var k = r.itemName || r.itemCode || '?'; retProd[k] = (retProd[k] || 0) + n0(r.qty); });
        var refundAmt = rets.reduce(function (s, r) { return s + (typeof r.refundAmount === 'number' ? r.refundAmount : (typeof r.amount === 'number' ? r.amount : 0)); }, 0);
        var refundKnown = rets.some(function (r) { return typeof r.refundAmount === 'number' || typeof r.amount === 'number'; });
        var rows = stockRows(), limit = typeof g('LOW_STOCK_THRESHOLD') === 'number' ? g('LOW_STOCK_THRESHOLD') : 3;
        var invValue = rows.reduce(function (s, r) { return s + r.qty * r.cost + n0(r.xv); }, 0), units = rows.reduce(function (s, r) { return s + Math.max(0, r.qty); }, 0);
        var low = rows.filter(function (r) { return r.qty > 0 && r.qty <= limit; }), out = rows.filter(function (r) { return r.qty <= 0; });
        var noCost = rows.filter(function (r) { return r.qty > 0 && !(r.cost > 0); });
        var soldKeys = {}; Object.keys(A.item).forEach(function (k) { soldKeys[k] = A.item[k].qty; });
        var slow = rows.filter(function (r) { return r.qty > 0 && !(soldKeys[r.key] > 0); }).map(function (r) { return { name: r.name, qty: r.qty, unit: r.unit, value: r.qty * r.cost, last: lastSale[r.key] || 0, img: r.img }; }).sort(function (a, b) { return b.value - a.value || b.qty - a.qty; });
        var lowSales = rows.filter(function (r) { return r.qty > 0 && soldKeys[r.key] > 0 && soldKeys[r.key] <= 1 && r.qty >= limit * 4; }).length;
        // stock movements in the range
        var mv = arr(g('stockMovementLog')).filter(function (m) { return m && !m._deleted && m.timestamp; });
        var buckets = {}, weekly = range.days > 31;
        var restocked = {}, mvAdded = 0, mvSold = 0, mvAdj = 0, mvLoss = 0, mvCount = 0;
        mv.forEach(function (m) {
            var t = tsOf(m); if (t < range.from || t > range.to) return;
            var d = n0(m.delta), reason = String(m.reason || ''), dk = bizDayKey(t);
            var bk = weekly ? keyAdd(dk, -keyDow(dk)) : dk;
            var b = buckets[bk] || (buckets[bk] = { added: 0, sold: 0, adj: 0, loss: 0 });
            mvCount++;
            if (/damag|loss|lost|expire|waste|faulty|spoil/i.test(reason)) { b.loss += Math.abs(d); mvLoss += Math.abs(d); }
            else if (/adjust|stock ?take|count|correct/i.test(reason) || m.kind === 'count') { b.adj += d; mvAdj += d; }
            else if (d < 0) { b.sold += -d; mvSold += -d; }
            else if (d > 0) { b.added += d; mvAdded += d; if (/restock|receiv|purchase|order|arriv/i.test(reason)) restocked[m.name || m.code] = (restocked[m.name || m.code] || 0) + d; }
        });
        // credit
        var bills = arr(g('bills')).filter(function (b) { return b && !b.voided && !b.closed; });
        var owedOf = function (b) { return Math.max(0, (typeof billTotalOf === 'function' ? billTotalOf(b) : 0) - n0(b.amountPaid)); };
        var billOwed = bills.reduce(function (s, b) { return s + owedOf(b); }, 0);
        var debts = arr(g('debts')).filter(function (d) { return d && !d.removed; });
        var debtOwed = debts.reduce(function (s, d) { return s + dOwed(d); }, 0);
        var owingCust = {}; bills.forEach(function (b) { if (owedOf(b) > 0) owingCust['b:' + (b.customerPhone || b.customerName || b.id)] = 1; }); debts.forEach(function (d) { if (dOwed(d) > 0) owingCust['d:' + (d.customerName || d.name || d.id)] = 1; });
        var todayKey = bizDayKey(Date.now());
        var overdue = bills.filter(function (b) { return b.dueDate && b.dueDate < todayKey && owedOf(b) > 0; });
        var recentCredit = arr(g('bills')).filter(function (b) { return b && !b.voided && tsOf(b) >= range.from && tsOf(b) <= range.to; }).sort(function (a, b) { return tsOf(b) - tsOf(a); }).slice(0, 4);
        var recentPaid = cur.filter(function (s) { return s.billId != null && s.paid !== false; }).sort(function (a, b) { return tsOf(b) - tsOf(a); }).slice(0, 4);
        // customers
        var custs = arr(g('customers')).filter(function (c) { return c && !c._deleted; });
        var custByPhone = {}; custs.forEach(function (c) { if (c.phone) custByPhone[c.phone] = c; });
        var newCust = custs.filter(function (c) { return n0(c.createdAt) >= range.from && n0(c.createdAt) <= range.to; }).length;
        var known = Object.keys(A.cust).filter(function (k) { return custByPhone[k]; });
        var returning = known.filter(function (k) { var c = custByPhone[k]; return n0(c.createdAt) && n0(c.createdAt) < range.from; }).length;
        var custSpend = known.reduce(function (s, k) { return s + A.cust[k].rev; }, 0);
        var topCust = Object.keys(A.cust).map(function (k) { return { name: (custByPhone[k] && custByPhone[k].name) || A.cust[k].name || k, rev: A.cust[k].rev, n: A.cust[k].n }; }).sort(function (a, b) { return b.rev - a.rev; }).slice(0, 5);
        var recentCust = custs.slice().sort(function (a, b) { return n0(b.createdAt) - n0(a.createdAt); }).slice(0, 5);
        // staff
        var staffList = arr(g('staff'));
        var staffRows = Object.keys(A.staff).map(function (k) { var st = A.staff[k]; var rec = staffList.filter(function (x) { return x && x.name === k; })[0]; return { name: k, rev: st.rev, n: st.n, items: st.items, avg: st.n ? st.rev / st.n : 0, last: st.last, known: !!rec }; });
        // series
        var series = [], dayKeyIter = range.fromKey, guard = 0;
        var perHour = range.days === 1;
        if (perHour) { for (var h = 0; h < 24; h++) series.push({ key: h, label: (h % 12 || 12) + (h < 12 ? 'a' : 'p'), long: pad(h) + ':00', rev: A.hour[h].rev, n: A.hour[h].n, items: 0, profit: 0 }); }
        else if (range.days <= 62) { while (dayKeyIter <= range.toKey && guard++ < 400) { var dd = A.day[dayKeyIter] || { rev: 0, n: 0, items: 0, cogs: 0 }; series.push({ key: dayKeyIter, label: keyLabel(dayKeyIter), long: keyLabel(dayKeyIter), rev: dd.rev, n: dd.n, items: dd.items, profit: dd.rev - dd.cogs }); dayKeyIter = keyAdd(dayKeyIter, 1); } }
        else { var wk = {}; Object.keys(A.day).forEach(function (k) { var w = keyAdd(k, -keyDow(k)); var o = wk[w] || (wk[w] = { rev: 0, n: 0, items: 0, cogs: 0 }); o.rev += A.day[k].rev; o.n += A.day[k].n; o.items += A.day[k].items; o.cogs += A.day[k].cogs; }); Object.keys(wk).sort().forEach(function (k) { series.push({ key: k, label: keyLabel(k), long: 'Week of ' + keyLabel(k), rev: wk[k].rev, n: wk[k].n, items: wk[k].items, profit: wk[k].rev - wk[k].cogs }); }); }
        if (perHour) { var dd0 = A.day[range.fromKey]; if (dd0) { /* per-hour profit is not tracked; profit hidden for hourly view */ } }
        var seriesProfitOk = hasCost && !perHour;
        // peak
        var peakHour = -1, peakVal = 0; A.hour.forEach(function (x, i) { if (x.rev > peakVal) { peakVal = x.rev; peakHour = i; } });
        var bestDow = -1, bestDowVal = 0; A.dow.forEach(function (x, i) { if (x.rev > bestDowVal) { bestDowVal = x.rev; bestDow = i; } });
        var recent = [];
        arr(all).slice(-60).forEach(function (s) { if (s && !s.voided) recent.push({ t: tsOf(s), icon: s.paid === false ? '🧾' : '🛒', what: s.paid === false ? 'Credit sale' : 'Sale completed', who: s.servedBy || '', amt: saleTotalOf(s), detail: (arr(s.items)[0] && arr(s.items)[0].name || '') + (arr(s.items).length > 1 ? ' +' + (arr(s.items).length - 1) : ''), tab: 'daily-sales-tab' }); });
        arr(g('expenses')).slice(-20).forEach(function (e) { if (e && !e.removed) recent.push({ t: tsOf(e), icon: '💸', what: 'Expense recorded', who: e.by || e.servedBy || '', amt: n0(e.amount), detail: (e.category || '') + (e.description ? ' · ' + e.description : ''), tab: 'profits-tab' }); });
        arr(g('returns')).slice(-20).forEach(function (r) { if (r) recent.push({ t: tsOf(r), icon: '↩️', what: 'Return processed', who: r.servedBy || '', amt: null, detail: (r.itemName || '') + ' ×' + fmtQty(r.qty), tab: 'returns-tab' }); });
        mv.slice(-60).forEach(function (m) { if (n0(m.delta) > 0 && /restock|receiv|purchase|order|arriv/i.test(String(m.reason || ''))) recent.push({ t: tsOf(m), icon: '📦', what: 'Stock received', who: m.by || '', amt: null, detail: (m.name || m.code || '') + ' +' + fmtQty(m.delta), tab: 'restock-tab' }); else if (/adjust|count|stock ?take/i.test(String(m.reason || '')) || m.kind === 'count') recent.push({ t: tsOf(m), icon: '🧮', what: 'Stock adjusted', who: m.by || '', amt: null, detail: (m.name || m.code || '') + ' ' + (n0(m.delta) >= 0 ? '+' : '') + fmtQty(m.delta), tab: 'inventory-list-tab' }); });
        custs.slice(-10).forEach(function (c) { if (n0(c.createdAt)) recent.push({ t: n0(c.createdAt), icon: '👤', what: 'Customer added', who: '', amt: null, detail: c.name || c.phone || '', tab: 'customers-tab' }); });
        recent.sort(function (a, b) { return b.t - a.t; });
        var noStock = !rows.length && F.services;
        return { feat: F, noStock: noStock, expiry: F.expiry ? expiryWatch() : null, prod: F.production ? productionWatch(range) : null, range: range, A: A, P: P, hasCost: hasCost, expTotal: expTotal, expPrevTotal: expPrevTotal, expCat: expCat, exp: exp, rets: rets, retProd: retProd, refundAmt: refundAmt, refundKnown: refundKnown,
            rows: rows, invValue: invValue, units: units, low: low, out: out, noCost: noCost, slow: slow, lowSales: lowSales, movement: { buckets: buckets, weekly: weekly, added: mvAdded, sold: mvSold, adj: mvAdj, loss: mvLoss, count: mvCount }, restocked: restocked,
            billOwed: billOwed, billCount: bills.length, debtOwed: debtOwed, owingCustomers: Object.keys(owingCust).length, overdue: overdue, recentCredit: recentCredit, recentPaid: recentPaid,
            custTotal: custs.length, newCust: newCust, returning: returning, known: known.length, custSpend: custSpend, topCust: topCust, recentCust: recentCust,
            staffRows: staffRows, series: series, seriesProfitOk: seriesProfitOk, perHour: perHour, peakHour: peakHour, peakVal: peakVal, bestDow: bestDow, bestDowVal: bestDowVal, recent: recent.slice(0, 14), salesEver: all.length };
    };

    /* ---------- chart helpers (inline SVG, theme-aware via CSS variables) ---------- */
    function niceMax(v) { if (v <= 0) return 1; var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
    function spark(vals, color) {
        if (!vals || vals.length < 2 || !vals.some(function (v) { return v > 0; })) return '';
        var w = 80, h = 26, mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals), rng = mx - mn || 1;
        var pts = vals.map(function (v, i) { return (i / (vals.length - 1) * w).toFixed(1) + ',' + (h - 3 - (v - mn) / rng * (h - 6)).toFixed(1); }).join(' ');
        return '<svg class="dp-spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + pts + '" fill="none" stroke="' + (color || 'var(--dp-c1)') + '" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>';
    }
    function cwid(def) { var cw = (root && root.clientWidth) || 0; return cw && cw < 700 ? Math.max(280, cw - 32) : def; }
    function lineChart(pts, key, fmt) {
        if (!pts.length || !pts.some(function (p) { return p[key] > 0; })) return '';
        var W = cwid(900), H = W < 500 ? 210 : 250, L = W < 500 ? 40 : 50, R = 14, T = 14, B = 28, mx = niceMax(Math.max.apply(null, pts.map(function (p) { return p[key]; })));
        var X = function (i) { return pts.length === 1 ? L + (W - L - R) / 2 : L + i * (W - L - R) / (pts.length - 1); }, Y = function (v) { return T + (H - T - B) * (1 - v / mx); };
        var grid = '', i;
        for (i = 0; i <= 4; i++) { var gv = mx * i / 4, gy = Y(gv); grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + gy + '" y2="' + gy + '" class="dp-grid"/><text x="' + (L - 6) + '" y="' + (gy + 4) + '" class="dp-ax" text-anchor="end">' + (key === 'rev' || key === 'profit' ? short(gv) : Math.round(gv)) + '</text>'; }
        var every = Math.max(1, Math.ceil(pts.length / (W < 500 ? 4 : 8))), xl = '';
        pts.forEach(function (p, idx) { if (idx % every === 0 || idx === pts.length - 1) xl += '<text x="' + X(idx) + '" y="' + (H - 8) + '" class="dp-ax" text-anchor="middle">' + esc(p.label) + '</text>'; });
        var line = pts.map(function (p, idx) { return (idx ? 'L' : 'M') + X(idx).toFixed(1) + ' ' + Y(Math.max(0, p[key])).toFixed(1); }).join(' ');
        var area = line + ' L' + X(pts.length - 1).toFixed(1) + ' ' + Y(0) + ' L' + X(0).toFixed(1) + ' ' + Y(0) + ' Z';
        var dots = pts.map(function (p, idx) {
            var tip = p.long + ' · ' + kes(p.rev) + ' · ' + p.n + ' sale' + (p.n === 1 ? '' : 's') + (p.profitOk ? ' · profit ' + kes(p.profit) : '');
            return '<g class="dp-pt" data-tip="' + esc(tip) + '" tabindex="0"><rect x="' + (X(idx) - Math.max(6, (W - L - R) / pts.length / 2)) + '" y="' + T + '" width="' + Math.max(12, (W - L - R) / pts.length) + '" height="' + (H - T - B) + '" fill="transparent"/><circle cx="' + X(idx).toFixed(1) + '" cy="' + Y(Math.max(0, p[key])).toFixed(1) + '" r="' + (pts.length > 40 ? 0 : 3.5) + '" class="dp-dot"/></g>';
        }).join('');
        return '<svg class="dp-line" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Trend chart">' + grid + xl + '<path d="' + area + '" class="dp-area"/><path d="' + line + '" class="dp-stroke"/>' + dots + '</svg>';
    }
    function barChart(items, opts) {   // items: [{label, value, tip}]
        opts = opts || {};
        if (!items.length || !items.some(function (i) { return i.value > 0; })) return '';
        var W = cwid(640), H = 190, L = 38, R = 8, T = 10, B = 26, mx = niceMax(Math.max.apply(null, items.map(function (i) { return i.value; })));
        var bw = (W - L - R) / items.length, g2 = '', i;
        for (i = 0; i <= 3; i++) { var v = mx * i / 3, y = T + (H - T - B) * (1 - v / mx); g2 += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" class="dp-grid"/><text x="' + (L - 5) + '" y="' + (y + 4) + '" class="dp-ax" text-anchor="end">' + short(v) + '</text>'; }
        var every = Math.max(1, Math.ceil(items.length / (W < 500 ? 6 : 12)));
        var bars = items.map(function (it, idx) {
            var h = (H - T - B) * it.value / mx, x = L + idx * bw + bw * 0.14, w = bw * 0.72, y = T + (H - T - B) - h, hot = opts.hot === idx;
            return '<g class="dp-pt" data-tip="' + esc(it.tip) + '" tabindex="0"><rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(0, h).toFixed(1) + '" rx="3" class="dp-bar' + (hot ? ' hot' : '') + '"/>' + (idx % every === 0 ? '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (H - 8) + '" class="dp-ax" text-anchor="middle">' + esc(it.label) + '</text>' : '') + '<rect x="' + (L + idx * bw) + '" y="' + T + '" width="' + bw + '" height="' + (H - T - B) + '" fill="transparent"/></g>';
        }).join('');
        return '<svg class="dp-line" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opts.label || 'Bar chart') + '">' + g2 + bars + '</svg>';
    }
    function groupedBars(buckets, keys) {   // movement chart: added / sold / adjustments / losses per bucket
        var ks = Object.keys(buckets).sort(); if (!ks.length) return '';
        var series = [['added', 'Added', 'var(--dp-c2)'], ['sold', 'Sold', 'var(--dp-c1)'], ['adj', 'Adjusted', 'var(--dp-c3)'], ['loss', 'Losses', 'var(--dp-c5)']];
        var mx = niceMax(Math.max.apply(null, ks.map(function (k) { return Math.max(buckets[k].added, buckets[k].sold, Math.abs(buckets[k].adj), buckets[k].loss); })));
        var W = cwid(640), H = 190, L = 38, R = 8, T = 10, B = 26, gw = (W - L - R) / ks.length, bw = Math.max(2, gw * 0.8 / 4), out = '';
        for (var i = 0; i <= 3; i++) { var v = mx * i / 3, y = T + (H - T - B) * (1 - v / mx); out += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" class="dp-grid"/><text x="' + (L - 5) + '" y="' + (y + 4) + '" class="dp-ax" text-anchor="end">' + short(v) + '</text>'; }
        var every = Math.max(1, Math.ceil(ks.length / (W < 500 ? 5 : 10)));
        ks.forEach(function (k, gi) {
            var b = buckets[k], tip = keyLabel(k) + ' · added ' + fmtQty(b.added) + ' · sold ' + fmtQty(b.sold) + ' · adjusted ' + fmtQty(b.adj) + ' · losses ' + fmtQty(b.loss);
            out += '<g class="dp-pt" data-tip="' + esc(tip) + '" tabindex="0">';
            series.forEach(function (s, si) { var val = Math.abs(b[s[0]]), h = (H - T - B) * val / mx; out += '<rect x="' + (L + gi * gw + gw * 0.1 + si * bw).toFixed(1) + '" y="' + (T + (H - T - B) - h).toFixed(1) + '" width="' + (bw - 1).toFixed(1) + '" height="' + h.toFixed(1) + '" rx="1.5" fill="' + s[2] + '"/>'; });
            if (gi % every === 0) out += '<text x="' + (L + gi * gw + gw / 2).toFixed(1) + '" y="' + (H - 8) + '" class="dp-ax" text-anchor="middle">' + esc(keyLabel(k)) + '</text>';
            out += '<rect x="' + (L + gi * gw) + '" y="' + T + '" width="' + gw + '" height="' + (H - T - B) + '" fill="transparent"/></g>';
        });
        return '<svg class="dp-line" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Stock movement">' + out + '</svg><div class="dp-legend">' + series.map(function (s) { return '<span><i style="background:' + s[2] + '"></i>' + s[1] + '</span>'; }).join('') + '</div>';
    }
    function donut(slices, centerTop, centerSub) {   // [{label, value, color, extra}]
        var tot = slices.reduce(function (s, x) { return s + x.value; }, 0); if (!(tot > 0)) return '';
        var R = 54, C = 2 * Math.PI * R, off = 0, segs = '';
        slices.forEach(function (s, i) { var len = s.value / tot * C; segs += '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="' + s.color + '" stroke-width="20" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 70 70)" class="dp-slice" data-tip="' + esc(s.label + ' · ' + kes(s.value) + ' · ' + pct(s.value, tot) + '%') + '"/>'; off += len; });
        return '<svg class="dp-donut" viewBox="0 0 140 140" role="img" aria-label="Share chart">' + segs + '<text x="70" y="68" text-anchor="middle" class="dp-dtop">' + esc(centerTop) + '</text><text x="70" y="84" text-anchor="middle" class="dp-dsub">' + esc(centerSub) + '</text></svg>';
    }
    function delta(cur, prev, minPrev) {
        // no comparison when the earlier period has too little to compare against
        if (!(prev > (minPrev || 0))) return null;
        return Math.round((cur - prev) / prev * 1000) / 10;
    }
    function deltaHtml(d, cmp, invert) {
        if (d == null) return '<span class="dp-delta flat">No earlier data to compare</span>';
        var up = d > 0, cls = d === 0 ? 'flat' : ((up !== !!invert) ? 'up' : 'down');
        return '<span class="dp-delta ' + cls + '">' + (d === 0 ? '→' : up ? '↑' : '↓') + ' ' + Math.abs(d) + '% vs ' + esc(cmp) + '</span>';
    }

    /* ---------- widgets ---------- */
    // zip 298: on a phone only the first four sections start open; the rest fold (tap the title) - this page was ~5,000-6,000 px of scrolling
    function foldable(id) { for (var k = 0; k < WIDGETS.length; k++) if (WIDGETS[k][0] === id) return k >= 4 && id !== 'alerts' && id !== 'actions'; return false; }
    function card(id, title, body, extra) {
        return '<section class="dp-card dp-w-' + (extra && extra.span || 6) + (foldable(id) ? ' dp-fold' : '') + '" data-w="' + id + '" style="order:' + orderOf(id) + '"><header class="dp-card-h"><h4>' + title + '</h4>' + ((extra && extra.head) || '') + '</header><div class="dp-card-b">' + body + '</div></section>';
    }
    function empty(msg) { return '<p class="dp-empty">' + esc(msg) + '</p>'; }
    function viewBtn(tab, label) { return '<button type="button" class="dp-link" data-goto="' + tab + '">' + esc(label || 'View report') + ' →</button>'; }
    function orderOf(id) { var i = S.order.indexOf(id); if (i >= 0) return i; for (var k = 0; k < WIDGETS.length; k++) if (WIDGETS[k][0] === id) return 100 + k; return 999; }
    function isAdmin() { try { return typeof isAdminServing === 'function' ? !!isAdminServing() : true; } catch (e) { return true; } }
    function me() { try { return typeof activeServerName === 'function' ? activeServerName() : ''; } catch (e) { return ''; } }

    var W = {};
    W.trend = function (d) {
        var m = S.metric, key = m === 'revenue' ? 'rev' : m === 'profit' ? 'profit' : m === 'txns' ? 'n' : 'items';
        var tabs = [['revenue', 'Revenue'], ['profit', 'Profit'], ['txns', 'Transactions'], ['items', 'Items sold']].filter(function (t) { return t[0] !== 'profit' || d.seriesProfitOk; }).map(function (t) { return '<button type="button" class="dp-seg-btn' + (m === t[0] ? ' on' : '') + '" data-metric="' + t[0] + '">' + t[1] + '</button>'; }).join('');
        if (m === 'profit' && !d.seriesProfitOk) { key = 'rev'; }
        if (m === 'items' && d.perHour) key = 'n';
        var pts = d.series.map(function (p) { return { key: p.key, label: p.label, long: p.long, rev: p.rev, n: p.n, items: p.items, profit: p.profit, profitOk: d.seriesProfitOk }; });
        var chart = lineChart(pts, key);
        return card('trend', 'Sales performance <span class="dp-sub">' + esc(d.range.text) + '</span>', chart ? '<div class="dp-seg">' + tabs + '</div>' + chart + '<p class="dp-note">' + (d.perHour ? 'By hour of the business day.' : d.series.length && d.range.days > 62 ? 'By week.' : 'By day.') + ' Totals match Daily Sales.</p>' : empty('No sales in this period.'), { span: 12, head: viewBtn('reports-tab', 'Sales report') });
    };
    W.profit = function (d) {
        var A = d.A;
        if (!A.count) return card('profit', 'Profitability', empty('No sales in this period.'), { span: 6, head: viewBtn('profits-tab', 'Profit report') });
        if (!d.hasCost) return card('profit', 'Profitability', empty('Profit needs buying prices. Add them to your products to see profit here.'), { span: 6, head: viewBtn('inventory-list-tab', 'Inventory') });
        var gross = A.revenue - A.cogs, margin = pct(gross, A.revenue), net = gross - d.expTotal;
        var mx = Math.max(A.revenue, A.cogs, Math.abs(gross)) || 1;
        var bar = function (label, v, cls) { return '<div class="dp-hb"><span>' + label + '</span><div><i class="' + cls + '" style="width:' + Math.max(2, Math.abs(v) / mx * 100).toFixed(1) + '%"></i></div><b>' + kes(v) + '</b></div>'; };
        var incomplete = A.missingCost > 0 ? '<p class="dp-warn">⚠️ ' + A.missingCost + ' sold line' + (A.missingCost === 1 ? ' has' : 's have') + ' no buying price, so profit may be higher than shown.</p>' : '';
        var rows = [['Gross sales', kes(A.revenue)], ['Cost of goods sold', kes(A.cogs)], ['Gross profit', kes(gross)], ['Profit margin', margin + '%'], ['Expenses', kes(d.expTotal)], ['Net after expenses', kes(net)]];
        return card('profit', 'Profitability', bar('Sales', A.revenue, 'c1') + bar('Cost', A.cogs, 'c5') + bar('Profit', gross, gross >= 0 ? 'c2' : 'c5') + '<table class="dp-mini">' + rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>'; }).join('') + '</table>' + incomplete + '<p class="dp-note">Discounts are already inside the selling prices; returns are listed separately below.</p>', { span: 6, head: viewBtn('profits-tab', 'Profit report') });
    };
    W.top = function (d) {
        var by = S.topBy, list = Object.keys(d.A.item).map(function (k) { var o = d.A.item[k]; return { name: o.name, cat: o.cat, qty: o.qty, rev: o.rev, profit: o.cost > 0 ? o.rev - o.cost : null, img: o.img, unit: o.unit }; });
        if (!list.length) return card('top', 'Top sellers', empty('No sales in this period.'), { span: 6 });
        var val = function (o) { return by === 'qty' ? o.qty : by === 'profit' ? (o.profit == null ? -1e12 : o.profit) : o.rev; };
        list.sort(function (a, b) { return val(b) - val(a); });
        var shown = S.topAll ? list.slice(0, 100) : list.slice(0, 8);
        var tabs = [['revenue', 'Revenue'], ['qty', 'Quantity'], ['profit', 'Profit']].filter(function (t) { return t[0] !== 'profit' || d.hasCost; }).map(function (t) { return '<button type="button" class="dp-seg-btn' + (by === t[0] ? ' on' : '') + '" data-topby="' + t[0] + '">' + t[1] + '</button>'; }).join('');
        var rows = shown.map(function (o, i) {
            var thumb = o.img && /^(data:image\/|https:\/\/)/.test(o.img) ? '<img src="' + esc(o.img) + '" alt="" loading="lazy">' : '<span>' + esc((o.name || '?').charAt(0).toUpperCase()) + '</span>';
            return '<li data-search="' + esc(o.name) + '"><em class="dp-rank">#' + (i + 1) + '</em><div class="dp-thumb">' + thumb + '</div><div class="dp-li-main"><b>' + esc(o.name) + '</b><small>' + esc(o.cat) + ' · ' + fmtQty(o.qty) + ' sold</small></div><div class="dp-li-val"><b>' + kes(o.rev) + '</b>' + (d.hasCost && o.profit != null ? '<small>profit ' + kes(o.profit) + '</small>' : '') + '</div></li>';
        }).join('');
        return card('top', 'Top sellers', '<div class="dp-seg">' + tabs + '</div><ul class="dp-list">' + rows + '</ul>' + (list.length > 8 ? '<button type="button" class="dp-more" data-topall="1">' + (S.topAll ? 'Show top 8' : 'View all ' + list.length + ' products') + '</button>' : ''), { span: 6 });
    };
    W.category = function (d) {
        var cats = Object.keys(d.A.cat).map(function (k) { return { name: k, rev: d.A.cat[k].rev, qty: d.A.cat[k].qty }; }).sort(function (a, b) { return b.rev - a.rev; });
        if (!cats.length) return card('category', 'Sales by category', empty('No sales in this period.'), { span: 6 });
        var tot = cats.reduce(function (s, c) { return s + c.rev; }, 0), body;
        if (cats.length <= 6) {
            body = '<div class="dp-donut-wrap">' + donut(cats.map(function (c, i) { return { label: c.name, value: c.rev, color: COLORS[i % 6] }; }), short(tot), 'product sales') + '<ul class="dp-key">' + cats.map(function (c, i) { return '<li><i style="background:' + COLORS[i % 6] + '"></i><span>' + esc(c.name) + '</span><b>' + pct(c.rev, tot) + '%</b><small>' + kes(c.rev) + ' · ' + fmtQty(c.qty) + ' items</small></li>'; }).join('') + '</ul></div>';
        } else {
            var mx = cats[0].rev || 1;
            body = '<ul class="dp-bars">' + cats.slice(0, 10).map(function (c) { return '<li><span>' + esc(c.name) + '</span><div><i style="width:' + Math.max(2, c.rev / mx * 100).toFixed(1) + '%"></i></div><b>' + pct(c.rev, tot) + '%</b><small>' + kes(c.rev) + '</small></li>'; }).join('') + '</ul>' + (cats.length > 10 ? '<p class="dp-note">+ ' + (cats.length - 10) + ' smaller categories</p>' : '');
        }
        return card('category', 'Sales by category', body + '<p class="dp-note">Product lines only (delivery fees and bill instalments are not in a category).</p>', { span: 6 });
    };
    W.inventory = function (d) {
        if (d.noStock) return card('inventory', 'Inventory health', empty('Stock is not tracked here: this app sells services, so there are no stock levels to show.'), { span: 6 });
        if (!d.rows.length) return card('inventory', 'Inventory health', empty('No inventory data yet.'), { span: 6, head: viewBtn('inventory-list-tab', 'Inventory') });
        var fast = Object.keys(d.A.item).map(function (k) { return d.A.item[k]; }).sort(function (a, b) { return b.qty - a.qty; }).slice(0, 3).map(function (o) { return o.name; });
        var stats = [['Products', d.rows.length], ['Units in stock', fmtQty(d.units)], ['Stock value (cost)', kes(d.invValue)], ['Low stock', d.low.length], ['Out of stock', d.out.length], ['Slow-moving', d.slow.length]];
        var restocked = Object.keys(d.restocked).slice(0, 4);
        return card('inventory', 'Inventory health', '<div class="dp-stats">' + stats.map(function (s) { return '<div><b>' + s[1] + '</b><small>' + s[0] + '</small></div>'; }).join('') + '</div>'
            + (fast.length ? '<p class="dp-row"><b>Fast-moving:</b> ' + fast.map(esc).join(', ') + '</p>' : '')
            + (restocked.length ? '<p class="dp-row"><b>Recently restocked:</b> ' + restocked.map(esc).join(', ') + '</p>' : '')
            + (d.low.length ? '<details class="dp-det"><summary>Low stock (' + d.low.length + ')</summary><ul class="dp-plain">' + d.low.slice(0, 8).map(function (r) { return '<li>' + esc(r.name) + ' <b>' + fmtQty(r.qty) + '</b></li>'; }).join('') + '</ul></details>' : '')
            + (d.out.length ? '<details class="dp-det"><summary>Out of stock (' + d.out.length + ')</summary><ul class="dp-plain">' + d.out.slice(0, 8).map(function (r) { return '<li>' + esc(r.name) + '</li>'; }).join('') + '</ul></details>' : ''), { span: 6, head: viewBtn('inventory-list-tab', 'Inventory') });
    };
    function whenTxt(dl) { return dl < 0 ? 'expired ' + Math.abs(dl) + 'd ago' : dl === 0 ? 'expires today' : 'in ' + dl + 'd'; }
    W.expiry = function (d) {
        var x = d.expiry; if (!x) return '';
        if (!x.withDates) return card('expiry', 'Expiry watch', empty('No stock with expiry dates yet.'), { span: 6, head: viewBtn('inventory-list-tab', 'Inventory') });
        var list = function (l, t) { return l.length ? '<details class="dp-det"' + (t === 'Expired' ? ' open' : '') + '><summary>' + t + ' (' + l.length + ')</summary><ul class="dp-plain">' + l.slice(0, 8).map(function (r) { return '<li>' + esc(r.name) + (r.batch ? ' <small>batch ' + esc(r.batch) + '</small>' : '') + ' <b>' + fmtQty(r.qty) + '</b> <small>' + whenTxt(r.days) + '</small></li>'; }).join('') + (l.length > 8 ? '<li><small>+ ' + (l.length - 8) + ' more</small></li>' : '') + '</ul></details>' : ''; };
        var stats = [['Expired', x.expired.length], ['Expiring within ' + x.warn + ' days', x.soon.length], ['Expired stock at cost', x.valueExpired > 0 ? kes(x.valueExpired) : '—']];
        return card('expiry', 'Expiry watch', '<div class="dp-stats">' + stats.map(function (s) { return '<div><b>' + s[1] + '</b><small>' + s[0] + '</small></div>'; }).join('') + '</div>'
            + (!x.expired.length && !x.soon.length ? '<p class="dp-empty">Nothing in stock is expired or within ' + x.warn + ' days of expiry.</p>' : '') + list(x.expired, 'Expired') + list(x.soon, 'Expiring soon')
            + '<p class="dp-note">Counted per batch where batches are tracked. Warning window is set in Settings.</p>', { span: 6, head: viewBtn('inventory-list-tab', 'Inventory') });
    };
    W.production = function (d) {
        var x = d.prod; if (!x) return '';
        if (!x.runs && !x.can.length) return card('production', 'Production', empty(x.ever ? 'No production recorded in this period.' : 'No production recorded yet.'), { span: 6, head: viewBtn('production-tab', 'Production') });
        var li = function (l, f) { return '<ul class="dp-plain">' + l.slice(0, 6).map(f).join('') + '</ul>'; };
        return card('production', 'Production', '<div class="dp-stats"><div><b>' + x.runs + '</b><small>Production runs</small></div><div><b>' + fmtQty(x.units) + '</b><small>Units produced</small></div><div><b>' + x.used.length + '</b><small>Materials used</small></div></div>'
            + (x.made.length ? '<p class="dp-row"><b>Most produced</b></p>' + li(x.made, function (o) { return '<li>' + esc(o.name) + ' <b>' + fmtQty(o.qty) + '</b></li>'; }) : '')
            + (x.used.length ? '<details class="dp-det"><summary>Materials used (' + x.used.length + ')</summary>' + li(x.used, function (o) { return '<li>' + esc(o.name) + ' <b>' + fmtQty(o.qty) + '</b></li>'; }) + '</details>' : '')
            + (x.can.length ? '<details class="dp-det"><summary>Can make now (' + x.can.length + ' produced item' + (x.can.length === 1 ? '' : 's') + ', fewest first)</summary>' + li(x.can, function (o) { return '<li>' + esc(o.name) + ' <b>' + fmtQty(o.n) + '</b></li>'; }) + '</details>' : '')
            + '<p class="dp-note">Runs are recorded when a produced item is sold, so they follow your sales. "Can make now" is how many the materials on hand allow.</p>', { span: 6, head: viewBtn('production-tab', 'Production') });
    };
    W.slow = function (d) {
        if (d.noStock) return card('slow', 'Slow-moving stock', empty('Stock is not tracked here: this app sells services, so there are no stock levels to show.'), { span: 6 });
        if (!d.rows.length) return card('slow', 'Slow-moving stock', empty('No inventory data yet.'), { span: 6 });
        if (!d.slow.length) return card('slow', 'Slow-moving stock', empty(d.A.count ? 'Every product in stock sold at least once in this period.' : 'No sales in this period to compare against.'), { span: 6 });
        return card('slow', 'Slow-moving stock', '<p class="dp-note" style="margin-top:0">In stock but <b>no sales in this period</b>. Biggest tied-up value first.</p><div class="dp-tbl"><table><thead><tr><th>Product</th><th>In stock</th><th>Value</th><th>Last sale</th></tr></thead><tbody>' + d.slow.slice(0, 8).map(function (r) { return '<tr><td>' + esc(r.name) + '</td><td>' + fmtQty(r.qty) + '</td><td>' + (r.value > 0 ? kes(r.value) : '—') + '</td><td>' + (r.last ? new Date(r.last).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'No sale on record') + '</td></tr>'; }).join('') + '</tbody></table></div>' + (d.slow.length > 8 ? '<p class="dp-note">+ ' + (d.slow.length - 8) + ' more</p>' : ''), { span: 6, head: viewBtn('reports-tab', 'Stock report') });
    };
    W.movement = function (d) {
        if (d.noStock) return card('movement', 'Stock movement', empty('Stock is not tracked here: this app sells services, so there are no stock levels to show.'), { span: 12 });
        var m = d.movement; if (!m.count) return card('movement', 'Stock movement', empty('No stock movements recorded in this period.'), { span: 12 });
        return card('movement', 'Stock movement <span class="dp-sub">' + esc(d.range.text) + '</span>', groupedBars(m.buckets) + '<div class="dp-stats"><div><b>' + fmtQty(m.added) + '</b><small>Added</small></div><div><b>' + fmtQty(m.sold) + '</b><small>Sold</small></div><div><b>' + (m.adj > 0 ? '+' : '') + fmtQty(m.adj) + '</b><small>Net adjustments</small></div><div><b>' + fmtQty(m.loss) + '</b><small>Losses / damages</small></div></div><p class="dp-note">' + (m.weekly ? 'By week. ' : 'By day. ') + 'Units, from the stock movement log.</p>', { span: 12 });
    };
    W.staff = function (d) {
        var rows = d.staffRows.slice();
        if (!isAdmin()) { var mine = me(); rows = rows.filter(function (r) { return r.name === mine; }); }
        if (!rows.length) return card('staff', 'Staff performance', empty('No staff activity for this period.'), { span: 12 });
        var by = S.staffBy, val = function (r) { return by === 'n' ? r.n : by === 'items' ? r.items : by === 'avg' ? r.avg : r.rev; };
        rows.sort(function (a, b) { return val(b) - val(a); });
        var tabs = [['revenue', 'Sales'], ['n', 'Transactions'], ['items', 'Items sold'], ['avg', 'Avg sale']].map(function (t) { return '<button type="button" class="dp-seg-btn' + ((by === t[0] || (by === 'revenue' && t[0] === 'revenue')) ? ' on' : '') + '" data-staffby="' + t[0] + '">' + t[1] + '</button>'; }).join('');
        var label = { revenue: 'Sales generated', n: 'Transactions', items: 'Items sold', avg: 'Average sale' }[by] || 'Sales generated';
        var mx = Math.max.apply(null, rows.map(val)) || 1;
        var ini = function (n) { return esc(String(n || '?').trim().split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase()); };
        return card('staff', 'Staff performance <span class="dp-sub">ranked by ' + label.toLowerCase() + '</span>', '<div class="dp-seg">' + tabs + '</div><ul class="dp-list">' + rows.slice(0, 12).map(function (r, i) {
            return '<li><em class="dp-rank">#' + (i + 1) + '</em><div class="dp-avatar">' + ini(r.name) + '</div><div class="dp-li-main"><b>' + esc(r.name) + '</b><small>' + r.n + ' sales · ' + fmtQty(r.items) + ' items · avg ' + kes(r.avg) + (r.last ? ' · last sale ' + new Date(r.last).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '') + '</small><div class="dp-meter"><i style="width:' + Math.max(2, val(r) / mx * 100).toFixed(1) + '%"></i></div></div><div class="dp-li-val"><b>' + (by === 'n' || by === 'items' ? fmtQty(val(r)) : kes(val(r))) + '</b></div></li>';
        }).join('') + '</ul><p class="dp-note">' + (isAdmin() ? 'Everyone who recorded a sale in this period, from every device.' : 'You can see your own figures only.') + '</p>', { span: 12, head: isAdmin() ? viewBtn('staff-tab', 'Staff') : '' });
    };
    W.payments = function (d) {
        var m = d.A.method, names = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', other: 'Other' }, list = Object.keys(m).filter(function (k) { return m[k].amt > 0; }).map(function (k) { return { k: k, name: names[k], amt: m[k].amt, n: m[k].n }; }).sort(function (a, b) { return b.amt - a.amt; });
        var credit = d.A.unpaid;
        if (!list.length && !credit) return card('payments', 'Payment methods', empty('No sales in this period.'), { span: 6 });
        var tot = list.reduce(function (s, x) { return s + x.amt; }, 0);
        return card('payments', 'Payment methods', '<div class="dp-donut-wrap">' + donut(list.map(function (x, i) { return { label: x.name, value: x.amt, color: COLORS[i % 6] }; }), short(tot), 'received') + '<ul class="dp-key">' + list.map(function (x, i) { return '<li><i style="background:' + COLORS[i % 6] + '"></i><span>' + x.name + '</span><b>' + pct(x.amt, tot) + '%</b><small>' + kes(x.amt) + ' · ' + x.n + ' payment' + (x.n === 1 ? '' : 's') + '</small></li>'; }).join('') + '</ul></div>' + (credit > 0 ? '<p class="dp-row"><b>Credit / unpaid sales:</b> ' + kes(credit) + ' (' + d.A.unpaidCount + ') — not yet received, so not in the figures above.</p>' : ''), { span: 6, head: viewBtn('daily-sales-tab', 'Daily sales') });
    };
    W.hours = function (d) {
        if (!d.A.count) return card('hours', 'Busiest hours', empty('No sales in this period.'), { span: 6 });
        var items = d.A.hour.map(function (x, h) { return { label: (h % 12 || 12) + (h < 12 ? 'a' : 'p'), value: x.rev, tip: pad(h) + ':00–' + pad(h) + ':59 · ' + kes(x.rev) + ' · ' + x.n + ' sale' + (x.n === 1 ? '' : 's') }; });
        var first = 0, last = 23; while (first < 23 && !d.A.hour[first].n) first++; while (last > 0 && !d.A.hour[last].n) last--;
        items = items.slice(Math.max(0, first - 1), Math.min(24, last + 2));
        var peak = d.peakHour >= 0 && d.A.count >= 5 ? '<p class="dp-row"><b>Peak sales period:</b> ' + pad(d.peakHour) + ':00–' + pad(d.peakHour) + ':59 (' + kes(d.peakVal) + ', ' + d.A.hour[d.peakHour].n + ' sales)</p>' : '';
        return card('hours', 'Busiest hours', barChart(items, { label: 'Sales by hour', hot: items.findIndex(function (i) { return i.value === d.peakVal; }) }) + peak, { span: 6 });
    };
    W.days = function (d) {
        if (d.range.days < 3 || !d.A.count) return card('days', 'Sales by weekday', empty(d.A.count ? 'Pick a longer period (a week or more) to compare weekdays.' : 'No sales in this period.'), { span: 6 });
        var nm = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], full = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        return card('days', 'Sales by weekday', barChart(d.A.dow.map(function (x, i) { return { label: nm[i], value: x.rev, tip: full[i] + ' · ' + kes(x.rev) + ' · ' + x.n + ' sale' + (x.n === 1 ? '' : 's') }; }), { label: 'Sales by weekday', hot: d.bestDow }) + (d.bestDow >= 0 ? '<p class="dp-row"><b>Best day:</b> ' + full[d.bestDow] + ' (' + kes(d.bestDowVal) + ')</p>' : ''), { span: 6 });
    };
    W.customers = function (d) {
        if (!d.custTotal) return card('customers', 'Customers', empty('No customer data yet.'), { span: 6, head: viewBtn('customers-tab', 'Customers') });
        var stats = [['Total customers', d.custTotal], ['New in period', d.newCust], ['Bought in period', d.known], ['Returning', d.returning], ['Avg spend', d.known ? kes(d.custSpend / d.known) : '—']];
        return card('customers', 'Customers', '<div class="dp-stats">' + stats.map(function (s) { return '<div><b>' + s[1] + '</b><small>' + s[0] + '</small></div>'; }).join('') + '</div>'
            + (isAdmin() && d.topCust.length ? '<h5>Top customers by spend</h5><ul class="dp-plain">' + d.topCust.map(function (c) { return '<li>' + esc(c.name) + ' <b>' + kes(c.rev) + '</b></li>'; }).join('') + '</ul>' : '')
            + (d.recentCust.length ? '<h5>Recently added</h5><ul class="dp-plain">' + d.recentCust.map(function (c) { return '<li>' + esc(c.name || c.phone || '—') + '</li>'; }).join('') + '</ul>' : ''), { span: 6, head: viewBtn('customers-tab', 'Customers') });
    };
    W.credit = function (d) {
        if (!d.billCount && !d.debtOwed && !d.A.unpaid) return card('credit', 'Credit & debts', empty('No outstanding credit.'), { span: 6, head: viewBtn('bills-tab', 'Bills') });
        var total = d.billOwed + d.debtOwed;
        var rows = function (list, f) { return list.length ? '<ul class="dp-plain">' + list.map(f).join('') + '</ul>' : ''; };
        return card('credit', 'Credit & debts', '<button type="button" class="dp-big" data-goto="bills-tab"><b>' + kes(total) + '</b><span>outstanding credit · ' + d.owingCustomers + ' customer' + (d.owingCustomers === 1 ? '' : 's') + ' owe</span></button>'
            + '<div class="dp-stats"><div><b>' + kes(d.billOwed) + '</b><small>Open bills (' + d.billCount + ')</small></div><div><b>' + kes(d.debtOwed) + '</b><small>Debts</small></div><div><b>' + d.overdue.length + '</b><small>Overdue bills</small></div></div>'
            + (d.recentCredit.length ? '<h5>Recent credit bills</h5>' + rows(d.recentCredit, function (b) { return '<li>' + esc(b.customerName || 'Customer') + ' <b>' + kes(typeof billTotalOf === 'function' ? billTotalOf(b) : 0) + '</b></li>'; }) : '')
            + (d.recentPaid.length ? '<h5>Recent bill payments</h5>' + rows(d.recentPaid, function (s) { return '<li>' + esc(s.customerName || 'Customer') + ' <b>' + kes(saleTotalOf(s)) + '</b></li>'; }) : ''), { span: 6, head: viewBtn('debts-tab', 'Debts') });
    };
    W.expenses = function (d) {
        if (!d.exp.length) return card('expenses', 'Expenses', empty('No expenses recorded in this period.'), { span: 6, head: viewBtn('profits-tab', 'Expenses') });
        var cats = Object.keys(d.expCat).map(function (k) { return { k: k, v: d.expCat[k] }; }).sort(function (a, b) { return b.v - a.v; });
        var big = d.exp.slice().sort(function (a, b) { return n0(b.amount) - n0(a.amount); }).slice(0, 4);
        var mx = cats[0].v || 1;
        return card('expenses', 'Expenses', '<div class="dp-stats"><div><b>' + kes(d.expTotal) + '</b><small>Total expenses</small></div><div><b>' + (d.A.revenue > 0 ? pct(d.expTotal, d.A.revenue) + '%' : '—') + '</b><small>of sales</small></div><div>' + deltaHtml(delta(d.expTotal, d.expPrevTotal, 0), d.range.cmp, true) + '</div></div><h5>Top expense categories</h5><ul class="dp-bars">' + cats.slice(0, 5).map(function (c) { return '<li><span>' + esc(c.k) + '</span><div><i style="width:' + Math.max(2, c.v / mx * 100).toFixed(1) + '%"></i></div><b>' + pct(c.v, d.expTotal) + '%</b><small>' + kes(c.v) + '</small></li>'; }).join('') + '</ul><h5>Largest expenses</h5><ul class="dp-plain">' + big.map(function (e) { return '<li>' + esc((e.category || 'Other') + (e.description ? ' · ' + e.description : '')) + ' <b>' + kes(e.amount) + '</b></li>'; }).join('') + '</ul>', { span: 6, head: viewBtn('profits-tab', 'Expenses') });
    };
    W.returns = function (d) {
        if (!d.rets.length) return card('returns', 'Returns', empty('No returns in this period.'), { span: 6, head: viewBtn('returns-tab', 'Returns') });
        var prod = Object.keys(d.retProd).map(function (k) { return [k, d.retProd[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 4);
        var units = d.rets.reduce(function (s, r) { return s + n0(r.qty); }, 0);
        return card('returns', 'Returns', '<div class="dp-stats"><div><b>' + d.rets.length + '</b><small>Returns</small></div><div><b>' + fmtQty(units) + '</b><small>Units returned</small></div>' + (d.refundKnown ? '<div><b>' + kes(d.refundAmt) + '</b><small>Refunded</small></div>' : '') + '</div><h5>Most returned</h5><ul class="dp-plain">' + prod.map(function (p) { return '<li>' + esc(p[0]) + ' <b>×' + fmtQty(p[1]) + '</b></li>'; }).join('') + '</ul>', { span: 6, head: viewBtn('returns-tab', 'Returns') });
    };
    D.insights = function (d) {
        var out = [], A = d.A, P = d.P;
        var dl = delta(A.revenue, P.revenue, 0);
        if (dl != null && A.count >= 3) out.push([dl >= 0 ? '📈' : '📉', 'Sales are ' + (dl >= 0 ? 'up ' : 'down ') + Math.abs(dl) + '% compared with ' + d.range.cmp + ' (' + kes(A.revenue) + ' vs ' + kes(P.revenue) + ').']);
        var cats = Object.keys(A.cat).map(function (k) { return [k, A.cat[k].rev]; }).sort(function (a, b) { return b[1] - a[1]; }), ct = cats.reduce(function (s, c) { return s + c[1]; }, 0);
        if (cats.length >= 2 && ct > 0) out.push(['🏷️', cats[0][0] + ' generated ' + Math.round(cats[0][1] / ct * 100) + '% of product sales.']);
        if (d.peakHour >= 0 && A.count >= 8) out.push(['⏰', 'Your busiest sales hour was ' + pad(d.peakHour) + ':00–' + pad(d.peakHour) + ':59 (' + A.hour[d.peakHour].n + ' sales).']);
        var items = Object.keys(A.item).map(function (k) { return A.item[k].rev; }).sort(function (a, b) { return b - a; }), it = items.reduce(function (s, v) { return s + v; }, 0);
        if (items.length >= 8 && it > 0) { var run = 0, k = 0; while (k < items.length && run / it < 0.5) { run += items[k++]; } out.push(['🎯', k + ' of ' + items.length + ' products brought in half of product sales.']); }
        if (d.slow.length && A.count >= 5) out.push(['🐢', d.slow.length + ' product' + (d.slow.length === 1 ? ' has' : 's have') + ' stock but no sales in this period.']);
        var cash = A.method.cash.n, allN = A.method.cash.n + A.method.mpesa.n + A.method.card.n + A.method.other.n;
        if (allN >= 10) out.push(['💳', 'Cash was ' + Math.round(cash / allN * 100) + '% of payments, M-Pesa ' + Math.round(A.method.mpesa.n / allN * 100) + '%.']);
        if (d.hasCost && A.revenue > 0) { var mg = pct(A.revenue - A.cogs, A.revenue), pm = P.revenue > 0 ? pct(P.revenue - P.cogs, P.revenue) : null; out.push(['💰', 'Gross margin was ' + mg + '%' + (pm != null && P.count >= 3 ? ' (' + (mg >= pm ? 'up from ' : 'down from ') + pm + '% in ' + d.range.cmp + ')' : '') + '.']); }
        if (d.billOwed + d.debtOwed > 0 && A.revenue > 0) out.push(['🧾', kes(d.billOwed + d.debtOwed) + ' is owed to you in unpaid bills and debts.']);
        return out;
    };
    W.insights = function (d) {
        var ins = D.insights(d);
        return card('insights', 'Business insights', ins.length ? '<ul class="dp-ins">' + ins.map(function (i) { return '<li><span>' + i[0] + '</span>' + esc(i[1]) + '</li>'; }).join('') + '</ul><p class="dp-note">Worked out from your own records for ' + esc(d.range.text) + '; shown only when there is enough data.</p>' : empty('Not enough sales in this period to say anything useful yet.'), { span: 6 });
    };
    D.alerts = function (d) {
        var a = [];
        if (d.out.length) a.push({ p: 1, icon: '⛔', text: d.out.length + ' product' + (d.out.length === 1 ? ' is' : 's are') + ' out of stock', tab: 'inventory-list-tab' });
        if (d.low.length) a.push({ p: 2, icon: '🔔', text: d.low.length + ' product' + (d.low.length === 1 ? ' is' : 's are') + ' low on stock', tab: 'inventory-list-tab' });
        if (d.expiry && d.expiry.expired.length) a.push({ p: 1, icon: '☠️', text: d.expiry.expired.length + ' batch' + (d.expiry.expired.length === 1 ? ' is' : 'es are') + ' past expiry and still in stock', tab: 'inventory-list-tab' });
        if (d.expiry && d.expiry.soon.length) a.push({ p: 2, icon: '⏰', text: d.expiry.soon.length + ' batch' + (d.expiry.soon.length === 1 ? '' : 'es') + ' expire within ' + d.expiry.warn + ' days', tab: 'inventory-list-tab' });
        if (d.prod && d.prod.can.some(function (c) { return c.n <= 0; })) { var nz = d.prod.can.filter(function (c) { return c.n <= 0; }).length; a.push({ p: 3, icon: '🏭', text: nz + ' produced item' + (nz === 1 ? ' cannot' : 's cannot') + ' be made right now (a material is out of stock)', tab: 'inventory-list-tab' }); }
        if (d.overdue.length) a.push({ p: 1, icon: '⏳', text: d.overdue.length + ' open bill' + (d.overdue.length === 1 ? ' is' : 's are') + ' past the due date', tab: 'bills-tab' });
        if (d.billOwed + d.debtOwed > 0) a.push({ p: 3, icon: '🧾', text: 'Outstanding credit: ' + kes(d.billOwed + d.debtOwed) + ' from ' + d.owingCustomers + ' customer' + (d.owingCustomers === 1 ? '' : 's'), tab: 'bills-tab' });
        if (d.A.unpaidCount) a.push({ p: 3, icon: '⌛', text: d.A.unpaidCount + ' sale' + (d.A.unpaidCount === 1 ? ' is' : 's are') + ' marked unpaid (' + kes(d.A.unpaid) + ')', tab: 'daily-sales-tab' });
        if (d.noCost.length) a.push({ p: 4, icon: '🏷️', text: d.noCost.length + ' product' + (d.noCost.length === 1 ? ' has' : 's have') + ' stock but no buying price, so profit is incomplete', tab: 'inventory-list-tab' });
        if (d.slow.length && d.A.count >= 5) a.push({ p: 4, icon: '🐢', text: d.slow.length + ' product' + (d.slow.length === 1 ? ' has' : 's have') + ' had no sales in this period', tab: 'inventory-list-tab' });
        try { if (typeof hasUnsyncedWork === 'function' && hasUnsyncedWork()) a.push({ p: 2, icon: '🔄', text: 'Some changes on this device have not reached the server yet', tab: null }); } catch (e) { /* none */ }
        try { var pend = arr(g('orders')).length; } catch (e) { /* none */ }
        a.sort(function (x, y) { return x.p - y.p; });
        return a;
    };
    W.alerts = function (d) {
        var al = D.alerts(d);
        return card('alerts', 'Needs attention', al.length ? '<ul class="dp-alerts">' + al.map(function (x) { return '<li class="p' + x.p + '">' + (x.tab ? '<button type="button" data-goto="' + x.tab + '">' : '<div>') + '<span>' + x.icon + '</span>' + esc(x.text) + (x.tab ? ' <em>→</em></button>' : '</div>') + '</li>'; }).join('') + '</ul>' : '<p class="dp-ok">✅ Nothing needs your attention right now.</p>', { span: 6 });
    };
    W.activity = function (d) {
        if (!d.recent.length) return card('activity', 'Recent activity', empty('No activity yet.'), { span: 6 });
        return card('activity', 'Recent activity', '<ul class="dp-feed">' + d.recent.map(function (e) { return '<li><button type="button" data-goto="' + e.tab + '"><span class="dp-fi">' + e.icon + '</span><div><b>' + esc(e.what) + (e.amt != null ? ' · ' + kes(e.amt) : '') + '</b><small>' + esc(e.detail) + (e.who ? ' · ' + esc(e.who) : '') + '</small></div><time>' + esc(ago(e.t)) + '</time></button></li>'; }).join('') + '</ul>', { span: 6 });
    };
    function ago(t) { var s = Math.max(0, (Date.now() - t) / 1000); if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; if (s < 604800) return Math.floor(s / 86400) + 'd'; return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
    W.actions = function () {
        var acts = [['🛒', 'New sale', 'sales-tab'], ['➕', 'Add product', 'inventory-list-tab'], ['📦', 'Add stock', 'restock-tab'], ['👤', 'Add customer', 'customers-tab'], ['💸', 'Add expense', 'profits-tab'], ['👥', 'Add staff', 'staff-tab'], ['📈', 'View reports', 'reports-tab'], ['🚚', 'View orders', 'orders-tab']];
        var html = acts.map(function (a) { var b = document.querySelector('.tabs .tab-link[data-tab="' + a[2] + '"]'); if (!b || b.style.display === 'none' || (a[2] === 'staff-tab' && !isAdmin())) return ''; return '<button type="button" class="dp-qa" data-goto="' + a[2] + '"><span>' + a[0] + '</span>' + a[1] + '</button>'; }).join('');
        return card('actions', 'Quick actions', html ? '<div class="dp-qas">' + html + '</div>' : empty('No shortcuts available for this account.'), { span: 12 });
    };

    /* ---------- page ---------- */
    function kpis(d) {
        var A = d.A, P = d.P, c = d.range.cmp, ser = d.series.map(function (p) { return p.rev; });
        var avg = A.count ? A.revenue / A.count : 0, pavg = P.count ? P.revenue / P.count : 0;
        var gross = A.revenue - A.cogs, pgross = P.revenue - P.cogs;
        var list = [];
        list.push(['💰', d.range.label === 'Today' ? "Today's sales" : 'Sales', kes(A.revenue), deltaHtml(delta(A.revenue, P.revenue, 0), c), spark(ser)]);
        list.push(['🧾', 'Transactions', A.count.toLocaleString('en-US'), deltaHtml(delta(A.count, P.count, 0), c), spark(d.series.map(function (p) { return p.n; }), 'var(--dp-c4)')]);
        list.push(['📊', 'Average sale', A.count ? kes(avg) : '—', A.count && P.count ? deltaHtml(delta(avg, pavg, 0), c) : '<span class="dp-delta flat">No earlier data to compare</span>', '']);
        list.push(['🛍️', 'Items sold', fmtQty(A.items), deltaHtml(delta(A.items, P.items, 0), c), '']);
        if (d.hasCost) {
            list.push(['📈', 'Gross profit', kes(gross), deltaHtml(delta(gross, pgross, 0), c), d.seriesProfitOk ? spark(d.series.map(function (p) { return p.profit; }), 'var(--dp-c2)') : '']);
            list.push(['🎯', 'Profit margin', pct(gross, A.revenue) + '%', P.revenue > 0 && P.count ? deltaHtml(Math.round((pct(gross, A.revenue) - pct(pgross, P.revenue)) * 10) / 10 || 0, c).replace('%', ' pts') : '<span class="dp-delta flat">No earlier data to compare</span>', '']);
            list.push(['🏭', 'Cost of goods', kes(A.cogs), deltaHtml(delta(A.cogs, P.cogs, 0), c, true), '']);
        } else list.push(['📈', 'Gross profit', 'No data', '<span class="dp-delta flat">Add buying prices to see profit</span>', '']);
        list.push(['💸', 'Expenses', kes(d.expTotal), deltaHtml(delta(d.expTotal, d.expPrevTotal, 0), c, true), '']);
        if (!d.noStock) list.push(['📦', 'Stock value', kes(d.invValue), '<span class="dp-delta flat">' + d.rows.length + ' products · ' + d.low.length + ' low · ' + d.out.length + ' out</span>', '']);
        list.push(['🧾', 'Owed to you', kes(d.billOwed + d.debtOwed), '<span class="dp-delta flat">' + d.owingCustomers + ' customer' + (d.owingCustomers === 1 ? '' : 's') + '</span>', '']);
        if (d.custTotal) list.push(['👤', 'Customers', String(d.custTotal), '<span class="dp-delta flat">' + d.newCust + ' new · ' + d.returning + ' returning</span>', '']);
        return '<div class="dp-kpis">' + list.map(function (k) { return '<div class="dp-kpi"><div class="dp-kpi-top"><span class="dp-ico">' + k[0] + '</span><span class="dp-kpi-l">' + k[1] + '</span></div><div class="dp-kpi-v">' + k[2] + '</div>' + k[3] + k[4] + '</div>'; }).join('') + '</div>';
    }
    function header(range) {
        var biz = typeof g('businessName') === 'string' ? g('businessName') : '', now = new Date();
        var chips = PRESETS.map(function (p) { return '<button type="button" class="dp-chip' + (S.preset === p[0] ? ' on' : '') + '" data-preset="' + p[0] + '">' + p[1] + '</button>'; }).join('');
        var custom = S.preset === 'custom' ? '<div class="dp-custom"><input type="date" id="dp-from" value="' + esc(S.from || range.fromKey) + '" aria-label="From"><span>to</span><input type="date" id="dp-to" value="' + esc(S.to || range.toKey) + '" aria-label="To"><button type="button" class="dp-chip on" data-applycustom="1">Apply</button></div>' : '';
        return '<div class="dp-head"><div><h3>' + esc(biz || 'Business') + '</h3><p>' + now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ' · <span id="dp-clock">' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '</span>' + (me() ? ' · 👤 ' + esc(me()) : '') + '</p></div><div class="dp-tools"><button type="button" class="dp-btn" data-act="refresh" title="Refresh">🔄 Refresh</button><button type="button" class="dp-btn" data-act="export" title="Download a CSV of these figures">⬇️ Export</button>' + (isAdmin() ? '<button type="button" class="dp-btn" data-act="customize">⚙️ Customize</button>' : '') + '</div></div>'
            + '<div class="dp-chips" role="tablist">' + chips + '</div>' + custom + '<p class="dp-range">Showing <b>' + esc(range.text) + '</b>' + (range.label !== 'Custom' ? ' · compared with ' + esc(range.cmp) : '') + '</p>';
    }
    function customizePanel() {
        return '<div class="dp-panel" id="dp-panel"><div class="dp-panel-h"><b>Customize dashboard</b><button type="button" data-act="closepanel">✕</button></div><p class="dp-note" style="margin-top:0">Show or hide sections and change their order. Saved on this device.</p>' + ordered().map(function (w, i, a) { return '<div class="dp-prow"><label><input type="checkbox" data-wtoggle="' + w[0] + '"' + (S.hidden[w[0]] ? '' : ' checked') + '> ' + esc(w[1]) + '</label><span><button type="button" data-wmove="' + w[0] + ':-1"' + (i === 0 ? ' disabled' : '') + '>▲</button><button type="button" data-wmove="' + w[0] + ':1"' + (i === a.length - 1 ? ' disabled' : '') + '>▼</button></span></div>'; }).join('') + '<button type="button" class="dp-btn" data-act="resetlayout">Reset layout</button></div>';
    }
    function ordered() { return WIDGETS.slice().sort(function (a, b) { return orderOf(a[0]) - orderOf(b[0]); }); }

    var lastData = null, root = null, drawTimer = 0;
    function widgetHtml(id, d) { try { return W[id](d); } catch (e) { try { console.error('dashboard widget ' + id, e); } catch (e2) { /* none */ } return '<section class="dp-card dp-w-6" data-w="' + id + '" style="order:' + orderOf(id) + '"><header class="dp-card-h"><h4>' + esc((WIDGETS.filter(function (w) { return w[0] === id; })[0] || [0, id])[1]) + '</h4></header><div class="dp-card-b"><p class="dp-empty">This section could not load.</p><button type="button" class="dp-btn" data-retry="' + id + '">Try again</button></div></section>'; } }
    D.render = function () {
        root = document.getElementById('dash-pro-root'); if (!root) return;
        var tab = document.getElementById('dashboard-tab'); if (tab && !tab.classList.contains('active') && !D.force) return;
        var range = D.rangeFor(S.preset, S.from, S.to);
        root.innerHTML = '<div class="dp-top">' + header(range) + '</div><div class="dp-skel"><i></i><i></i><i></i><i></i></div>';
        clearTimeout(drawTimer);
        drawTimer = setTimeout(function () {
            var d;
            try { d = D.compute(range); } catch (e) { try { console.error('dashboard', e); } catch (e2) { /* none */ } root.innerHTML = '<div class="dp-top">' + header(range) + '</div><p class="dp-empty">The dashboard could not be calculated. <button type="button" class="dp-btn" data-act="refresh">Try again</button></p>'; return; }
            lastData = d;
            var first = ['trend', 'profit'], rest = WIDGETS.map(function (w) { return w[0]; }).filter(function (id) { return first.indexOf(id) < 0 && !S.hidden[id]; });
            var vis = function (id) { return !S.hidden[id]; };
            root.innerHTML = '<div class="dp-top">' + header(range) + '</div>' + (d.salesEver ? '' : '<p class="dp-empty">No sales yet — your dashboard fills up as you sell.</p>') + kpis(d) + '<div class="dp-grid-w" id="dp-grid">' + first.filter(vis).map(function (id) { return widgetHtml(id, d); }).join('') + '</div><div id="dp-panelwrap"></div>';
            var grid = document.getElementById('dp-grid'), i = 0;
            // the lower sections are drawn a few at a time so the first screen appears at once and the till is never held up
            (function step() { if (!grid || !grid.isConnected || lastData !== d) return; var chunk = rest.slice(i, i + 4); if (!chunk.length) return; grid.insertAdjacentHTML('beforeend', chunk.map(function (id) { return widgetHtml(id, d); }).join('')); i += 4; setTimeout(step, 0); })();
        }, 0);
    };
    D.exportCsv = function () {
        if (!lastData) return; var d = lastData, A = d.A, rows = [['MyDuka dashboard export'], ['Period', d.range.text], ['Generated', new Date().toLocaleString('en-GB')], [],
            ['Sales', Math.round(A.revenue)], ['Transactions', A.count], ['Items sold', A.items], ['Cost of goods', d.hasCost ? Math.round(A.cogs) : 'n/a'], ['Gross profit', d.hasCost ? Math.round(A.revenue - A.cogs) : 'n/a'], ['Expenses', Math.round(d.expTotal)], ['Unpaid sales', Math.round(A.unpaid)], [],
            ['Date / hour', 'Sales', 'Transactions']].concat(d.series.map(function (p) { return [p.long, Math.round(p.rev), p.n]; })).concat([[], ['Product', 'Qty', 'Revenue']]).concat(Object.keys(A.item).map(function (k) { return [A.item[k].name, A.item[k].qty, Math.round(A.item[k].rev)]; }).sort(function (a, b) { return b[2] - a[2]; }));
        var csv = rows.map(function (r) { return r.map(function (c) { return typeof csvEscape === 'function' ? csvEscape(c) : String(c); }).join(','); }).join('\n');
        if (typeof downloadBlob === 'function') downloadBlob(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), 'dashboard-' + d.range.fromKey + (d.range.toKey !== d.range.fromKey ? '_to_' + d.range.toKey : '') + '.csv');
    };

    /* ---------- events (one delegated listener) ---------- */
    function onClick(ev) {
        var fh = ev.target && ev.target.closest ? ev.target.closest('.dp-fold > .dp-card-h') : null;
        if (fh && root && root.contains(fh) && !(ev.target.closest('button,a,[data-goto]'))) { fh.parentNode.classList.toggle('dp-open'); return; }
        var t = ev.target && ev.target.closest ? ev.target.closest('[data-preset],[data-metric],[data-topby],[data-topall],[data-staffby],[data-goto],[data-act],[data-retry],[data-applycustom],[data-wmove]') : null;
        if (!t || !root || !root.contains(t)) return;
        if (t.dataset.preset) { S.preset = t.dataset.preset; persist(); return D.render(); }
        if (t.dataset.applycustom) { S.from = (document.getElementById('dp-from') || {}).value || ''; S.to = (document.getElementById('dp-to') || {}).value || ''; return D.render(); }
        if (t.dataset.metric) { S.metric = t.dataset.metric; return redrawWidget('trend'); }
        if (t.dataset.topby) { S.topBy = t.dataset.topby; return redrawWidget('top'); }
        if (t.dataset.topall) { S.topAll = !S.topAll; return redrawWidget('top'); }
        if (t.dataset.staffby) { S.staffBy = t.dataset.staffby; return redrawWidget('staff'); }
        if (t.dataset.retry) return redrawWidget(t.dataset.retry);
        if (t.dataset.goto) { var b = document.querySelector('.tabs .tab-link[data-tab="' + t.dataset.goto + '"]'); if (b) b.click(); return; }
        if (t.dataset.wmove) { var p = t.dataset.wmove.split(':'), ids = ordered().map(function (w) { return w[0]; }), i = ids.indexOf(p[0]), j = i + Number(p[1]); if (i >= 0 && j >= 0 && j < ids.length) { var x = ids[i]; ids[i] = ids[j]; ids[j] = x; S.order = ids; persist(); D.render(); setTimeout(function () { D.openPanel(); }, 30); } return; }
        var act = t.dataset.act;
        if (act === 'refresh') { D.force = false; return D.render(); }
        if (act === 'export') return D.exportCsv();
        if (act === 'customize') return D.openPanel();
        if (act === 'closepanel') { var pw = document.getElementById('dp-panelwrap'); if (pw) pw.innerHTML = ''; return; }
        if (act === 'resetlayout') { S.hidden = {}; S.order = []; persist(); return D.render(); }
    }
    function onChange(ev) { var t = ev.target; if (!t || !t.dataset || !t.dataset.wtoggle) return; S.hidden[t.dataset.wtoggle] = !t.checked; persist(); D.render(); setTimeout(function () { D.openPanel(); }, 30); }
    D.openPanel = function () { var pw = document.getElementById('dp-panelwrap'); if (pw) { pw.innerHTML = customizePanel(); pw.scrollIntoView({ block: 'nearest' }); } };
    function redrawWidget(id) {
        if (!lastData || !root) return; var el = root.querySelector('[data-w="' + id + '"]'); if (!el) return;
        var tmp = document.createElement('div'); tmp.innerHTML = widgetHtml(id, lastData); if (tmp.firstElementChild) el.replaceWith(tmp.firstElementChild);
    }
    var tip = null;
    function showTip(ev) {
        var t = ev.target && ev.target.closest ? ev.target.closest('[data-tip]') : null;
        if (!t || !root || !root.contains(t)) { if (tip) tip.style.display = 'none'; return; }
        if (!tip) { tip = document.createElement('div'); tip.className = 'dp-tip'; document.body.appendChild(tip); }
        tip.textContent = t.getAttribute('data-tip'); tip.style.display = 'block';
        var x = ev.clientX || (t.getBoundingClientRect().left + 10), y = ev.clientY || t.getBoundingClientRect().top;
        var w = tip.offsetWidth; tip.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, x - w / 2)) + 'px'; tip.style.top = Math.max(6, y - tip.offsetHeight - 12) + 'px';
    }
    function bind() {
        var el = document.getElementById('dashboard-tab'); if (!el || el.__dpBound) return; el.__dpBound = true;
        el.addEventListener('click', onClick); el.addEventListener('change', onChange);
        el.addEventListener('mousemove', showTip); el.addEventListener('mouseover', showTip); el.addEventListener('touchstart', function (e) { showTip(e.touches && e.touches[0] ? { target: e.target, clientX: e.touches[0].clientX, clientY: e.touches[0].clientY } : e); }, { passive: true });
        el.addEventListener('mouseleave', function () { if (tip) tip.style.display = 'none'; });
        document.addEventListener('scroll', function () { if (tip) tip.style.display = 'none'; }, { passive: true, capture: true });
        setInterval(function () { var c = document.getElementById('dp-clock'); if (c) c.textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }, 30000);
    }
    D.open = function () { bind(); D.force = true; try { D.render(); } finally { D.force = false; } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
