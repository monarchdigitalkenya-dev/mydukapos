/* zip 187 - Dashboard "command center" (Water / Aqua POS). Reads ONLY the POS's own records (salesLog, bills, debts, tanks, products + per-site stock,
   bulkOrders, expenses, returns, productionLog, customers, staff) and the POS's own money helpers (saleCogs / itemCogs / aquaSaleRevenueFactor /
   billTotalOf / debtBalance / bizDayKey) so every figure reconciles with Daily Sales, Profits and the Bills tab. Nothing is invented: a figure the
   data cannot support is hidden or says "No data". Site rules are the app's own: a sale belongs to its siteId, an old record with no siteId or
   stored as "both" belongs to the Shop. Pure computation (DashPro.compute) is separate from drawing so it can be tested. */
(function () {
    'use strict';
    var D = window.DashPro = window.DashPro || {};
    var LS_KEY = 'aqua_dash_pro_v1';
    var PRESETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['custom', 'Custom']];
    var WIDGETS = [
        ['trend', 'Sales performance'], ['alerts', 'Needs attention'], ['tank', 'Bulk tank & water supply'], ['sites', 'Production vs Shop'], ['mix', 'Sales mix (refills, bottles, bales)'],
        ['top', 'Top sellers'], ['payments', 'Payment methods'], ['hours', 'Busiest hours'], ['days', 'Sales by weekday'], ['inventory', 'Inventory health'],
        ['slow', 'Slow-moving stock'], ['credit', 'Bills & debts owed'], ['deliveries', 'Deliveries'], ['bulk', 'Bulk orders'], ['staff', 'Staff performance'],
        ['expenses', 'Expenses'], ['returns', 'Returns'], ['production', 'Production output'], ['customers', 'Customers'], ['insights', 'Business insights'],
        ['activity', 'Recent activity'], ['actions', 'Quick actions']
    ];
    var COLORS = ['var(--dp-c1)', 'var(--dp-c2)', 'var(--dp-c3)', 'var(--dp-c4)', 'var(--dp-c5)', 'var(--dp-c6)'];
    var KIND_LABEL = { refill: 'Refills', bottled: 'Sealed bottles', bale: 'Bales', bulk: 'Bulk orders', other: 'Accessories & other', payment: 'Bill & balance payments' };

    var S = D.state = { preset: 'today', from: '', to: '', metric: 'revenue', topBy: 'revenue', staffBy: 'revenue', site: null, hidden: {}, order: [], topAll: false };
    try { var saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (saved) { S.hidden = saved.hidden || {}; S.order = Array.isArray(saved.order) ? saved.order : []; S.preset = saved.preset || 'today'; } } catch (e) { /* defaults */ }
    function persist() { try { localStorage.setItem(LS_KEY, JSON.stringify({ hidden: S.hidden, order: S.order, preset: S.preset })); } catch (e) { /* this session only */ } }

    function n0(v) { v = Number(v); return isFinite(v) ? v : 0; }
    function esc(s) { return typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
    function kes(v) { v = Math.round(n0(v) * 100) / 100; return 'KES ' + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
    function short(v) { v = n0(v); var a = Math.abs(v); if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'; if (a >= 1e4) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'; return Math.round(v).toLocaleString('en-US'); }
    function pct(a, b) { return b > 0 ? Math.round(a / b * 1000) / 10 : 0; }
    function fmtQty(v) { v = n0(v); return (Math.round(v * 100) / 100).toLocaleString('en-US'); }
    function litres(v) { return fmtQty(v) + ' L'; }
    function arr(x) { return Array.isArray(x) ? x : []; }
    // the POS's own lists, read by name (each guarded: a missing list is simply empty)
    var G = {
        salesLog: function () { return typeof salesLog !== 'undefined' ? salesLog : undefined; },
        products: function () { return typeof products !== 'undefined' ? products : undefined; },
        expenses: function () { return typeof expenses !== 'undefined' ? expenses : undefined; },
        returns: function () { return typeof returns !== 'undefined' ? returns : undefined; },
        bills: function () { return typeof bills !== 'undefined' ? bills : undefined; },
        debts: function () { return typeof debts !== 'undefined' ? debts : undefined; },
        customers: function () { return typeof customers !== 'undefined' ? customers : undefined; },
        staff: function () { return typeof staff !== 'undefined' ? staff : undefined; },
        tanks: function () { return typeof tanks !== 'undefined' ? tanks : undefined; },
        sites: function () { return typeof sites !== 'undefined' ? sites : undefined; },
        bulkOrders: function () { return typeof bulkOrders !== 'undefined' ? bulkOrders : undefined; },
        productionLog: function () { return typeof productionLog !== 'undefined' ? productionLog : undefined; },
        activeSiteId: function () { return typeof activeSiteId !== 'undefined' ? activeSiteId : undefined; },
        businessName: function () { return typeof businessName !== 'undefined' ? businessName : undefined; },
        lowStockThreshold: function () { return typeof lowStockThreshold !== 'undefined' ? lowStockThreshold : undefined; }
    };
    function g(name) { try { return G[name] ? G[name]() : undefined; } catch (e) { return undefined; } }

    /* ---------- dates (business days, same as Daily Sales) ---------- */
    function keyAdd(key, n) { var p = key.split('-').map(Number); var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)); return d.toISOString().slice(0, 10); }
    function keyDow(key) { var p = key.split('-').map(Number); return (new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() + 6) % 7; }   // Monday = 0
    function keyDiff(a, b) { var pa = a.split('-').map(Number), pb = b.split('-').map(Number); return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000); }
    function keyLabel(key) { var p = key.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }); }
    function lastOfMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function bounds(fromKey, toKey) { var a = bizDayBounds(fromKey), b = bizDayBounds(toKey); return a && b ? { from: a.from, to: b.to } : null; }
    D.rangeFor = function (preset, customFrom, customTo, nowKey) {
        var tk = nowKey || bizDayKey(Date.now()); var p = tk.split('-').map(Number);
        var from = tk, to = tk, label = 'Today', cmp = 'yesterday';
        if (preset === 'yesterday') { from = to = keyAdd(tk, -1); label = 'Yesterday'; cmp = 'the day before'; }
        else if (preset === '7d') { from = keyAdd(tk, -6); label = 'Last 7 days'; cmp = 'the previous 7 days'; }
        else if (preset === '30d') { from = keyAdd(tk, -29); label = 'Last 30 days'; cmp = 'the previous 30 days'; }
        else if (preset === 'month') { from = p[0] + '-' + pad(p[1]) + '-01'; label = 'This month'; cmp = 'the previous period'; }
        else if (preset === 'lastmonth') { var y = p[1] === 1 ? p[0] - 1 : p[0], m = p[1] === 1 ? 12 : p[1] - 1; from = y + '-' + pad(m) + '-01'; to = y + '-' + pad(m) + '-' + pad(lastOfMonth(y, m - 1)); label = 'Last month'; cmp = 'the previous period'; }
        else if (preset === 'custom') { var okF = /^\d{4}-\d{2}-\d{2}$/.test(customFrom || ''), okT = /^\d{4}-\d{2}-\d{2}$/.test(customTo || ''); to = okT ? customTo : tk; from = okF ? customFrom : to; if (from > to) { var x = from; from = to; to = x; } label = 'Custom'; cmp = 'the previous period'; }
        else preset = 'today';
        var days = keyDiff(from, to) + 1;
        var prevTo = keyAdd(from, -1), prevFrom = keyAdd(prevTo, -(days - 1));
        var cur = bounds(from, to) || { from: 0, to: 0 }, prv = bounds(prevFrom, prevTo) || { from: 0, to: 0 };
        return { preset: preset, label: label, fromKey: from, toKey: to, days: days, from: cur.from, to: cur.to, prevFromKey: prevFrom, prevToKey: prevTo, prevFrom: prv.from, prevTo: prv.to, cmp: cmp,
            text: from === to ? keyLabel(from) : keyLabel(from) + ' – ' + keyLabel(to) };
    };

    /* ---------- site scope (the app's own rules) ---------- */
    function isAdmin() { try { return typeof isAdminServing === 'function' ? !!isAdminServing() : true; } catch (e) { return true; } }
    function me() { try { return typeof activeServerName === 'function' ? activeServerName() : ''; } catch (e) { return ''; } }
    function shopId() { try { return typeof shopSiteId === 'function' ? shopSiteId() : ''; } catch (e) { return ''; } }
    // a record with no siteId, or one stored as "both" (the combined view is not a place), belongs to the Shop
    function siteIdOf(rec) { var s = rec && rec.siteId; return (!s || s === 'both') ? shopId() : s; }
    function siteName(id) { var s = arr(g('sites')).filter(function (x) { return x && x.id === id; })[0]; return s ? s.name : 'Site'; }
    function siteIcon(id) { var s = arr(g('sites')).filter(function (x) { return x && x.id === id; })[0]; return s && s.type === 'production' ? '🏭' : '🏪'; }
    // which site(s) the dashboard covers: the admin's choice here, else the site selector at the top of the app; staff only ever see their own site
    function scopeFor(want) {
        var list = arr(g('sites')).filter(function (s) { return s && s.id; }), act = g('activeSiteId'), key;
        if (!isAdmin()) key = (act === 'both' || !act) ? shopId() : act;
        else {
            key = want || S.site;
            if (!key || key === 'auto') key = (act === 'both' || !act) ? 'all' : act;
            if (key !== 'all' && !list.some(function (s) { return s.id === key; })) key = 'all';
        }
        var all = key === 'all';
        return { key: key, all: all, ids: all ? list.map(function (s) { return s.id; }) : [key], multi: all && list.length > 1,
            match: function (rec) { return all || siteIdOf(rec) === key; } };
    }
    D.scope = scopeFor;

    /* ---------- computation ---------- */
    function tsOf(x) { var t = new Date(x && (x.timestamp || x.date || x.createdAt || x.at)).getTime(); return isFinite(t) ? t : 0; }
    function isPay(it) { return typeof aquaIsPaymentLine === 'function' ? aquaIsPaymentLine(it) : !!(it && (it.type === 'payment' || it.unit === 'payment' || it.isPayment)); }
    function saleTotalOf(s) { var t = Number(s.total); if (isFinite(t) && t >= 0) return t; return arr(s.items).reduce(function (a, it) { return a + (isPay(it) ? 0 : n0(it.price) * n0(it.qty)); }, 0); }
    function saleFactor(s) { try { return typeof aquaSaleRevenueFactor === 'function' ? aquaSaleRevenueFactor(s) : 1; } catch (e) { return 1; } }
    function lineCost(it, s) { try { if (typeof moneyLineCost === "function") return n0(moneyLineCost(it, s)); return typeof itemCogs === 'function' ? n0(itemCogs(it, s)) : 0; } catch (e) { return 0; } }
    function hourOf(ts) { var off = null; try { off = bizTzOffsetMin(); } catch (e) { off = null; } if (off == null || !isFinite(off)) return new Date(ts).getHours(); return new Date(ts + off * 60000).getUTCHours(); }
    function kindOf(it) { var t = it.type; return t === 'refill' ? 'refill' : t === 'bottled' ? 'bottled' : t === 'bale' ? 'bale' : (t === 'bulk-booking' || t === 'bulk-booking-deposit') ? 'bulk' : 'other'; }
    function countsAsUnit(it) { var t = it.type; return t !== 'bulk-booking' && t !== 'bulk-booking-deposit' && t !== 'accessory-material' && t !== 'material'; }
    function invIndex() { var by = {}; arr(g('products')).forEach(function (p) { if (p && p.code != null) by[String(p.code)] = p; }); return by; }
    function lineLitres(it, byCode) {
        var q = n0(it.qty), ml = n0(it.sizeML);
        if (it.type === 'refill' || it.type === 'bottled') return ml > 0 ? ml / 1000 * q : 0;
        if (it.type === 'bale') { var p = it.code != null ? byCode[String(it.code)] : null, bpb = n0(it.bottlesPerBale) || (p ? n0(p.bottlesPerBale) : 0), size = ml || (p ? n0(p.sizeML) : 0); return size > 0 && bpb > 0 ? size / 1000 * bpb * q : 0; }
        return 0;
    }
    function emptyAgg() {
        var a = { revenue: 0, unpaid: 0, unpaidCount: 0, count: 0, units: 0, cogs: 0, lit: { refill: 0, packaged: 0, bulk: 0 }, qty: { refill: 0, packaged: 0 }, rev: { refill: 0, bottled: 0, bale: 0, bulk: 0, other: 0, payment: 0 },
            hour: [], dow: [], day: {}, method: { cash: { amt: 0, n: 0 }, mpesa: { amt: 0, n: 0 }, card: { amt: 0, n: 0 }, bank: { amt: 0, n: 0 }, other: { amt: 0, n: 0 } }, item: {}, staff: {}, cust: {}, site: {}, delivery: { n: 0, rev: 0, fee: 0 }, walkin: { n: 0, rev: 0 } };
        for (var h = 0; h < 24; h++) a.hour.push({ rev: 0, n: 0, lit: 0 });
        for (var d = 0; d < 7; d++) a.dow.push({ rev: 0, n: 0 });
        return a;
    }
    function aggregate(sales, byCode, bookingBySale) {
        var a = emptyAgg();
        sales.forEach(function (s) {
            var total = saleTotalOf(s);
            if (s.paid === false) { a.unpaid += total; a.unpaidCount++; return; }
            var ts = tsOf(s), dk = bizDayKey(ts), rf = saleFactor(s);
            a.revenue += total; a.count++;
            var cost = 0, units = 0, lit = 0;
            arr(s.items).forEach(function (it) {
                if (!it) return;
                var c = lineCost(it, s); cost += c;
                var q = n0(it.qty), line = n0(it.price) * q * rf;
                if (isPay(it)) { a.rev.payment += line; return; }
                var kind = kindOf(it), ll = lineLitres(it, byCode);
                a.rev[kind] += line;
                if (countsAsUnit(it)) { units += q; if (kind === 'refill') a.qty.refill += q; else if (kind === 'bottled' || kind === 'bale') a.qty.packaged += q; }
                if (kind === 'refill') a.lit.refill += ll; else if (ll > 0) a.lit.packaged += ll;
                lit += ll;
                var key = kind === 'bulk' ? 'bulk:' + (it.type) : (it.code != null && it.code !== '' ? String(it.code) : String(it.name || it.type || '?') + (it.refillSizeId ? '#' + it.refillSizeId : ''));
                var o = a.item[key] || (a.item[key] = { name: kind === 'bulk' ? (it.type === 'bulk-booking' ? 'Bulk water orders (balance)' : 'Bulk order deposits') : (it.name || '?'), kind: kind, qty: 0, rev: 0, cost: 0, lit: 0 });
                o.qty += countsAsUnit(it) ? q : 0; o.rev += line; o.cost += c; o.lit += ll;
            });
            var bk = bookingBySale[s.id]; if (bk) { var bl = n0(bk.volumeLiters); a.lit.bulk += bl; lit += bl; }
            a.cogs += cost; a.units += units;
            var hr = hourOf(ts); a.hour[hr].rev += total; a.hour[hr].n++; a.hour[hr].lit += lit;
            var dw = keyDow(dk); a.dow[dw].rev += total; a.dow[dw].n++;
            var day = a.day[dk] || (a.day[dk] = { rev: 0, n: 0, units: 0, lit: 0, cogs: 0 }); day.rev += total; day.n++; day.units += units; day.lit += lit; day.cogs += cost;
            // payment mix: the amounts the till recorded; a sale without them counts wholly under its method
            var m = String(s.paymentMethod || 'cash'), mk = (m === 'cash' || m === 'mpesa' || m === 'card' || m === 'bank') ? m : 'other', cash = s.cashAmount, mp = s.mpesaAmount, cd = s.cardAmount;
            var hasAmts = typeof cash === 'number' || typeof mp === 'number' || typeof cd === 'number', parts = [];
            if (hasAmts) { if (n0(cash) > 0) parts.push(['cash', n0(cash)]); if (n0(mp) > 0) parts.push(['mpesa', n0(mp)]); if (n0(cd) > 0) parts.push(['card', n0(cd)]); }
            var sum = parts.reduce(function (x, y) { return x + y[1]; }, 0);
            if (!parts.length) parts = [[mk, total]]; else if (total - sum > 0.5) parts.push([mk, total - sum]);
            parts.forEach(function (pp) { var b = a.method[pp[0]] || a.method.other; b.amt += pp[1]; b.n++; });
            var who = s.servedBy || 'Unassigned', st = a.staff[who] || (a.staff[who] = { rev: 0, n: 0, units: 0, lit: 0, last: 0 });
            st.rev += total; st.n++; st.units += units; st.lit += lit; if (ts > st.last) st.last = ts;
            var ck = s.customerPhone || s.mpesaPhone; if (ck) { var cc = a.cust[ck] || (a.cust[ck] = { rev: 0, n: 0, name: s.customerName || '' }); cc.rev += total; cc.n++; if (!cc.name && s.customerName) cc.name = s.customerName; }
            var sid = siteIdOf(s), ss = a.site[sid] || (a.site[sid] = { rev: 0, n: 0, lit: 0, cogs: 0 }); ss.rev += total; ss.n++; ss.lit += lit; ss.cogs += cost;
            if (s.orderType === 'delivery') { a.delivery.n++; a.delivery.rev += total; a.delivery.fee += n0(s.deliveryDetails && s.deliveryDetails.fee); } else { a.walkin.n++; a.walkin.rev += total; }
        });
        return a;
    }
    function stockQty(p, scope) {
        var act = g('activeSiteId');
        function one(sid) { if (sid === act) return n0(p.qty); try { return typeof stockAt === 'function' ? n0(stockAt(p, sid)) : n0(p.qty); } catch (e) { return 0; } }
        if (!scope.ids.length) return n0(p.qty);
        return scope.ids.reduce(function (s, sid) { return s + one(sid); }, 0);
    }
    function stockRows(scope) {
        var out = [];
        arr(g('products')).forEach(function (p) {
            if (!p || p.removed || p._deleted) return;
            try { if (typeof isStockedProduct === 'function' && !isStockedProduct(p)) return; } catch (e) { return; }
            out.push({ name: p.name || '?', code: p.code, cat: p.category || 'item', qty: stockQty(p, scope), cost: n0(p.wholesalePrice), price: n0(p.price), p: p });
        });
        return out;
    }
    function owedOf(b) { return Math.max(0, (typeof billTotalOf === 'function' ? n0(billTotalOf(b)) : n0(b.total)) - n0(b.amountPaid)); }
    function debtOwed(d) { try { return typeof debtBalance === 'function' ? n0(debtBalance(d)) : Math.max(0, n0(d.amount) - arr(d.payments).reduce(function (s, p) { return s + n0(p.amount); }, 0)); } catch (e) { return 0; } }
    function isPod(b) { return b && b.orderType === 'delivery' && !b.podSettled && ((b.deliveryDetails && b.deliveryDetails.pod) || b.paymentMethod === 'pod'); }
    function tankInfo(t) { var inf = !!t.infinite, vol = n0(t.currentVolumeLiters), cap = n0(t.capacityLiters); return { id: t.id, name: t.name || 'Tank', site: siteIdOf(t), inf: inf, vol: vol, cap: cap, pct: !inf && cap > 0 ? Math.round(vol / cap * 100) : null, thr: n0(t.lowStockThresholdLiters), low: !inf && vol <= n0(t.lowStockThresholdLiters) }; }

    D.compute = function (range, opts) {
        opts = opts || {};
        var sc = scopeFor(opts.scope), byCode = invIndex(), all = arr(g('salesLog')), todayKey = bizDayKey(Date.now());
        var bookingBySale = {}; arr(g('bulkOrders')).forEach(function (b) { if (b && b.fulfilledSaleId) bookingBySale[b.fulfilledSaleId] = b; });
        var cur = [], prev = [], lastSale = {}, first = 0, trailFrom = (bounds(keyAdd(todayKey, -13), todayKey) || { from: 0 }).from, trailDraw = 0, salesInScope = 0;
        all.forEach(function (s) {
            if (!s || s.voided || !sc.match(s)) return;
            var t = tsOf(s); salesInScope++;
            if (s.paid !== false) {
                if (!first || t < first) first = t;
                arr(s.items).forEach(function (it) { if (it && it.code != null && it.code !== '' && !isPay(it)) { var k = String(it.code); if (!(lastSale[k] >= t)) lastSale[k] = t; } });
                if (t >= trailFrom) { arr(s.items).forEach(function (it) { if (it && it.type === 'refill') trailDraw += lineLitres(it, byCode); }); var bk0 = bookingBySale[s.id]; if (bk0) trailDraw += n0(bk0.volumeLiters); }
            }
            if (t >= range.from && t <= range.to) cur.push(s); else if (t >= range.prevFrom && t <= range.prevTo) prev.push(s);
        });
        var A = aggregate(cur, byCode, bookingBySale), P = aggregate(prev, byCode, bookingBySale);
        var hasCost = A.count > 0 && A.cogs > 0;
        // expenses are not split by site in this app (one list for the business), so they are shown business-wide
        var inR = function (e, a, b) { var t = tsOf(e); return t >= a && t <= b; };
        var expAll = arr(g('expenses')).filter(function (e) { return e && !e.removed; });
        var expAmt = function (e) { return n0(e.amount) + n0(e.transactionCost); };
        var exp = expAll.filter(function (e) { return inR(e, range.from, range.to); }), expPrev = expAll.filter(function (e) { return inR(e, range.prevFrom, range.prevTo); });
        var expTotal = exp.reduce(function (s, e) { return s + expAmt(e); }, 0), expPrevTotal = expPrev.reduce(function (s, e) { return s + expAmt(e); }, 0);
        var expCat = {}; exp.forEach(function (e) { var k = e.category || 'Other'; expCat[k] = (expCat[k] || 0) + expAmt(e); });
        // returns
        var rets = arr(g('returns')).filter(function (r) { return r && !r._deleted && !r.removed && sc.match(r) && inR(r, range.from, range.to); });
        var retProd = {}; rets.forEach(function (r) { var k = r.itemName || r.itemCode || '?'; retProd[k] = (retProd[k] || 0) + n0(r.qty); });
        var retTopUp = rets.reduce(function (s, r) { return s + n0(r.topUpAmount); }, 0), retRestocked = rets.filter(function (r) { return r.restocked; }).length;
        // stock
        var rows = stockRows(sc), limit = typeof g('lowStockThreshold') === 'number' ? g('lowStockThreshold') : 5;
        var invValue = rows.reduce(function (s, r) { return s + Math.max(0, r.qty) * r.cost; }, 0), units = rows.reduce(function (s, r) { return s + Math.max(0, r.qty); }, 0);
        var low = rows.filter(function (r) { return r.qty > 0 && r.qty <= limit; }), out = rows.filter(function (r) { return r.qty <= 0; });
        var noCost = rows.filter(function (r) { return r.qty > 0 && !(r.cost > 0); });
        var stockCat = {}; rows.forEach(function (r) { var c = stockCat[r.cat] || (stockCat[r.cat] = { n: 0, units: 0, value: 0 }); c.n++; c.units += Math.max(0, r.qty); c.value += Math.max(0, r.qty) * r.cost; });
        var soldCodes = {}; Object.keys(A.item).forEach(function (k) { if (A.item[k].qty > 0) soldCodes[k] = A.item[k].qty; });
        var slow = rows.filter(function (r) { return r.qty > 0 && !(soldCodes[String(r.code)] > 0); }).map(function (r) { return { name: r.name, qty: r.qty, cat: r.cat, value: r.qty * r.cost, last: lastSale[String(r.code)] || 0 }; }).sort(function (a, b) { return b.value - a.value || b.qty - a.qty; });
        // bulk tanks (every tank belongs to one site; a tank with no siteId is the Shop's)
        var tankRows = arr(g('tanks')).filter(function (t) { return t && !t.removed && sc.match(t); }).map(tankInfo);
        var anyInf = tankRows.some(function (t) { return t.inf; }), tankVol = tankRows.reduce(function (s, t) { return s + (t.inf ? 0 : t.vol); }, 0), tankCap = tankRows.reduce(function (s, t) { return s + (t.inf ? 0 : t.cap); }, 0);
        var windowDays = first ? Math.min(14, keyDiff(bizDayKey(first), todayKey) + 1) : 0;
        var perDay = windowDays >= 3 ? trailDraw / windowDays : 0;
        var supplyDays = !anyInf && tankRows.length && perDay > 0 ? tankVol / perDay : null;
        var delivered = 0, deliveredCost = 0, deliveries = 0;
        arr(g('tanks')).forEach(function (t) { if (!t || t.removed || !sc.match(t)) return; arr(t.refillLog).forEach(function (r) { if (r && n0(r.litersAdded) > 0 && r.supplier !== 'Level correction' && inR(r, range.from, range.to)) { delivered += n0(r.litersAdded); deliveredCost += n0(r.cost); deliveries++; } }); });
        // bills, debts, deliveries (a bill / debt belongs to the site it was rung up at)
        var billsIn = arr(g('bills')).filter(function (b) { return b && !b.voided && !b.closed && sc.match(b); });
        var openBills = billsIn.filter(function (b) { return owedOf(b) > 0.005; });
        var billOwed = openBills.reduce(function (s, b) { return s + owedOf(b); }, 0);
        var podBills = openBills.filter(isPod), podOwed = podBills.reduce(function (s, b) { return s + owedOf(b); }, 0);
        var debtList = arr(g('debts')).filter(function (d) { return d && !d.removed && sc.match(d) && debtOwed(d) > 0.005; });
        var debtTotal = debtList.reduce(function (s, d) { return s + debtOwed(d); }, 0);
        var owing = {}; openBills.forEach(function (b) { owing['b:' + (b.customerPhone || b.customerName || b.id)] = 1; }); debtList.forEach(function (d) { owing['d:' + (d.phone || d.customerName || d.id)] = 1; });
        var overdue = openBills.filter(function (b) { return b.dueDate && b.dueDate < todayKey; });
        var recentBills = billsIn.slice().sort(function (a, b) { return tsOf(b) - tsOf(a); }).slice(0, 4);
        var onRoute = {}; var openDeliv = 0;
        arr(g('salesLog')).concat(arr(g('bills'))).forEach(function (r) { if (!r || r.voided || r.podSettled || r.orderType !== 'delivery' || !r.deliveryStatus || r.deliveryStatus === 'delivered' || !sc.match(r)) return; openDeliv++; onRoute[r.deliveryStatus] = (onRoute[r.deliveryStatus] || 0) + 1; });
        // bulk orders
        var bulkAll = arr(g('bulkOrders')).filter(function (b) { return b && sc.match(b); });
        var bulkOpen = bulkAll.filter(function (b) { return b.status === 'pending' || b.status === 'scheduled'; }).sort(function (a, b) { return String(a.scheduledDate).localeCompare(String(b.scheduledDate)); });
        var bulkLitres = bulkOpen.reduce(function (s, b) { return s + n0(b.volumeLiters); }, 0), bulkBalance = bulkOpen.reduce(function (s, b) { return s + Math.max(0, n0(b.totalPrice) - n0(b.depositAmount)); }, 0);
        var bulkDue = bulkOpen.filter(function (b) { return b.scheduledDate && b.scheduledDate <= todayKey; });
        // production
        var prodRuns = arr(g('productionLog')).filter(function (r) { return r && !r._deleted && sc.match(r) && inR(r, range.from, range.to); });
        var prodBy = {}; prodRuns.forEach(function (r) { var k = r.targetName || r.targetId || '?'; prodBy[k] = (prodBy[k] || 0) + n0(r.qty); });
        var prodUnits = prodRuns.reduce(function (s, r) { return s + n0(r.qty); }, 0);
        // customers
        var custs = arr(g('customers')).filter(function (c) { return c && !c._deleted; });
        var custByPhone = {}; custs.forEach(function (c) { if (c.phone) custByPhone[c.phone] = c; });
        var newCust = custs.filter(function (c) { return n0(c.createdAt) >= range.from && n0(c.createdAt) <= range.to; }).length;
        var known = Object.keys(A.cust).filter(function (k) { return custByPhone[k]; });
        var returning = known.filter(function (k) { var c = custByPhone[k]; return n0(c.createdAt) && n0(c.createdAt) < range.from; }).length;
        var custSpend = known.reduce(function (s, k) { return s + A.cust[k].rev; }, 0);
        var topCust = Object.keys(A.cust).map(function (k) { return { name: (custByPhone[k] && custByPhone[k].name) || A.cust[k].name || k, rev: A.cust[k].rev, n: A.cust[k].n }; }).sort(function (a, b) { return b.rev - a.rev; }).slice(0, 5);
        // staff
        var staffRows = Object.keys(A.staff).map(function (k) { var st = A.staff[k]; return { name: k, rev: st.rev, n: st.n, units: st.units, lit: st.lit, avg: st.n ? st.rev / st.n : 0, last: st.last }; });
        // per site (only meaningful when more than one site is in view)
        var siteRows = [];
        if (sc.multi) sc.ids.forEach(function (sid) {
            var one = { all: false, ids: [sid], match: function (rec) { return siteIdOf(rec) === sid; } }, ss = A.site[sid] || { rev: 0, n: 0, lit: 0, cogs: 0 }, ps = P.site[sid] || { rev: 0 };
            var tk = arr(g('tanks')).filter(function (t) { return t && !t.removed && one.match(t); }).map(tankInfo), sr = stockRows(one);
            siteRows.push({ id: sid, name: siteName(sid), icon: siteIcon(sid), rev: ss.rev, prevRev: ps.rev, n: ss.n, lit: ss.lit, profit: ss.rev - ss.cogs,
                tankVol: tk.some(function (t) { return t.inf; }) ? null : tk.reduce(function (s, t) { return s + t.vol; }, 0), tankCap: tk.reduce(function (s, t) { return s + (t.inf ? 0 : t.cap); }, 0), tanks: tk.length,
                owed: arr(g('bills')).filter(function (b) { return b && !b.voided && !b.closed && one.match(b); }).reduce(function (s, b) { return s + owedOf(b); }, 0),
                low: sr.filter(function (r) { return r.qty > 0 && r.qty <= limit; }).length, out: sr.filter(function (r) { return r.qty <= 0; }).length });
        });
        // series
        var series = [], dk = range.fromKey, guard = 0, perHour = range.days === 1;
        if (perHour) { for (var h = 0; h < 24; h++) series.push({ key: h, label: (h % 12 || 12) + (h < 12 ? 'a' : 'p'), long: pad(h) + ':00', rev: A.hour[h].rev, n: A.hour[h].n, lit: A.hour[h].lit, profit: 0 }); }
        else if (range.days <= 62) { while (dk <= range.toKey && guard++ < 400) { var dd = A.day[dk] || { rev: 0, n: 0, lit: 0, cogs: 0 }; series.push({ key: dk, label: keyLabel(dk), long: keyLabel(dk), rev: dd.rev, n: dd.n, lit: dd.lit, profit: dd.rev - dd.cogs }); dk = keyAdd(dk, 1); } }
        else { var wk = {}; Object.keys(A.day).forEach(function (k) { var w = keyAdd(k, -keyDow(k)), o = wk[w] || (wk[w] = { rev: 0, n: 0, lit: 0, cogs: 0 }); o.rev += A.day[k].rev; o.n += A.day[k].n; o.lit += A.day[k].lit; o.cogs += A.day[k].cogs; }); Object.keys(wk).sort().forEach(function (k) { series.push({ key: k, label: keyLabel(k), long: 'Week of ' + keyLabel(k), rev: wk[k].rev, n: wk[k].n, lit: wk[k].lit, profit: wk[k].rev - wk[k].cogs }); }); }
        var seriesProfitOk = hasCost && !perHour;
        var peakHour = -1, peakVal = 0; A.hour.forEach(function (x, i) { if (x.rev > peakVal) { peakVal = x.rev; peakHour = i; } });
        var bestDow = -1, bestDowVal = 0; A.dow.forEach(function (x, i) { if (x.rev > bestDowVal) { bestDowVal = x.rev; bestDow = i; } });
        // activity feed
        var recent = [];
        all.filter(function (s) { return s && !s.voided && sc.match(s); }).slice(-60).forEach(function (s) { var f = arr(s.items)[0]; recent.push({ t: tsOf(s), icon: s.paid === false ? '🧾' : '🛒', what: s.paid === false ? 'Unpaid sale' : 'Sale completed', who: s.servedBy || '', amt: saleTotalOf(s), detail: (f && f.name || '') + (arr(s.items).length > 1 ? ' +' + (arr(s.items).length - 1) : ''), tab: 'daily-sales-tab' }); });
        expAll.slice(-20).forEach(function (e) { recent.push({ t: tsOf(e), icon: '💸', what: 'Expense recorded', who: '', amt: expAmt(e), detail: (e.category || '') + (e.description ? ' · ' + e.description : ''), tab: 'profits-tab' }); });
        arr(g('returns')).filter(function (r) { return r && !r._deleted && sc.match(r); }).slice(-20).forEach(function (r) { recent.push({ t: tsOf(r), icon: '↩️', what: 'Return processed', who: r.servedBy || '', amt: null, detail: (r.itemName || '') + ' ×' + fmtQty(r.qty), tab: 'returns-tab' }); });
        arr(g('productionLog')).filter(function (r) { return r && sc.match(r); }).slice(-20).forEach(function (r) { recent.push({ t: tsOf(r), icon: '🏭', what: 'Production run', who: r.producedBy || '', amt: null, detail: (r.targetName || '') + ' ×' + fmtQty(r.qty), tab: 'production-tab' }); });
        arr(g('tanks')).filter(function (t) { return t && !t.removed && sc.match(t); }).forEach(function (t) { arr(t.refillLog).slice(-10).forEach(function (r) { if (r && n0(r.litersAdded) > 0 && r.supplier !== 'Level correction') recent.push({ t: tsOf(r), icon: '🚰', what: 'Water delivered to tank', who: r.servedBy || '', amt: null, detail: (t.name || 'Tank') + ' +' + litres(r.litersAdded), tab: 'tank-tab' }); }); });
        bulkAll.slice(-15).forEach(function (b) { recent.push({ t: tsOf(b), icon: '📅', what: 'Bulk order booked', who: b.bookedBy || '', amt: n0(b.totalPrice), detail: (b.clientName || '') + ' · ' + litres(b.volumeLiters), tab: 'bookings-tab' }); });
        recent.sort(function (a, b) { return b.t - a.t; });
        return { range: range, scope: sc, A: A, P: P, hasCost: hasCost, expTotal: expTotal, expPrevTotal: expPrevTotal, expCat: expCat, exp: exp, rets: rets, retProd: retProd, retTopUp: retTopUp, retRestocked: retRestocked,
            rows: rows, invValue: invValue, units: units, low: low, out: out, noCost: noCost, slow: slow, stockCat: stockCat, limit: limit,
            tankRows: tankRows, tankVol: tankVol, tankCap: tankCap, anyInf: anyInf, perDay: perDay, windowDays: windowDays, supplyDays: supplyDays, delivered: delivered, deliveredCost: deliveredCost, deliveries: deliveries,
            billOwed: billOwed, billCount: openBills.length, podOwed: podBills.length ? podOwed : 0, podCount: podBills.length, debtOwed: debtTotal, debtCount: debtList.length, owingCustomers: Object.keys(owing).length, overdue: overdue, recentBills: recentBills, openDeliv: openDeliv, onRoute: onRoute,
            bulkOpen: bulkOpen, bulkLitres: bulkLitres, bulkBalance: bulkBalance, bulkDue: bulkDue, prodRuns: prodRuns, prodBy: prodBy, prodUnits: prodUnits,
            custTotal: custs.length, newCust: newCust, returning: returning, known: known.length, custSpend: custSpend, topCust: topCust, staffRows: staffRows, siteRows: siteRows,
            series: series, seriesProfitOk: seriesProfitOk, perHour: perHour, peakHour: peakHour, peakVal: peakVal, bestDow: bestDow, bestDowVal: bestDowVal, recent: recent.slice(0, 14), salesEver: salesInScope, todayKey: todayKey };
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
    function lineChart(pts, key) {
        if (!pts.length || !pts.some(function (p) { return p[key] > 0; })) return '';
        var W = cwid(900), H = W < 500 ? 210 : 250, L = W < 500 ? 40 : 50, R = 14, T = 14, B = 28, mx = niceMax(Math.max.apply(null, pts.map(function (p) { return p[key]; })));
        var X = function (i) { return pts.length === 1 ? L + (W - L - R) / 2 : L + i * (W - L - R) / (pts.length - 1); }, Y = function (v) { return T + (H - T - B) * (1 - v / mx); };
        var grid = '', i;
        for (i = 0; i <= 4; i++) { var gv = mx * i / 4, gy = Y(gv); grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + gy + '" y2="' + gy + '" class="dp-grid"/><text x="' + (L - 6) + '" y="' + (gy + 4) + '" class="dp-ax" text-anchor="end">' + (key === 'rev' || key === 'profit' || key === 'lit' ? short(gv) : Math.round(gv)) + '</text>'; }
        var every = Math.max(1, Math.ceil(pts.length / (W < 500 ? 4 : 8))), xl = '';
        pts.forEach(function (p, idx) { if (idx % every === 0 || idx === pts.length - 1) xl += '<text x="' + X(idx) + '" y="' + (H - 8) + '" class="dp-ax" text-anchor="middle">' + esc(p.label) + '</text>'; });
        var line = pts.map(function (p, idx) { return (idx ? 'L' : 'M') + X(idx).toFixed(1) + ' ' + Y(Math.max(0, p[key])).toFixed(1); }).join(' ');
        var area = line + ' L' + X(pts.length - 1).toFixed(1) + ' ' + Y(0) + ' L' + X(0).toFixed(1) + ' ' + Y(0) + ' Z';
        var dots = pts.map(function (p, idx) {
            var tip = p.long + ' · ' + kes(p.rev) + ' · ' + p.n + ' sale' + (p.n === 1 ? '' : 's') + ' · ' + litres(p.lit) + (p.profitOk ? ' · profit ' + kes(p.profit) : '');
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
    function donut(slices, centerTop, centerSub, fmt) {   // [{label, value, color}]
        var tot = slices.reduce(function (s, x) { return s + x.value; }, 0); if (!(tot > 0)) return '';
        var R = 54, C = 2 * Math.PI * R, off = 0, segs = '', f = fmt || kes;
        slices.forEach(function (s) { var len = s.value / tot * C; segs += '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="' + s.color + '" stroke-width="20" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 70 70)" class="dp-slice" data-tip="' + esc(s.label + ' · ' + f(s.value) + ' · ' + pct(s.value, tot) + '%') + '"/>'; off += len; });
        return '<svg class="dp-donut" viewBox="0 0 140 140" role="img" aria-label="Share chart">' + segs + '<text x="70" y="68" text-anchor="middle" class="dp-dtop">' + esc(centerTop) + '</text><text x="70" y="84" text-anchor="middle" class="dp-dsub">' + esc(centerSub) + '</text></svg>';
    }
    function delta(cur, prev, minPrev) { if (!(prev > (minPrev || 0))) return null; return Math.round((cur - prev) / prev * 1000) / 10; }   // no comparison when the earlier period has nothing to compare against
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
    function stats(list) { return '<div class="dp-stats">' + list.map(function (s) { return '<div><b>' + s[1] + '</b><small>' + s[0] + '</small></div>'; }).join('') + '</div>'; }
    function plain(list, f) { return list.length ? '<ul class="dp-plain">' + list.map(f).join('') + '</ul>' : ''; }
    function scopeNote(d) { return d.scope.all ? (d.scope.multi ? 'All sites combined.' : '') : siteName(d.scope.key) + ' only.'; }

    var W = {};
    W.trend = function (d) {
        var m = S.metric, key = m === 'revenue' ? 'rev' : m === 'profit' ? 'profit' : m === 'txns' ? 'n' : 'lit';
        var tabs = [['revenue', 'Revenue'], ['litres', 'Litres'], ['txns', 'Transactions'], ['profit', 'Profit']].filter(function (t) { return t[0] !== 'profit' || d.seriesProfitOk; }).map(function (t) { return '<button type="button" class="dp-seg-btn' + (m === t[0] ? ' on' : '') + '" data-metric="' + t[0] + '">' + t[1] + '</button>'; }).join('');
        if (m === 'profit' && !d.seriesProfitOk) key = 'rev';
        var pts = d.series.map(function (p) { return { key: p.key, label: p.label, long: p.long, rev: p.rev, n: p.n, lit: p.lit, profit: p.profit, profitOk: d.seriesProfitOk }; });
        var chart = lineChart(pts, key);
        return card('trend', 'Sales performance <span class="dp-sub">' + esc(d.range.text) + '</span>', chart ? '<div class="dp-seg">' + tabs + '</div>' + chart + '<p class="dp-note">' + (d.perHour ? 'By hour of the business day.' : d.range.days > 62 ? 'By week.' : 'By day.') + ' Totals match Daily Sales (paid, not voided). ' + esc(scopeNote(d)) + '</p>' : empty('No sales in this period.'), { span: 12, head: viewBtn('daily-sales-tab', 'Daily sales') });
    };
    W.tank = function (d) {
        if (!d.tankRows.length) return card('tank', 'Bulk tank & water supply', empty('No bulk tanks set up' + (d.scope.all ? '.' : ' at this site.')), { span: 6, head: viewBtn('tank-tab', 'Bulk tank') });
        var rows = d.tankRows.map(function (t) {
            var bar = t.inf ? '' : '<div class="dp-meter"><i class="' + (t.low ? 'warn' : '') + '" style="width:' + Math.max(2, t.pct || 0) + '%"></i></div>';
            return '<li><div class="dp-li-main"><b>' + (d.scope.multi ? esc(siteIcon(t.site)) + ' ' + esc(siteName(t.site)) + ' — ' : '') + esc(t.name) + '</b><small>' + (t.inf ? 'Unmetered source (never runs out)' : litres(t.vol) + ' of ' + litres(t.cap) + (t.low ? ' · at or below the ' + litres(t.thr) + ' warning level' : '')) + '</small>' + bar + '</div><div class="dp-li-val"><b>' + (t.inf ? '♾️' : (t.pct == null ? '—' : t.pct + '%')) + '</b></div></li>';
        }).join('');
        var supply = d.anyInf ? 'Not applicable (unmetered source)' : d.supplyDays != null ? (d.supplyDays >= 100 ? '100+ days' : (Math.round(d.supplyDays * 10) / 10) + ' days') : 'Not enough sales history';
        return card('tank', 'Bulk tank & water supply', stats([['In tanks', d.anyInf ? '♾️' : litres(d.tankVol)], ['Capacity', d.anyInf ? '—' : litres(d.tankCap)], ['Days of supply', supply], ['Delivered in period', d.deliveries ? litres(d.delivered) : '—']])
            + '<ul class="dp-list">' + rows + '</ul><p class="dp-note">' + (d.perDay > 0 ? 'Days of supply = litres in the tank ÷ the ' + d.windowDays + '-day average of ' + litres(d.perDay) + ' a day drawn by refills and bulk orders.' : 'Days of supply appears once there are at least 3 days of refill sales.') + (d.deliveries && d.deliveredCost > 0 ? ' Water bought in this period cost ' + kes(d.deliveredCost) + '.' : '') + '</p>', { span: 6, head: viewBtn('tank-tab', 'Bulk tank') });
    };
    W.sites = function (d) {
        if (!d.scope.multi) return card('sites', 'Production vs Shop', empty(d.scope.all ? 'Only one site is set up.' : 'Showing ' + siteName(d.scope.key) + ' only. Choose "All sites" above to compare sites.'), { span: 12 });
        return card('sites', 'Production vs Shop <span class="dp-sub">' + esc(d.range.text) + '</span>', '<div class="dp-tbl"><table><thead><tr><th>Site</th><th>Sales</th><th>Txns</th><th>Litres</th>' + (d.hasCost ? '<th>Profit</th>' : '') + '<th>Tank</th><th>Owed</th><th>Low / out</th></tr></thead><tbody>' + d.siteRows.map(function (r) {
            return '<tr><td>' + esc(r.icon + ' ' + r.name) + '</td><td>' + kes(r.rev) + '</td><td>' + r.n + '</td><td>' + fmtQty(r.lit) + '</td>' + (d.hasCost ? '<td>' + kes(r.profit) + '</td>' : '') + '<td>' + (r.tanks ? (r.tankVol == null ? '♾️' : litres(r.tankVol)) : '—') + '</td><td>' + (r.owed > 0 ? kes(r.owed) : '—') + '</td><td>' + r.low + ' / ' + r.out + '</td></tr>';
        }).join('') + '</tbody></table></div><p class="dp-note">Every sale, bill, tank and stock count is counted at the site it belongs to. Old records with no site belong to the Shop. Expenses are one business-wide list, so they are not split by site.</p>', { span: 12 });
    };
    W.mix = function (d) {
        var A = d.A, kinds = ['refill', 'bottled', 'bale', 'bulk', 'other', 'payment'], list = kinds.map(function (k) { return { k: k, name: KIND_LABEL[k], rev: A.rev[k] }; }).filter(function (x) { return x.rev > 0; });
        if (!list.length) return card('mix', 'Sales mix', empty('No sales in this period.'), { span: 6 });
        var tot = list.reduce(function (s, x) { return s + x.rev; }, 0);
        var litRows = [['Refill litres', A.lit.refill], ['Packaged litres (bottles & bales)', A.lit.packaged], ['Bulk order litres', A.lit.bulk]].filter(function (r) { return r[1] > 0; });
        return card('mix', 'Sales mix <span class="dp-sub">refills vs packaged</span>', '<div class="dp-donut-wrap">' + donut(list.map(function (x, i) { return { label: x.name, value: x.rev, color: COLORS[i % 6] }; }), short(tot), 'sales') + '<ul class="dp-key">' + list.map(function (x, i) { return '<li><i style="background:' + COLORS[i % 6] + '"></i><span>' + esc(x.name) + '</span><b>' + pct(x.rev, tot) + '%</b><small>' + kes(x.rev) + (x.k === 'refill' ? ' · ' + fmtQty(A.qty.refill) + ' refills' : '') + '</small></li>'; }).join('') + '</ul></div>'
            + (litRows.length ? stats(litRows.map(function (r) { return [r[0], litres(r[1])]; })) : '') + '<p class="dp-note">Shares of what customers were charged (offers off, delivery fees on). Bulk orders count when delivered.</p>', { span: 6 });
    };
    W.top = function (d) {
        var by = S.topBy, list = Object.keys(d.A.item).map(function (k) { var o = d.A.item[k]; return { name: o.name, kind: o.kind, qty: o.qty, rev: o.rev, lit: o.lit, profit: o.cost > 0 ? o.rev - o.cost : null }; });
        if (!list.length) return card('top', 'Top sellers', empty('No sales in this period.'), { span: 6 });
        var val = function (o) { return by === 'qty' ? o.qty : by === 'litres' ? o.lit : by === 'profit' ? (o.profit == null ? -1e12 : o.profit) : o.rev; };
        list.sort(function (a, b) { return val(b) - val(a); });
        var shown = S.topAll ? list.slice(0, 100) : list.slice(0, 8);
        var tabs = [['revenue', 'Revenue'], ['qty', 'Quantity'], ['litres', 'Litres'], ['profit', 'Profit']].filter(function (t) { return t[0] !== 'profit' || d.hasCost; }).map(function (t) { return '<button type="button" class="dp-seg-btn' + (by === t[0] ? ' on' : '') + '" data-topby="' + t[0] + '">' + t[1] + '</button>'; }).join('');
        var rows = shown.map(function (o, i) {
            return '<li><em class="dp-rank">#' + (i + 1) + '</em><div class="dp-thumb"><span>' + esc((o.name || '?').charAt(0).toUpperCase()) + '</span></div><div class="dp-li-main"><b>' + esc(o.name) + '</b><small>' + esc(KIND_LABEL[o.kind] || '') + (o.kind === 'bulk' ? '' : ' · ' + fmtQty(o.qty) + ' sold') + (o.lit > 0 ? ' · ' + litres(o.lit) : '') + '</small></div><div class="dp-li-val"><b>' + kes(o.rev) + '</b>' + (d.hasCost && o.profit != null ? '<small>profit ' + kes(o.profit) + '</small>' : '') + '</div></li>';
        }).join('');
        return card('top', 'Top sellers', '<div class="dp-seg">' + tabs + '</div><ul class="dp-list">' + rows + '</ul>' + (list.length > 8 ? '<button type="button" class="dp-more" data-topall="1">' + (S.topAll ? 'Show top 8' : 'View all ' + list.length + ' items') + '</button>' : ''), { span: 6, head: viewBtn('stock-report-tab', 'Stock report') });
    };
    W.inventory = function (d) {
        if (!d.rows.length) return card('inventory', 'Inventory health', empty('No stocked products yet.'), { span: 6, head: viewBtn('inventory-tab', 'Inventory') });
        var catName = { bottled: 'Sealed bottles', bale: 'Bales', accessory: 'Accessories' };
        var cats = Object.keys(d.stockCat).map(function (k) { return { k: k, name: catName[k] || 'Other items', c: d.stockCat[k] }; });
        return card('inventory', 'Inventory health' + (d.scope.multi ? '' : ' <span class="dp-sub">' + esc(scopeNote(d)) + '</span>'), stats([['Products', d.rows.length], ['Units in stock', fmtQty(d.units)], ['Stock value (cost)', kes(d.invValue)], ['Low stock', d.low.length], ['Out of stock', d.out.length], ['Slow-moving', d.slow.length]])
            + '<h5>Bottle, bale and accessory stock</h5>' + plain(cats, function (x) { return '<li>' + esc(x.name) + ' <b>' + fmtQty(x.c.units) + ' in stock · ' + kes(x.c.value) + '</b></li>'; })
            + (d.low.length ? '<details class="dp-det"><summary>Low stock (' + d.low.length + ', at or below ' + fmtQty(d.limit) + ')</summary>' + plain(d.low.slice(0, 8), function (r) { return '<li>' + esc(r.name) + ' <b>' + fmtQty(r.qty) + '</b></li>'; }) + '</details>' : '')
            + (d.out.length ? '<details class="dp-det"><summary>Out of stock (' + d.out.length + ')</summary>' + plain(d.out.slice(0, 8), function (r) { return '<li>' + esc(r.name) + '</li>'; }) + '</details>' : ''), { span: 6, head: viewBtn('inventory-tab', 'Inventory') });
    };
    W.slow = function (d) {
        if (!d.rows.length) return card('slow', 'Slow-moving stock', empty('No stocked products yet.'), { span: 6 });
        if (!d.slow.length) return card('slow', 'Slow-moving stock', empty(d.A.count ? 'Every product in stock sold at least once in this period.' : 'No sales in this period to compare against.'), { span: 6 });
        return card('slow', 'Slow-moving stock', '<p class="dp-note" style="margin-top:0">In stock but <b>no sales in this period</b>. Biggest tied-up value first.</p><div class="dp-tbl"><table><thead><tr><th>Product</th><th>In stock</th><th>Value</th><th>Last sale</th></tr></thead><tbody>' + d.slow.slice(0, 8).map(function (r) { return '<tr><td>' + esc(r.name) + '</td><td>' + fmtQty(r.qty) + '</td><td>' + (r.value > 0 ? kes(r.value) : '—') + '</td><td>' + (r.last ? new Date(r.last).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'No sale on record') + '</td></tr>'; }).join('') + '</tbody></table></div>' + (d.slow.length > 8 ? '<p class="dp-note">+ ' + (d.slow.length - 8) + ' more</p>' : ''), { span: 6, head: viewBtn('stock-report-tab', 'Stock report') });
    };
    W.staff = function (d) {
        var rows = d.staffRows.slice();
        if (!isAdmin()) { var mine = me(); rows = rows.filter(function (r) { return r.name === mine; }); }
        if (!rows.length) return card('staff', 'Staff performance', empty('No staff activity for this period.'), { span: 12 });
        var by = S.staffBy, val = function (r) { return by === 'n' ? r.n : by === 'lit' ? r.lit : by === 'avg' ? r.avg : r.rev; };
        rows.sort(function (a, b) { return val(b) - val(a); });
        var tabs = [['revenue', 'Sales'], ['n', 'Transactions'], ['lit', 'Litres'], ['avg', 'Avg sale']].map(function (t) { return '<button type="button" class="dp-seg-btn' + (by === t[0] ? ' on' : '') + '" data-staffby="' + t[0] + '">' + t[1] + '</button>'; }).join('');
        var label = { revenue: 'Sales generated', n: 'Transactions', lit: 'Litres sold', avg: 'Average sale' }[by] || 'Sales generated';
        var mx = Math.max.apply(null, rows.map(val)) || 1;
        var ini = function (n) { return esc(String(n || '?').trim().split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase()); };
        return card('staff', 'Staff performance <span class="dp-sub">ranked by ' + label.toLowerCase() + '</span>', '<div class="dp-seg">' + tabs + '</div><ul class="dp-list">' + rows.slice(0, 12).map(function (r, i) {
            return '<li><em class="dp-rank">#' + (i + 1) + '</em><div class="dp-avatar">' + ini(r.name) + '</div><div class="dp-li-main"><b>' + esc(r.name) + '</b><small>' + r.n + ' sales · ' + litres(r.lit) + ' · avg ' + kes(r.avg) + (r.last ? ' · last sale ' + new Date(r.last).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '') + '</small><div class="dp-meter"><i style="width:' + Math.max(2, val(r) / mx * 100).toFixed(1) + '%"></i></div></div><div class="dp-li-val"><b>' + (by === 'n' ? fmtQty(val(r)) : by === 'lit' ? litres(val(r)) : kes(val(r))) + '</b></div></li>';
        }).join('') + '</ul><p class="dp-note">' + (isAdmin() ? 'Everyone who recorded a sale in this period, from every device. ' + esc(scopeNote(d)) : 'You can see your own figures only.') + '</p>', { span: 12, head: isAdmin() ? viewBtn('staff-tab', 'Staff') : '' });
    };
    W.payments = function (d) {
        var m = d.A.method, names = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', bank: 'Bank', other: 'Other' }, list = Object.keys(m).filter(function (k) { return m[k].amt > 0; }).map(function (k) { return { k: k, name: names[k], amt: m[k].amt, n: m[k].n }; }).sort(function (a, b) { return b.amt - a.amt; });
        var credit = d.A.unpaid;
        if (!list.length && !credit) return card('payments', 'Payment methods', empty('No sales in this period.'), { span: 6 });
        var tot = list.reduce(function (s, x) { return s + x.amt; }, 0);
        return card('payments', 'Payment methods', '<div class="dp-donut-wrap">' + donut(list.map(function (x, i) { return { label: x.name, value: x.amt, color: COLORS[i % 6] }; }), short(tot), 'received') + '<ul class="dp-key">' + list.map(function (x, i) { return '<li><i style="background:' + COLORS[i % 6] + '"></i><span>' + x.name + '</span><b>' + pct(x.amt, tot) + '%</b><small>' + kes(x.amt) + ' · ' + x.n + ' payment' + (x.n === 1 ? '' : 's') + '</small></li>'; }).join('') + '</ul></div>' + (credit > 0 ? '<p class="dp-row"><b>Unpaid sales:</b> ' + kes(credit) + ' (' + d.A.unpaidCount + ') — not yet received, so not in the figures above.</p>' : '') + '<p class="dp-note">Money received. Pay-later bills count when they are paid.</p>', { span: 6, head: viewBtn('daily-sales-tab', 'Daily sales') });
    };
    W.hours = function (d) {
        if (!d.A.count) return card('hours', 'Busiest hours', empty('No sales in this period.'), { span: 6 });
        var items = d.A.hour.map(function (x, h) { return { label: (h % 12 || 12) + (h < 12 ? 'a' : 'p'), value: x.rev, tip: pad(h) + ':00–' + pad(h) + ':59 · ' + kes(x.rev) + ' · ' + x.n + ' sale' + (x.n === 1 ? '' : 's') + ' · ' + litres(x.lit) }; });
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
        return card('customers', 'Customers', stats([['Total customers', d.custTotal], ['New in period', d.newCust], ['Bought in period', d.known], ['Returning', d.returning], ['Avg spend', d.known ? kes(d.custSpend / d.known) : '—']])
            + (isAdmin() && d.topCust.length ? '<h5>Top customers by spend</h5>' + plain(d.topCust, function (c) { return '<li>' + esc(c.name) + ' <b>' + kes(c.rev) + '</b></li>'; }) : ''), { span: 6, head: viewBtn('customers-tab', 'Customers') });
    };
    W.credit = function (d) {
        var total = d.billOwed + d.debtOwed;
        if (!d.billCount && !d.debtCount && !d.A.unpaid) return card('credit', 'Bills & debts owed', empty('Nobody owes you anything right now.'), { span: 6, head: viewBtn('bills-tab', 'Bills') });
        return card('credit', 'Bills & debts owed' + (d.scope.multi ? '' : ' <span class="dp-sub">' + esc(scopeNote(d)) + '</span>'), '<button type="button" class="dp-big" data-goto="bills-tab"><b>' + kes(total) + '</b><span>outstanding · ' + d.owingCustomers + ' customer' + (d.owingCustomers === 1 ? '' : 's') + ' owe</span></button>'
            + stats([['Open bills (' + d.billCount + ')', kes(d.billOwed)], ['Debts (' + d.debtCount + ')', kes(d.debtOwed)], ['Pay on delivery (' + d.podCount + ')', d.podCount ? kes(d.podOwed) : '—'], ['Overdue bills', d.overdue.length]])
            + (d.recentBills.length ? '<h5>Recent bills</h5>' + plain(d.recentBills, function (b) { return '<li>' + esc(b.customerName || 'Walk-in customer') + ' <b>' + kes(owedOf(b)) + ' owed</b></li>'; }) : ''), { span: 6, head: viewBtn('debts-tab', 'Debts') });
    };
    W.deliveries = function (d) {
        var A = d.A, stat = { assigned: 'Assigned', picked_up: 'Picked up', on_route: 'On route' }, ks = Object.keys(d.onRoute);
        if (!A.delivery.n && !d.openDeliv && !d.podCount) return card('deliveries', 'Deliveries', empty('No deliveries in this period.'), { span: 6, head: viewBtn('deliveries-tab', 'Deliveries') });
        return card('deliveries', 'Deliveries', stats([['Delivery sales', A.delivery.n], ['Delivery revenue', kes(A.delivery.rev)], ['Delivery fees charged', kes(A.delivery.fee)], ['Walk-in sales', A.walkin.n], ['Still to deliver', d.openDeliv], ['Pay on delivery owed', d.podCount ? kes(d.podOwed) : '—']])
            + (ks.length ? '<h5>In progress now</h5>' + plain(ks, function (k) { return '<li>' + esc(stat[k] || k) + ' <b>' + d.onRoute[k] + '</b></li>'; }) : ''), { span: 6, head: viewBtn('deliveries-tab', 'Deliveries') });
    };
    W.bulk = function (d) {
        if (!d.bulkOpen.length) return card('bulk', 'Bulk orders', empty('No open bulk water orders.'), { span: 6, head: viewBtn('bookings-tab', 'Bulk orders') });
        var tight = !d.anyInf && d.tankRows.length && d.bulkLitres > d.tankVol;
        return card('bulk', 'Bulk orders', stats([['Open orders', d.bulkOpen.length], ['Litres to deliver', litres(d.bulkLitres)], ['Balance to collect', kes(d.bulkBalance)], ['Due today or late', d.bulkDue.length]])
            + (tight ? '<p class="dp-warn">⚠️ Open orders need ' + litres(d.bulkLitres) + ' but the tanks in view hold ' + litres(d.tankVol) + '.</p>' : '')
            + '<h5>Next deliveries</h5>' + plain(d.bulkOpen.slice(0, 5), function (b) { return '<li>' + esc(b.clientName || 'Client') + ' · ' + litres(b.volumeLiters) + ' <b>' + esc(b.scheduledDate || '—') + '</b></li>'; }), { span: 6, head: viewBtn('bookings-tab', 'Bulk orders') });
    };
    W.expenses = function (d) {
        if (!d.exp.length) return card('expenses', 'Expenses', empty('No expenses recorded in this period.'), { span: 6, head: viewBtn('profits-tab', 'Expenses') });
        var cats = Object.keys(d.expCat).map(function (k) { return { k: k, v: d.expCat[k] }; }).sort(function (a, b) { return b.v - a.v; });
        var big = d.exp.slice().sort(function (a, b) { return (n0(b.amount) + n0(b.transactionCost)) - (n0(a.amount) + n0(a.transactionCost)); }).slice(0, 4), mx = cats[0].v || 1;
        return card('expenses', 'Expenses <span class="dp-sub">whole business</span>', '<div class="dp-stats"><div><b>' + kes(d.expTotal) + '</b><small>Total expenses</small></div><div><b>' + (d.A.revenue > 0 && d.scope.all ? pct(d.expTotal, d.A.revenue) + '%' : '—') + '</b><small>of sales</small></div><div>' + deltaHtml(delta(d.expTotal, d.expPrevTotal, 0), d.range.cmp, true) + '</div></div><h5>Top expense categories</h5><ul class="dp-bars">' + cats.slice(0, 5).map(function (c) { return '<li><span>' + esc(c.k) + '</span><div><i style="width:' + Math.max(2, c.v / mx * 100).toFixed(1) + '%"></i></div><b>' + pct(c.v, d.expTotal) + '%</b><small>' + kes(c.v) + '</small></li>'; }).join('') + '</ul><h5>Largest expenses</h5>' + plain(big, function (e) { return '<li>' + esc((e.category || 'Other') + (e.description ? ' · ' + e.description : '')) + ' <b>' + kes(n0(e.amount) + n0(e.transactionCost)) + '</b></li>'; }) + '<p class="dp-note">Expenses are one list for the whole business (including transaction costs), so they are not split by site.</p>', { span: 6, head: viewBtn('profits-tab', 'Expenses') });
    };
    W.returns = function (d) {
        if (!d.rets.length) return card('returns', 'Returns', empty('No returns in this period.'), { span: 6, head: viewBtn('returns-tab', 'Returns') });
        var prod = Object.keys(d.retProd).map(function (k) { return [k, d.retProd[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 4), units = d.rets.reduce(function (s, r) { return s + n0(r.qty); }, 0);
        return card('returns', 'Returns', stats([['Returns', d.rets.length], ['Units returned', fmtQty(units)], ['Put back in stock', d.retRestocked]].concat(d.retTopUp > 0 ? [['Top-ups paid', kes(d.retTopUp)]] : [])) + '<h5>Most returned</h5>' + plain(prod, function (p) { return '<li>' + esc(p[0]) + ' <b>×' + fmtQty(p[1]) + '</b></li>'; }), { span: 6, head: viewBtn('returns-tab', 'Returns') });
    };
    W.production = function (d) {
        if (!d.prodRuns.length) return card('production', 'Production output', empty('No production runs in this period' + (d.scope.all ? '.' : ' at this site.')), { span: 6, head: viewBtn('production-tab', 'Production') });
        var prod = Object.keys(d.prodBy).map(function (k) { return [k, d.prodBy[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 6);
        return card('production', 'Production output', stats([['Runs', d.prodRuns.length], ['Units made', fmtQty(d.prodUnits)]]) + '<h5>By product</h5>' + plain(prod, function (p) { return '<li>' + esc(p[0]) + ' <b>×' + fmtQty(p[1]) + '</b></li>'; }), { span: 6, head: viewBtn('production-tab', 'Production') });
    };
    D.insights = function (d) {
        var out = [], A = d.A, P = d.P, dl = delta(A.revenue, P.revenue, 0);
        if (dl != null && A.count >= 3) out.push([dl >= 0 ? '📈' : '📉', 'Sales are ' + (dl >= 0 ? 'up ' : 'down ') + Math.abs(dl) + '% compared with ' + d.range.cmp + ' (' + kes(A.revenue) + ' vs ' + kes(P.revenue) + ').']);
        var totLit = A.lit.refill + A.lit.packaged + A.lit.bulk;
        if (totLit > 0) out.push(['💧', litres(totLit) + ' of water sold' + (A.lit.refill > 0 ? ' — ' + Math.round(A.lit.refill / totLit * 100) + '% as refills' : '') + (A.lit.packaged > 0 ? ', ' + Math.round(A.lit.packaged / totLit * 100) + '% packaged' : '') + (A.lit.bulk > 0 ? ', ' + Math.round(A.lit.bulk / totLit * 100) + '% bulk' : '') + '.']);
        var rf = A.rev.refill, pk = A.rev.bottled + A.rev.bale;
        if (rf > 0 && pk > 0) out.push(['🧴', (rf >= pk ? 'Refills' : 'Bottles and bales') + ' brought in more money: ' + kes(Math.max(rf, pk)) + ' vs ' + kes(Math.min(rf, pk)) + '.']);
        if (d.supplyDays != null && d.supplyDays < 14) out.push(['🚰', 'At the recent pace the tank holds about ' + (Math.round(d.supplyDays * 10) / 10) + ' day' + (d.supplyDays === 1 ? '' : 's') + ' of water.']);
        if (d.peakHour >= 0 && A.count >= 8) out.push(['⏰', 'Your busiest sales hour was ' + pad(d.peakHour) + ':00–' + pad(d.peakHour) + ':59 (' + A.hour[d.peakHour].n + ' sales).']);
        var items = Object.keys(A.item).map(function (k) { return A.item[k].rev; }).sort(function (a, b) { return b - a; }), it = items.reduce(function (s, v) { return s + v; }, 0);
        if (items.length >= 5 && it > 0) { var top = Object.keys(A.item).map(function (k) { return A.item[k]; }).sort(function (a, b) { return b.rev - a.rev; })[0]; out.push(['🎯', top.name + ' was the biggest earner (' + Math.round(top.rev / it * 100) + '% of item sales).']); }
        if (d.slow.length && A.count >= 5) out.push(['🐢', d.slow.length + ' stocked product' + (d.slow.length === 1 ? ' has' : 's have') + ' stock but no sales in this period.']);
        var allN = A.method.cash.n + A.method.mpesa.n + A.method.card.n + A.method.bank.n + A.method.other.n;
        if (allN >= 10) out.push(['💳', 'Cash was ' + Math.round(A.method.cash.n / allN * 100) + '% of payments, M-Pesa ' + Math.round(A.method.mpesa.n / allN * 100) + '%.']);
        if (d.hasCost && A.revenue > 0) { var mg = pct(A.revenue - A.cogs, A.revenue), pm = P.revenue > 0 && P.cogs > 0 ? pct(P.revenue - P.cogs, P.revenue) : null; out.push(['💰', 'Gross margin was ' + mg + '%' + (pm != null && P.count >= 3 ? ' (' + (mg >= pm ? 'up from ' : 'down from ') + pm + '% in ' + d.range.cmp + ')' : '') + '.']); }
        if (d.billOwed + d.debtOwed > 0 && A.revenue > 0) out.push(['🧾', kes(d.billOwed + d.debtOwed) + ' is owed to you in unpaid bills and debts.']);
        return out;
    };
    W.insights = function (d) {
        var ins = D.insights(d);
        return card('insights', 'Business insights', ins.length ? '<ul class="dp-ins">' + ins.map(function (i) { return '<li><span>' + i[0] + '</span>' + esc(i[1]) + '</li>'; }).join('') + '</ul><p class="dp-note">Worked out from your own records for ' + esc(d.range.text) + '; shown only when there is enough data.</p>' : empty('Not enough sales in this period to say anything useful yet.'), { span: 6 });
    };
    D.alerts = function (d) {
        var a = [], plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };
        d.tankRows.filter(function (t) { return t.low; }).forEach(function (t) { a.push({ p: 1, icon: '🚰', text: (d.scope.multi ? siteName(t.site) + ' — ' : '') + t.name + ' is low: ' + litres(t.vol) + ' left (warning level ' + litres(t.thr) + ')', tab: 'tank-tab' }); });
        if (d.supplyDays != null && d.supplyDays < 3 && !d.tankRows.some(function (t) { return t.low; })) a.push({ p: 2, icon: '⏳', text: 'Tank water may run out in about ' + (Math.round(d.supplyDays * 10) / 10) + ' days at the recent pace', tab: 'tank-tab' });
        if (d.out.length) a.push({ p: 1, icon: '⛔', text: plural(d.out.length, 'product is', 'products are') + ' out of stock', tab: 'inventory-tab' });
        if (d.low.length) a.push({ p: 2, icon: '🔔', text: plural(d.low.length, 'product is', 'products are') + ' low on stock', tab: 'inventory-tab' });
        if (d.overdue.length) a.push({ p: 1, icon: '⏳', text: plural(d.overdue.length, 'open bill is', 'open bills are') + ' past the due date', tab: 'bills-tab' });
        if (d.podCount) a.push({ p: 2, icon: '🚚', text: plural(d.podCount, 'delivery is', 'deliveries are') + ' waiting to be paid on delivery (' + kes(d.podOwed) + ')', tab: 'deliveries-tab' });
        if (d.billOwed + d.debtOwed > 0) a.push({ p: 3, icon: '🧾', text: 'Outstanding credit: ' + kes(d.billOwed + d.debtOwed) + ' from ' + plural(d.owingCustomers, 'customer', 'customers'), tab: 'bills-tab' });
        if (d.bulkDue.length) a.push({ p: 2, icon: '📅', text: plural(d.bulkDue.length, 'bulk order is', 'bulk orders are') + ' due for delivery today or late', tab: 'bookings-tab' });
        if (d.openDeliv) a.push({ p: 3, icon: '🚚', text: plural(d.openDeliv, 'delivery is', 'deliveries are') + ' still on the way', tab: 'deliveries-tab' });
        if (d.A.unpaidCount) a.push({ p: 3, icon: '⌛', text: plural(d.A.unpaidCount, 'sale is', 'sales are') + ' marked unpaid (' + kes(d.A.unpaid) + ')', tab: 'daily-sales-tab' });
        if (d.noCost.length) a.push({ p: 4, icon: '🏷️', text: plural(d.noCost.length, 'product has', 'products have') + ' stock but no cost price, so profit is incomplete', tab: 'inventory-tab' });
        if (d.slow.length && d.A.count >= 5) a.push({ p: 4, icon: '🐢', text: plural(d.slow.length, 'product has', 'products have') + ' had no sales in this period', tab: 'inventory-tab' });
        try { if (typeof hasUnsyncedWork === 'function' && hasUnsyncedWork()) a.push({ p: 2, icon: '🔄', text: 'Some changes on this device have not reached the server yet', tab: null }); } catch (e) { /* none */ }
        a.sort(function (x, y) { return x.p - y.p; });
        return a;
    };
    W.alerts = function (d) {
        var al = D.alerts(d);
        return card('alerts', 'Needs attention', al.length ? '<ul class="dp-alerts">' + al.map(function (x) { return '<li class="p' + x.p + '">' + (x.tab ? '<button type="button" data-goto="' + x.tab + '">' : '<div>') + '<span>' + x.icon + '</span>' + esc(x.text) + (x.tab ? ' <em>→</em></button>' : '</div>') + '</li>'; }).join('') + '</ul>' : '<p class="dp-ok">✅ Nothing needs your attention right now.</p>', { span: 6 });
    };
    function ago(t) { var s = Math.max(0, (Date.now() - t) / 1000); if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; if (s < 604800) return Math.floor(s / 86400) + 'd'; return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
    W.activity = function (d) {
        if (!d.recent.length) return card('activity', 'Recent activity', empty('No activity yet.'), { span: 6 });
        return card('activity', 'Recent activity', '<ul class="dp-feed">' + d.recent.map(function (e) { return '<li><button type="button" data-goto="' + e.tab + '"><span class="dp-fi">' + e.icon + '</span><div><b>' + esc(e.what) + (e.amt != null ? ' · ' + kes(e.amt) : '') + '</b><small>' + esc(e.detail) + (e.who ? ' · ' + esc(e.who) : '') + '</small></div><time>' + esc(ago(e.t)) + '</time></button></li>'; }).join('') + '</ul>', { span: 6 });
    };
    W.actions = function () {
        var acts = [['🧾', 'New sale', 'sales-tab'], ['📥', 'Restock', 'restocking-tab'], ['🚰', 'Bulk tank', 'tank-tab'], ['🏭', 'Production', 'production-tab'], ['📅', 'Bulk order', 'bookings-tab'], ['🚚', 'Deliveries', 'deliveries-tab'], ['💸', 'Add expense', 'profits-tab'], ['🧾', 'Bills', 'bills-tab'], ['📊', 'Daily sales', 'daily-sales-tab'], ['📦', 'Stock report', 'stock-report-tab'], ['👤', 'Customers', 'customers-tab'], ['👥', 'Staff', 'staff-tab']];
        var html = acts.map(function (a) { var b = document.querySelector('.tab-link[data-tab="' + a[2] + '"]'); if (!b || b.style.display === 'none' || (a[2] === 'staff-tab' && !isAdmin())) return ''; return '<button type="button" class="dp-qa" data-goto="' + a[2] + '"><span>' + a[0] + '</span>' + a[1] + '</button>'; }).join('');
        return card('actions', 'Quick actions', html ? '<div class="dp-qas">' + html + '</div>' : empty('No shortcuts available for this account.'), { span: 12 });
    };

    /* ---------- page ---------- */
    function kpis(d) {
        var A = d.A, P = d.P, c = d.range.cmp, ser = d.series.map(function (p) { return p.rev; });
        var avg = A.count ? A.revenue / A.count : 0, pavg = P.count ? P.revenue / P.count : 0, gross = A.revenue - A.cogs, pgross = P.revenue - P.cogs;
        var lit = A.lit.refill + A.lit.packaged + A.lit.bulk, plit = P.lit.refill + P.lit.packaged + P.lit.bulk, noCmp = '<span class="dp-delta flat">No earlier data to compare</span>', flat = function (t) { return '<span class="dp-delta flat">' + esc(t) + '</span>'; };
        var list = [];
        list.push(['💰', d.range.label === 'Today' ? "Today's sales" : 'Sales', kes(A.revenue), deltaHtml(delta(A.revenue, P.revenue, 0), c), spark(ser)]);
        list.push(['💧', 'Litres sold', litres(lit), deltaHtml(delta(lit, plit, 0), c) + '<small class="dp-sub2">refills ' + fmtQty(A.lit.refill) + ' · packaged ' + fmtQty(A.lit.packaged) + ' · bulk ' + fmtQty(A.lit.bulk) + '</small>', spark(d.series.map(function (p) { return p.lit; }), 'var(--dp-c6)')]);
        list.push(['🧾', 'Transactions', A.count.toLocaleString('en-US'), deltaHtml(delta(A.count, P.count, 0), c), spark(d.series.map(function (p) { return p.n; }), 'var(--dp-c4)')]);
        list.push(['📊', 'Average sale', A.count ? kes(avg) : '—', A.count && P.count ? deltaHtml(delta(avg, pavg, 0), c) : noCmp, '']);
        list.push(['🚰', 'Refills sold', fmtQty(A.qty.refill), deltaHtml(delta(A.qty.refill, P.qty.refill, 0), c) + '<small class="dp-sub2">' + kes(A.rev.refill) + '</small>', '']);
        list.push(['🧴', 'Bottles & bales sold', fmtQty(A.qty.packaged), deltaHtml(delta(A.qty.packaged, P.qty.packaged, 0), c) + '<small class="dp-sub2">' + kes(A.rev.bottled + A.rev.bale) + '</small>', '']);
        if (d.hasCost) {
            list.push(['📈', 'Gross profit', kes(gross), deltaHtml(delta(gross, pgross, 0), c), d.seriesProfitOk ? spark(d.series.map(function (p) { return p.profit; }), 'var(--dp-c2)') : '']);
            list.push(['🎯', 'Profit margin', pct(gross, A.revenue) + '%', P.revenue > 0 && P.cogs > 0 && P.count ? deltaHtml(Math.round((pct(gross, A.revenue) - pct(pgross, P.revenue)) * 10) / 10 || 0, c).replace('%', ' pts') : noCmp, '']);
        } else list.push(['📈', 'Gross profit', 'No data', flat('No cost recorded on these sales'), '']);
        list.push(['💸', 'Expenses', kes(d.expTotal), deltaHtml(delta(d.expTotal, d.expPrevTotal, 0), c, true) + '<small class="dp-sub2">whole business</small>', '']);
        list.push(['🚰', 'Tank level', d.tankRows.length ? (d.anyInf ? '♾️' : (d.tankCap > 0 ? Math.round(d.tankVol / d.tankCap * 100) + '%' : '—')) : 'No tank', flat(d.tankRows.length ? (d.anyInf ? 'Unmetered source' : litres(d.tankVol) + ' of ' + litres(d.tankCap)) : 'No tank set up') + (d.supplyDays != null ? '<small class="dp-sub2">about ' + (d.supplyDays >= 100 ? '100+' : Math.round(d.supplyDays * 10) / 10) + ' days of supply</small>' : ''), '']);
        list.push(['📦', 'Stock value', kes(d.invValue), flat(d.rows.length + ' products · ' + d.low.length + ' low · ' + d.out.length + ' out'), '']);
        list.push(['🧾', 'Owed to you', kes(d.billOwed + d.debtOwed), flat(d.owingCustomers + ' customer' + (d.owingCustomers === 1 ? '' : 's')) + (d.podCount ? '<small class="dp-sub2">incl. ' + kes(d.podOwed) + ' pay-on-delivery</small>' : ''), '']);
        if (d.bulkOpen.length) list.push(['📅', 'Bulk orders open', String(d.bulkOpen.length), flat(litres(d.bulkLitres) + ' to deliver'), '']);
        if (d.custTotal) list.push(['👤', 'Customers', String(d.custTotal), flat(d.newCust + ' new · ' + d.returning + ' returning'), '']);
        return '<div class="dp-kpis">' + list.map(function (k) { return '<div class="dp-kpi"><div class="dp-kpi-top"><span class="dp-ico">' + k[0] + '</span><span class="dp-kpi-l">' + k[1] + '</span></div><div class="dp-kpi-v">' + k[2] + '</div>' + k[3] + k[4] + '</div>'; }).join('') + '</div>';
    }
    function siteSelect(sc) {
        var list = arr(g('sites')).filter(function (s) { return s && s.id; });
        if (!isAdmin() || list.length < 2) return '';
        return '<label class="dp-site"><span>Site</span><select id="dp-site" aria-label="Site"><option value="all"' + (sc.key === 'all' ? ' selected' : '') + '>👁️ All sites</option>' + list.map(function (s) { return '<option value="' + esc(s.id) + '"' + (sc.key === s.id ? ' selected' : '') + '>' + (s.type === 'production' ? '🏭' : '🏪') + ' ' + esc(s.name) + '</option>'; }).join('') + '</select></label>';
    }
    function header(range) {
        var biz = typeof g('businessName') === 'string' ? g('businessName') : '', now = new Date(), sc = scopeFor();
        var chips = PRESETS.map(function (p) { return '<button type="button" class="dp-chip' + (S.preset === p[0] ? ' on' : '') + '" data-preset="' + p[0] + '">' + p[1] + '</button>'; }).join('');
        var custom = S.preset === 'custom' ? '<div class="dp-custom"><input type="date" id="dp-from" value="' + esc(S.from || range.fromKey) + '" aria-label="From"><span>to</span><input type="date" id="dp-to" value="' + esc(S.to || range.toKey) + '" aria-label="To"><button type="button" class="dp-chip on" data-applycustom="1">Apply</button></div>' : '';
        return '<div class="dp-head"><div><h3>' + esc(biz || 'Water business') + '</h3><p>' + now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ' · <span id="dp-clock">' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '</span>' + (me() ? ' · 👤 ' + esc(me()) : '') + (sc.all ? '' : ' · ' + esc(siteIcon(sc.key) + ' ' + siteName(sc.key))) + '</p></div><div class="dp-tools">' + siteSelect(sc) + '<button type="button" class="dp-btn" data-act="refresh" title="Refresh">🔄 Refresh</button><button type="button" class="dp-btn" data-act="export" title="Download a CSV of these figures">⬇️ Export</button>' + (isAdmin() ? '<button type="button" class="dp-btn" data-act="customize">⚙️ Customize</button>' : '') + '</div></div>'
            + '<div class="dp-chips" role="tablist">' + chips + '</div>' + custom + '<p class="dp-range">Showing <b>' + esc(range.text) + '</b>' + (range.label !== 'Custom' ? ' · compared with ' + esc(range.cmp) : ' · compared with the same number of days before') + '</p>';
    }
    function customizePanel() {
        return '<div class="dp-panel" id="dp-panel"><div class="dp-panel-h"><b>Customize dashboard</b><button type="button" data-act="closepanel">✕</button></div><p class="dp-note" style="margin-top:0">Show or hide sections and change their order. Saved on this device.</p>' + ordered().map(function (w, i, a) { return '<div class="dp-prow"><label><input type="checkbox" data-wtoggle="' + w[0] + '"' + (S.hidden[w[0]] ? '' : ' checked') + '> ' + esc(w[1]) + '</label><span><button type="button" data-wmove="' + w[0] + ':-1"' + (i === 0 ? ' disabled' : '') + '>▲</button><button type="button" data-wmove="' + w[0] + ':1"' + (i === a.length - 1 ? ' disabled' : '') + '>▼</button></span></div>'; }).join('') + '<button type="button" class="dp-btn" data-act="resetlayout">Reset layout</button></div>';
    }
    function ordered() { return WIDGETS.slice().sort(function (a, b) { return orderOf(a[0]) - orderOf(b[0]); }); }

    var lastData = null, root = null, drawTimer = 0;
    function widgetHtml(id, d) { try { return W[id](d); } catch (e) { try { console.error('dashboard widget ' + id, e); } catch (e2) { /* none */ } return '<section class="dp-card dp-w-6" data-w="' + id + '" style="order:' + orderOf(id) + '"><header class="dp-card-h"><h4>' + esc((WIDGETS.filter(function (w) { return w[0] === id; })[0] || [0, id])[1]) + '</h4></header><div class="dp-card-b"><p class="dp-empty">This section could not load.</p><button type="button" class="dp-btn" data-retry="' + id + '">Try again</button></div></section>'; } }
    function safeKpis(d) { try { return kpis(d); } catch (e) { try { console.error('dashboard kpis', e); } catch (e2) { /* none */ } return '<p class="dp-empty">The headline figures could not load.</p>'; } }
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
            var firstIds = ['trend', 'alerts', 'tank'], vis = function (id) { return !S.hidden[id]; }, rest = WIDGETS.map(function (w) { return w[0]; }).filter(function (id) { return firstIds.indexOf(id) < 0 && vis(id); });
            root.innerHTML = '<div class="dp-top">' + header(range) + '</div>' + (d.salesEver ? '' : '<p class="dp-empty">No sales yet — your dashboard fills up as you sell.</p>') + safeKpis(d) + '<div class="dp-grid-w" id="dp-grid">' + firstIds.filter(vis).map(function (id) { return widgetHtml(id, d); }).join('') + '</div><div id="dp-panelwrap"></div>';
            var grid = document.getElementById('dp-grid'), i = 0;
            // the lower sections are drawn a few at a time so the first screen appears at once and the till is never held up
            (function step() { if (!grid || !grid.isConnected || lastData !== d) return; var chunk = rest.slice(i, i + 4); if (!chunk.length) return; grid.insertAdjacentHTML('beforeend', chunk.map(function (id) { return widgetHtml(id, d); }).join('')); i += 4; setTimeout(step, 0); })();
        }, 0);
    };
    D.exportCsv = function () {
        if (!lastData) return; var d = lastData, A = d.A, sc = d.scope, r2 = function (v) { return Math.round(v * 100) / 100; };
        var rows = [['Aqua POS dashboard export'], ['Period', d.range.text], ['Site', sc.all ? 'All sites' : siteName(sc.key)], ['Generated', new Date().toLocaleString('en-GB')], [],
            ['Sales', r2(A.revenue)], ['Transactions', A.count], ['Litres sold', r2(A.lit.refill + A.lit.packaged + A.lit.bulk)], ['Refill litres', r2(A.lit.refill)], ['Packaged litres', r2(A.lit.packaged)], ['Bulk order litres', r2(A.lit.bulk)],
            ['Refills sold', A.qty.refill], ['Bottles and bales sold', A.qty.packaged], ['Cost of goods', d.hasCost ? r2(A.cogs) : 'n/a'], ['Gross profit', d.hasCost ? r2(A.revenue - A.cogs) : 'n/a'],
            ['Expenses (whole business)', r2(d.expTotal)], ['Unpaid sales', r2(A.unpaid)], ['Open bills owed', r2(d.billOwed)], ['Debts owed', r2(d.debtOwed)],
            ['Tank litres', d.anyInf ? 'unmetered' : d.tankVol], ['Days of supply', d.supplyDays == null ? 'n/a' : Math.round(d.supplyDays * 10) / 10], [],
            ['Date / hour', 'Sales', 'Transactions', 'Litres']].concat(d.series.map(function (p) { return [p.long, r2(p.rev), p.n, r2(p.lit)]; }))
            .concat([[], ['Item', 'Qty', 'Revenue', 'Litres']]).concat(Object.keys(A.item).map(function (k) { return [A.item[k].name, A.item[k].qty, r2(A.item[k].rev), r2(A.item[k].lit)]; }).sort(function (a, b) { return b[2] - a[2]; }))
            .concat([[], ['Payment method', 'Amount', 'Payments']]).concat(Object.keys(A.method).filter(function (k) { return A.method[k].amt > 0; }).map(function (k) { return [k, r2(A.method[k].amt), A.method[k].n]; }));
        if (d.siteRows.length) rows = rows.concat([[], ['Site', 'Sales', 'Transactions', 'Litres']]).concat(d.siteRows.map(function (r) { return [r.name, r2(r.rev), r.n, r2(r.lit)]; }));
        var cell = function (c) { if (typeof csvEscape === 'function') return csvEscape(c); var t = String(c == null ? '' : c); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
        var csv = rows.map(function (r) { return r.map(cell).join(','); }).join('\n');
        if (typeof downloadBlob === 'function') downloadBlob(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }), 'aqua-dashboard-' + d.range.fromKey + (d.range.toKey !== d.range.fromKey ? '_to_' + d.range.toKey : '') + '.csv');
        return csv;
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
        if (t.dataset.goto) { var b = document.querySelector('.tab-link[data-tab="' + t.dataset.goto + '"]'); if (b) b.click(); return; }
        if (t.dataset.wmove) { var p = t.dataset.wmove.split(':'), ids = ordered().map(function (w) { return w[0]; }), i = ids.indexOf(p[0]), j = i + Number(p[1]); if (i >= 0 && j >= 0 && j < ids.length) { var x = ids[i]; ids[i] = ids[j]; ids[j] = x; S.order = ids; persist(); D.render(); setTimeout(function () { D.openPanel(); }, 30); } return; }
        var act = t.dataset.act;
        if (act === 'refresh') { D.force = false; return D.render(); }
        if (act === 'export') return D.exportCsv();
        if (act === 'customize') return D.openPanel();
        if (act === 'closepanel') { var pw = document.getElementById('dp-panelwrap'); if (pw) pw.innerHTML = ''; return; }
        if (act === 'resetlayout') { S.hidden = {}; S.order = []; persist(); return D.render(); }
    }
    function onChange(ev) {
        var t = ev.target; if (!t) return;
        if (t.id === 'dp-site') { S.site = t.value || 'all'; return D.render(); }
        if (!t.dataset || !t.dataset.wtoggle) return;
        S.hidden[t.dataset.wtoggle] = !t.checked; persist(); D.render(); setTimeout(function () { D.openPanel(); }, 30);
    }
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
