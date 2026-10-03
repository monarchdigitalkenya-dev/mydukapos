/* zip 187 - Dashboard "command center" (Hospital). Reads ONLY the HMIS's own records (salesLog, patientCharges, visits, patients, queue, appointments,
   admissions, labResults, radiologyOrders, theatreCases, patient.maternity, inventory, expenses, bills, debts, institutions, staff) and the app's own helpers
   (saleRevenueTotal / reportSaleCost / billTotalOf / debtBalance / hospitalOpsSnapshot / hmisStationStats), so every figure reconciles with Daily Sales,
   Profits & Expenses and the Hospital Report. Nothing is invented: a figure the data cannot support is hidden or says "No data".
   PRIVACY: counts and money only - no patient name, no diagnosis, no clinical detail is ever put on this screen or in its export.
   ROLES: the owner sees everything; a staff member sees money only when their roles include Reports / Profits / Daily Sales / Hospital Report,
   otherwise money never reaches the page. A staff member sees their own row only in the staff widget.
   Pure computation (DashHosp.compute) is separate from drawing so it can be tested. */
(function () {
    'use strict';
    var D = window.DashHosp = window.DashHosp || {};
    var LS_KEY = 'pos_dash_hosp_v1';
    var FIN_TABS = ['reports-tab', 'profits-tab', 'daily-sales-tab', 'hospital-report-tab'];
    var PRESETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['lastweek', 'Last week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['year', 'This year'], ['custom', 'Custom']];
    // [id, title, money-only]
    var WIDGETS = [
        ['trend', 'Activity trend', 0], ['departments', 'Revenue by department', 1], ['patients', 'Patients seen', 0], ['flow', 'Queue & appointments', 0],
        ['alerts', 'Needs attention', 0], ['clinical', 'Wards, maternity & diagnostics', 0], ['drugs', 'Top medicines', 0], ['stock', 'Drug stock & expiry', 0],
        ['payments', 'Payment methods', 1], ['receivables', 'Money still to collect', 1], ['profit', 'Profitability', 1], ['expenses', 'Expenses', 1],
        ['hours', 'Busiest hours', 0], ['days', 'Busiest weekdays', 0], ['staff', 'Staff activity', 0], ['insights', 'Insights', 0],
        ['activity', 'Recent activity', 0], ['actions', 'Quick actions', 0]
    ];
    var MONEY_W = {}; WIDGETS.forEach(function (w) { MONEY_W[w[0]] = !!w[2]; });
    var DEPTS = [['consult', 'Consultation'], ['lab', 'Laboratory'], ['radiology', 'Radiology'], ['theatre', 'Procedures / Theatre'], ['ward', 'Inpatient (ward)'], ['maternity', 'Maternity'], ['pharmacy', 'Pharmacy'], ['services', 'Other services'], ['copay', 'Insurance co-pays'], ['payments', 'Bill & institution payments'], ['refund', 'Refunds'], ['delivery', 'Delivery fees']];
    var DEPT_NAME = {}; DEPTS.forEach(function (x) { DEPT_NAME[x[0]] = x[1]; });
    var COLORS = ['var(--dh-c1)', 'var(--dh-c2)', 'var(--dh-c3)', 'var(--dh-c4)', 'var(--dh-c5)', 'var(--dh-c6)'];

    var S = D.state = { preset: 'today', from: '', to: '', metric: '', topBy: 'qty', staffBy: 'visits', hidden: {}, order: [], topAll: false };
    try { var saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (saved) { S.hidden = saved.hidden || {}; S.order = Array.isArray(saved.order) ? saved.order : []; S.preset = saved.preset || 'today'; } } catch (e) { /* defaults */ }
    function persist() { try { localStorage.setItem(LS_KEY, JSON.stringify({ hidden: S.hidden, order: S.order, preset: S.preset })); } catch (e) { /* this session only */ } }

    function n0(v) { v = Number(v); return isFinite(v) ? v : 0; }
    function esc(s) { return typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
    function kes(v) { return 'KES ' + Math.round(n0(v)).toLocaleString('en-US'); }
    function short(v) { v = n0(v); var a = Math.abs(v); if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'; if (a >= 1e4) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'; return Math.round(v).toLocaleString('en-US'); }
    function pct(a, b) { return b > 0 ? Math.round(a / b * 1000) / 10 : 0; }
    function fmtQty(v) { v = n0(v); return (Math.round(v * 100) / 100).toLocaleString('en-US'); }
    function arr(x) { return Array.isArray(x) ? x : []; }
    function pl(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
    // the HMIS's own lists, read by name (each guarded: a missing list is simply empty)
    var G = {
        inventory: function () { return typeof inventory !== 'undefined' ? inventory : undefined; },
        salesLog: function () { return typeof salesLog !== 'undefined' ? salesLog : undefined; },
        expenses: function () { return typeof expenses !== 'undefined' ? expenses : undefined; },
        bills: function () { return typeof bills !== 'undefined' ? bills : undefined; },
        debts: function () { return typeof debts !== 'undefined' ? debts : undefined; },
        staff: function () { return typeof staff !== 'undefined' ? staff : undefined; },
        stockMovementLog: function () { return typeof stockMovementLog !== 'undefined' ? stockMovementLog : undefined; },
        patients: function () { return typeof patients !== 'undefined' ? patients : undefined; },
        visits: function () { return typeof visits !== 'undefined' ? visits : undefined; },
        patientCharges: function () { return typeof patientCharges !== 'undefined' ? patientCharges : undefined; },
        appointments: function () { return typeof appointments !== 'undefined' ? appointments : undefined; },
        queue: function () { return typeof queue !== 'undefined' ? queue : undefined; },
        admissions: function () { return typeof admissions !== 'undefined' ? admissions : undefined; },
        labResults: function () { return typeof labResults !== 'undefined' ? labResults : undefined; },
        radiologyOrders: function () { return typeof radiologyOrders !== 'undefined' ? radiologyOrders : undefined; },
        theatreCases: function () { return typeof theatreCases !== 'undefined' ? theatreCases : undefined; },
        institutions: function () { return typeof institutions !== 'undefined' ? institutions : undefined; },
        rooms: function () { return typeof rooms !== 'undefined' ? rooms : undefined; },
        roomStates: function () { return typeof roomStates !== 'undefined' ? roomStates : undefined; },
        currentServer: function () { return typeof currentServer !== 'undefined' ? currentServer : undefined; },
        businessName: function () { return typeof businessName !== 'undefined' ? businessName : undefined; },
        LOW_STOCK_THRESHOLD: function () { return typeof LOW_STOCK_THRESHOLD !== 'undefined' ? LOW_STOCK_THRESHOLD : undefined; },
        EXPIRY_WARNING_DAYS: function () { return typeof EXPIRY_WARNING_DAYS !== 'undefined' ? EXPIRY_WARNING_DAYS : undefined; }
    };
    function g(name) { try { return G[name] ? G[name]() : undefined; } catch (e) { return undefined; } }

    /* ---------- who is looking: owner / staff, and whether money may be shown ---------- */
    function isOwner() { try { return typeof isAdminServing === 'function' ? !!isAdminServing() : !g('currentServer'); } catch (e) { return false; } }
    function myRoles() {
        var cs = g('currentServer'); if (!cs) return null;           // null = the owner (no staff member serving)
        var m = arr(g('staff')).filter(function (s) { return s && s.id === cs.id; })[0];
        return m && Array.isArray(m.roles) ? m.roles : [];
    }
    D.canSeeMoney = function () { var r = myRoles(); if (r === null) return true; return FIN_TABS.some(function (t) { return r.indexOf(t) >= 0; }); };
    function me() { try { return typeof activeServerName === 'function' ? activeServerName() : ''; } catch (e) { return ''; } }
    function tabVisible(tab) { var b = document.querySelector('.tabs .tab-link[data-tab="' + tab + '"]'); return !!b && b.style.display !== 'none'; }

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
    function inR(t, a, b) { return t >= a && t <= b; }
    function isPay(it) { return it && (it.unit === 'payment' || it.isPayment); }
    function itemsTotal(s) { return typeof reportSaleTotal === 'function' ? reportSaleTotal(s) : arr(s.items).reduce(function (a, it) { return a + n0(it.price) * n0(it.qty); }, 0); }
    function saleTotalOf(s) { return typeof saleRevenueTotal === 'function' ? saleRevenueTotal(s) : itemsTotal(s); }   // the same figure Daily Sales adds up (delivery fee included)
    function hourOf(ts) { var off = null; try { off = bizTzOffsetMin(); } catch (e) { off = null; } if (off == null || !isFinite(off)) return new Date(ts).getHours(); return new Date(ts + off * 60000).getUTCHours(); }
    function hint(txt) {
        txt = String(txt || '');
        if (/lab/i.test(txt)) return 'lab';
        if (/radi|imag|x-?ray|ultrasound|\bscan\b|\bct\b|\bmri\b/i.test(txt)) return 'radiology';
        if (/theatre|surg|procedur/i.test(txt)) return 'theatre';
        if (/matern|labour|deliver|antenatal|postnatal|\banc\b/i.test(txt)) return 'maternity';
        if (/ward|inpatient|\bbed\b|nursing/i.test(txt)) return 'ward';
        if (/consult|clinic|opd|outpatient/i.test(txt)) return 'consult';
        if (/pharm|medic|drug/i.test(txt)) return 'pharmacy';
        return '';
    }
    function invIndex() { var m = {}; arr(g('inventory')).forEach(function (p) { if (p && p.code != null) m[String(p.code)] = p; }); return m; }
    function unitCost(it, byCode) {
        var c = n0(it.wholesalePrice); if (c > 0) return c;
        var p = it.code != null ? byCode[String(it.code)] : null; return p ? n0(p.wholesalePrice) : 0;
    }
    // Which department earned a bill line: the patient charge it came from (kind / department), else the line's own wording, else its type.
    function deptOf(it, ch, byCode) {
        var nm = String(it.name || '');
        if (ch) {
            var k = ch.kind;
            if (k === 'consultation') return 'consult'; if (k === 'lab') return 'lab'; if (k === 'radiology') return 'radiology';
            if (k === 'procedure' || k === 'consumable') return 'theatre'; if (k === 'medication') return 'pharmacy';
            if (k === 'service') { var h = hint(ch.department); if (h) return h; }
        }
        if (/^Consultation Fee/i.test(nm)) return 'consult';
        if (/^Lab Test:/i.test(nm)) return 'lab';
        if (/^Imaging:/i.test(nm)) return 'radiology';
        if (/^(Procedure|Theatre):/i.test(nm)) return 'theatre';
        if (/^(IPD |Admission Deposit)/i.test(nm)) return 'ward';
        if (isPay(it)) return n0(it.price) < 0 ? 'refund' : 'payments';
        if (/co-?pay/i.test(nm)) return 'copay';
        if (it.isService || it.unit === 'use') { var p = it.code != null ? byCode[String(it.code)] : null; return hint(p && p.department) || 'services'; }
        return 'pharmacy';
    }
    function aggregate(sales, ctx) {
        var a = { revenue: 0, unpaid: 0, count: 0, unpaidCount: 0, refundN: 0, refundAmt: 0, cogs: 0, missingCost: 0, costLines: 0, hour: [], dow: [], day: {}, method: { cash: { amt: 0, n: 0 }, mpesa: { amt: 0, n: 0 }, card: { amt: 0, n: 0 }, other: { amt: 0, n: 0 } }, dept: {}, drug: {}, staff: {} };
        for (var h = 0; h < 24; h++) a.hour.push({ rev: 0, n: 0 });
        for (var d = 0; d < 7; d++) a.dow.push({ rev: 0, n: 0 });
        sales.forEach(function (s) {
            var total = saleTotalOf(s);
            if (s.paid === false) { a.unpaid += total; a.unpaidCount++; return; }
            var ts = tsOf(s), dk = bizDayKey(ts), isRef = !!s.isRefund;
            a.revenue += total; if (isRef) { a.refundN++; a.refundAmt += -total; } else a.count++;
            var cost = typeof reportSaleCost === 'function' ? reportSaleCost(s) : 0; a.cogs += cost;
            var chs = null; if (Array.isArray(s.chargeIds) && s.chargeIds.length) chs = s.chargeIds.map(function (id) { return ctx.chargeById()[id]; }).filter(Boolean);
            var lineSum = 0;
            arr(s.items).forEach(function (it) {
                var q = n0(it.qty), line = n0(it.price) * q; lineSum += line;
                var ch = null;
                if (chs && chs.length) { var nm0 = String(it.name || '').replace(/ \((Piece|Box)\)$/, ''); for (var i = 0; i < chs.length; i++) { if (!chs[i]._used && chs[i].name === nm0 && String(chs[i].code || '') === String(it.code || '')) { chs[i]._used = 1; ch = chs[i]; break; } } }
                var dp = deptOf(it, ch, ctx.byCode); var dd = a.dept[dp] || (a.dept[dp] = { rev: 0, n: 0 }); dd.rev += line; dd.n++;
                if (dp === 'pharmacy' && !isPay(it)) {
                    var uc = unitCost(it, ctx.byCode); a.costLines++; if (!(uc > 0)) a.missingCost++;
                    var key = String(it.code != null && it.code !== '' ? it.code : it.name), o = a.drug[key] || (a.drug[key] = { name: String(it.name || '?'), qty: 0, rev: 0, cost: 0 });
                    o.qty += q; o.rev += line; o.cost += uc * q;
                }
            });
            if (chs) chs.forEach(function (c) { delete c._used; });
            var extra = total - lineSum; if (Math.abs(extra) > 0.005) { var dl = a.dept.delivery || (a.dept.delivery = { rev: 0, n: 0 }); dl.rev += extra; dl.n++; }
            var hr = hourOf(ts); a.hour[hr].rev += total; if (!isRef) a.hour[hr].n++;
            var dw = keyDow(dk); a.dow[dw].rev += total; if (!isRef) a.dow[dw].n++;
            var day = a.day[dk] || (a.day[dk] = { rev: 0, n: 0, cogs: 0 }); day.rev += total; if (!isRef) day.n++; day.cogs += cost;
            // payment mix: the amounts the till recorded; a sale without them counts wholly under its method
            var m = String(s.paymentMethod || 'cash'), cash = s.cashAmount, mp = s.mpesaAmount, cd = s.cardAmount;
            var hasAmts = typeof cash === 'number' || typeof mp === 'number' || typeof cd === 'number', parts = [];
            if (hasAmts) { if (n0(cash) > 0) parts.push(['cash', n0(cash)]); if (n0(mp) > 0) parts.push(['mpesa', n0(mp)]); if (n0(cd) > 0) parts.push(['card', n0(cd)]); }
            var sum = parts.reduce(function (x, y) { return x + y[1]; }, 0);
            if (!parts.length) parts = [[m === 'mpesa' || m === 'card' || m === 'cash' ? m : 'other', total]];
            else if (total - sum > 0.5) parts.push([m === 'mpesa' || m === 'card' || m === 'cash' ? m : 'other', total - sum]);
            parts.forEach(function (pp) { var b = a.method[pp[0]] || a.method.other; b.amt += pp[1]; if (pp[1] > 0) b.n++; });
            var who = s.servedBy || 'Unassigned', st = a.staff[who] || (a.staff[who] = { rev: 0, n: 0, last: 0 });
            st.rev += total; if (!isRef) st.n++; if (ts > st.last) st.last = ts;
        });
        return a;
    }
    function aggVisits(list, reg) {
        var v = { n: 0, ip: 0, op: 0, pts: {}, hour: [], dow: [], day: {}, staff: {} };
        for (var h = 0; h < 24; h++) v.hour.push(0);
        for (var d = 0; d < 7; d++) v.dow.push(0);
        list.forEach(function (x) {
            var ts = tsOf(x), dk = bizDayKey(ts); v.n++; if (x.visitType === 'inpatient') v.ip++; else v.op++;
            if (x.patientId != null) v.pts[x.patientId] = 1;
            v.hour[hourOf(ts)]++; v.dow[keyDow(dk)]++; v.day[dk] = (v.day[dk] || 0) + 1;
            var who = x.seenBy || 'Unassigned'; v.staff[who] = (v.staff[who] || 0) + 1;
        });
        return v;
    }
    function stockRows() {
        var out = [], lim = n0(g('EXPIRY_WARNING_DAYS')) || 30;
        arr(g('inventory')).forEach(function (p) {
            if (!p || p.removed || p._deleted) return;
            if (typeof isStockedProduct === 'function' ? !isStockedProduct(p) : (p.type === 'service')) return;
            var exp = p.expiryDate || '';
            if (Array.isArray(p.batches) && p.batches.length) { var bs = p.batches.filter(function (b) { return b && n0(b.qty) > 0 && b.expiryDate; }).map(function (b) { return b.expiryDate; }).sort(); if (bs.length) exp = bs[0]; }
            var left = exp && typeof daysUntilExpiry === 'function' ? daysUntilExpiry(exp) : null;
            out.push({ name: p.name, code: p.code, key: String(p.code), qty: n0(p.qty), cost: n0(p.wholesalePrice), exp: exp, left: left, lim: lim });
        });
        return out;
    }
    function dayBucketsOf(list, keyFn) { var o = {}; list.forEach(function (x) { var k = keyFn(x); o[k] = (o[k] || 0) + 1; }); return o; }
    D.compute = function (range) {
        var money = D.canSeeMoney(), byCode = invIndex(), all = arr(g('salesLog'));
        var chMap = null; var ctx = { byCode: byCode, chargeById: function () { if (!chMap) { chMap = {}; arr(g('patientCharges')).forEach(function (c) { if (c && c.id != null) chMap[c.id] = c; }); } return chMap; } };
        var cur = [], prev = [], lastSale = {};
        all.forEach(function (s) {
            if (!s || s.voided || s._deleted) return;
            var t = tsOf(s);
            if (inR(t, range.from, range.to)) cur.push(s); else if (inR(t, range.prevFrom, range.prevTo)) prev.push(s);
        });
        var A = aggregate(cur, ctx), P = aggregate(prev, ctx);
        var hasCost = A.costLines > 0 && A.missingCost < A.costLines;
        // expenses
        var expAll = arr(g('expenses')).filter(function (e) { return e && !e.removed && !e._deleted; });
        var exp = expAll.filter(function (e) { return inR(tsOf(e), range.from, range.to); }), expPrevTotal = expAll.filter(function (e) { return inR(tsOf(e), range.prevFrom, range.prevTo); }).reduce(function (s, e) { return s + n0(e.amount); }, 0);
        var expTotal = exp.reduce(function (s, e) { return s + n0(e.amount); }, 0), expCat = {}; exp.forEach(function (e) { var k = e.category || 'Other'; expCat[k] = (expCat[k] || 0) + n0(e.amount); });
        // patients and visits (counts only)
        var pats = arr(g('patients')).filter(function (p) { return p && !p._deleted; }), reg = {}; pats.forEach(function (p) { reg[p.id] = n0(p.registeredAt); });
        var vAll = arr(g('visits')).filter(function (v) { return v && !v.voided && !v._deleted; });
        var vCur = [], vPrev = []; vAll.forEach(function (v) { var t = tsOf(v); if (inR(t, range.from, range.to)) vCur.push(v); else if (inR(t, range.prevFrom, range.prevTo)) vPrev.push(v); });
        var V = aggVisits(vCur, reg), VP = aggVisits(vPrev, reg);
        var seen = Object.keys(V.pts), seenPrev = Object.keys(VP.pts);
        var firstTime = seen.filter(function (id) { return reg[id] && inR(reg[id], range.from, range.to); }).length;
        var returning = seen.filter(function (id) { return reg[id] && reg[id] < range.from; }).length;
        var newPts = pats.filter(function (p) { return inR(n0(p.registeredAt), range.from, range.to); }), newPrev = pats.filter(function (p) { return inR(n0(p.registeredAt), range.prevFrom, range.prevTo); }).length;
        // appointments in the period
        var apptStatus = {}, apptN = 0; arr(g('appointments')).forEach(function (a) { if (!a || a._deleted) return; var t = n0(a.scheduledFor); if (inR(t, range.from, range.to)) { apptN++; var k = a.status || 'scheduled'; apptStatus[k] = (apptStatus[k] || 0) + 1; } });
        // wards
        var adm = arr(g('admissions')).filter(function (a) { return a && !a._deleted; });
        var rooms = arr(g('rooms')), rs = g('roomStates') || {}, occupied = rooms.filter(function (r) { var s = rs[r]; return s && (s.status === 'occupied' || s.status === 'reserved'); }).length;
        var wards = { now: adm.filter(function (a) { return a.status === 'admitted'; }).length, admitted: adm.filter(function (a) { return inR(n0(a.admittedAt), range.from, range.to); }).length, discharged: adm.filter(function (a) { return a.status === 'discharged' && inR(n0(a.dischargedAt), range.from, range.to); }).length, beds: rooms.length, occupied: occupied };
        // maternity (counts, from the patient records)
        var mat = { anc: 0, deliveries: 0, newborns: 0, labourStarted: 0, inLabour: 0, mothers: 0 };
        pats.forEach(function (p) {
            var m = p.maternity; if (!m) return; mat.mothers++;
            arr(m.ancVisits).forEach(function (v) { if (inR(n0(v && v.at), range.from, range.to)) mat.anc++; });
            arr(m.deliveries).forEach(function (d) { if (d && inR(n0(d.at), range.from, range.to)) { mat.deliveries++; mat.newborns += arr(d.newborns).length; } });
            if (m.labour) { if (inR(n0(m.labour.startedAt), range.from, range.to)) mat.labourStarted++; if (!m.labour.endedAt) mat.inLabour++; }
        });
        // diagnostics and theatre
        var labs = arr(g('labResults')).filter(function (t) { return t && !t._deleted; }), rad = arr(g('radiologyOrders')).filter(function (o) { return o && !o._deleted; }), th = arr(g('theatreCases')).filter(function (c) { return c && !c._deleted; });
        var diag = { labReq: labs.filter(function (t) { return inR(n0(t.requestedAt), range.from, range.to); }).length, labDone: labs.filter(function (t) { return t.status === 'completed' && inR(n0(t.resultAt), range.from, range.to); }).length, labPending: labs.filter(function (t) { return t.status === 'pending'; }).length,
            radReq: rad.filter(function (o) { return inR(n0(o.requestedAt), range.from, range.to); }).length, radOpen: rad.filter(function (o) { return ['requested', 'scheduled', 'performed'].indexOf(o.status) >= 0; }).length,
            thReq: th.filter(function (c) { return inR(n0(c.requestedAt), range.from, range.to); }).length, thIn: th.filter(function (c) { return c.status === 'in_theatre'; }).length };
        // stock
        var rows = stockRows(), limit = typeof g('LOW_STOCK_THRESHOLD') === 'number' ? g('LOW_STOCK_THRESHOLD') : 3;
        var invValue = rows.reduce(function (s, r) { return s + r.qty * r.cost; }, 0), units = rows.reduce(function (s, r) { return s + Math.max(0, r.qty); }, 0);
        var low = rows.filter(function (r) { return r.qty > 0 && r.qty <= limit; }), out = rows.filter(function (r) { return r.qty <= 0; });
        var expired = rows.filter(function (r) { return r.qty > 0 && r.left != null && r.left < 0; }), expiring = rows.filter(function (r) { return r.qty > 0 && r.left != null && r.left >= 0 && r.left <= r.lim; });
        var noCost = rows.filter(function (r) { return r.qty > 0 && !(r.cost > 0); });
        var soldKeys = {}; Object.keys(A.drug).forEach(function (k) { soldKeys[k] = 1; });
        var slow = rows.filter(function (r) { return r.qty > 0 && !soldKeys[r.key]; }).map(function (r) { return { name: r.name, qty: r.qty, value: r.qty * r.cost }; }).sort(function (a, b) { return b.value - a.value || b.qty - a.qty; });
        // money still to collect (not range-based: it is what is owed right now)
        var ch = arr(g('patientCharges')).filter(function (c) { return c && c.status === 'unpaid'; }), chRefs = {}; ch.forEach(function (c) { chRefs[c.ref] = 1; });
        var unpaidAmt = ch.reduce(function (s, c) { return s + n0(c.price) * n0(c.qty); }, 0), noPrice = ch.filter(function (c) { return !(n0(c.price) > 0); }).length;
        var bl = arr(g('bills')).filter(function (b) { return b && !b.voided && !b.closed; });
        var owedOf = function (b) { return Math.max(0, (typeof billTotalOf === 'function' ? billTotalOf(b) : 0) - n0(b.amountPaid)); };
        var billOwed = bl.reduce(function (s, b) { return s + owedOf(b); }, 0), todayKey = bizDayKey(Date.now());
        var overdue = bl.filter(function (b) { return b.dueDate && b.dueDate < todayKey && owedOf(b) > 0; }).length;
        var dl = arr(g('debts')).filter(function (d) { return d && !d.removed; }), debtOwed = dl.reduce(function (s, d) { return s + (typeof debtBalance === 'function' ? debtBalance(d) : Math.max(0, n0(d.amount) - arr(d.payments).reduce(function (x, p) { return x + n0(p.amount); }, 0))); }, 0);
        var inst = arr(g('institutions')).filter(function (i) { return i && !i._deleted; }), instOwed = inst.reduce(function (s, i) { return s + Math.max(0, n0(i.balance)); }, 0);
        var owing = {}; bl.forEach(function (b) { if (owedOf(b) > 0) owing['b:' + (b.customerPhone || b.customerName || b.id)] = 1; });
        var recv = { unpaidAmt: unpaidAmt, unpaidBills: Object.keys(chRefs).length, noPrice: noPrice, billOwed: billOwed, billCount: bl.length, overdue: overdue, debtOwed: debtOwed, instOwed: instOwed, instCount: inst.filter(function (i) { return n0(i.balance) > 0; }).length, total: unpaidAmt + billOwed + debtOwed + instOwed };
        // live flow (the app's own snapshot + station stats)
        var ops = null; try { if (typeof hospitalOpsSnapshot === 'function') ops = hospitalOpsSnapshot(); } catch (e) { ops = null; }
        var stations = [], waitSum = 0, waitN = 0, longest = 0, nowMs = Date.now(), since = typeof hmisDayStart === 'function' ? hmisDayStart() : 0;
        try {
            if (typeof hmisStations === 'function' && typeof hmisStationStats === 'function') stations = hmisStations().filter(function (st) { return !st.legacy; }).map(function (st) { var x = hmisStationStats(st.id); return { label: String(st.label || st.id).replace(/^[^\p{L}\p{N}]+/u, '').trim(), waiting: x.waiting, serving: x.serving, done: x.completedToday, avg: x.avgWaitMin, priority: x.priority }; }).filter(function (r) { return r.waiting || r.serving || r.done; });
            arr(g('queue')).forEach(function (q) {
                arr(q && q.events).forEach(function (e) { if (e && e.action === 'called' && e.at >= since && typeof e.waitedMs === 'number') { waitSum += e.waitedMs; waitN++; } });
                if (q && q.status !== 'done' && (typeof hmisStationStatus === 'function' ? hmisStationStatus(q) : 'waiting') === 'waiting') { var st0 = typeof hmisStationAt === 'function' ? hmisStationAt(q) : n0(q.arrivedAt); if (st0 && nowMs - st0 > longest) longest = nowMs - st0; }
            });
        } catch (e) { stations = []; }
        var flow = { stations: stations, avgWaitMin: waitN ? Math.round(waitSum / waitN / 60000) : null, longestMin: longest ? Math.round(longest / 60000) : null };
        // staff
        var staffMap = {};
        Object.keys(V.staff).forEach(function (k) { (staffMap[k] = staffMap[k] || { name: k, visits: 0, sales: 0, rev: 0, last: 0 }).visits = V.staff[k]; });
        Object.keys(A.staff).forEach(function (k) { var o = staffMap[k] = staffMap[k] || { name: k, visits: 0, sales: 0, rev: 0, last: 0 }; o.sales = A.staff[k].n; o.rev = A.staff[k].rev; o.last = A.staff[k].last; });
        var staffRows = Object.keys(staffMap).map(function (k) { return staffMap[k]; });
        // series (hourly for one day, daily up to 62 days, weekly beyond)
        var newDay = dayBucketsOf(newPts, function (p) { return bizDayKey(n0(p.registeredAt)); }), newHour = []; for (var hh = 0; hh < 24; hh++) newHour.push(0); newPts.forEach(function (p) { newHour[hourOf(n0(p.registeredAt))]++; });
        var series = [], perHour = range.days === 1, dk = range.fromKey, guard = 0;
        if (perHour) { for (var h = 0; h < 24; h++) series.push({ key: h, label: (h % 12 || 12) + (h < 12 ? 'a' : 'p'), long: pad(h) + ':00', rev: A.hour[h].rev, n: A.hour[h].n, visits: V.hour[h], newpts: newHour[h], profit: 0 }); }
        else if (range.days <= 62) { while (dk <= range.toKey && guard++ < 400) { var dd = A.day[dk] || { rev: 0, n: 0, cogs: 0 }; series.push({ key: dk, label: keyLabel(dk), long: keyLabel(dk), rev: dd.rev, n: dd.n, visits: V.day[dk] || 0, newpts: newDay[dk] || 0, profit: dd.rev - dd.cogs }); dk = keyAdd(dk, 1); } }
        else {
            var wk = {}, add = function (k, f, v) { var w = keyAdd(k, -keyDow(k)); var o = wk[w] || (wk[w] = { rev: 0, n: 0, visits: 0, newpts: 0, cogs: 0 }); o[f] += v; };
            Object.keys(A.day).forEach(function (k) { add(k, 'rev', A.day[k].rev); add(k, 'n', A.day[k].n); add(k, 'cogs', A.day[k].cogs); });
            Object.keys(V.day).forEach(function (k) { add(k, 'visits', V.day[k]); }); Object.keys(newDay).forEach(function (k) { add(k, 'newpts', newDay[k]); });
            Object.keys(wk).sort().forEach(function (k) { var o = wk[k]; series.push({ key: k, label: keyLabel(k), long: 'Week of ' + keyLabel(k), rev: o.rev, n: o.n, visits: o.visits, newpts: o.newpts, profit: o.rev - o.cogs }); });
        }
        var peakHour = -1, peakVal = 0; V.hour.forEach(function (x, i) { if (x > peakVal) { peakVal = x; peakHour = i; } });
        var bestDow = -1, bestDowVal = 0; V.dow.forEach(function (x, i) { if (x > bestDowVal) { bestDowVal = x; bestDow = i; } });
        // recent activity: what happened and who did it - never a patient or a diagnosis
        var recent = [];
        if (money) arr(all).slice(-60).forEach(function (s) { if (s && !s.voided && !s._deleted && s.paid !== false) recent.push({ t: tsOf(s), icon: s.isRefund ? '↩️' : '💳', what: s.isRefund ? 'Refund paid' : 'Payment received', who: s.servedBy || '', amt: saleTotalOf(s), tab: 'daily-sales-tab' }); });
        vAll.slice(-40).forEach(function (v) { recent.push({ t: tsOf(v), icon: '🩺', what: v.visitType === 'inpatient' ? 'Inpatient visit recorded' : 'Consultation recorded', who: v.seenBy || '', amt: null, tab: 'diagnosis-tab' }); });
        pats.slice(-30).forEach(function (p) { if (n0(p.registeredAt)) recent.push({ t: n0(p.registeredAt), icon: '🗂️', what: 'Patient registered', who: '', amt: null, tab: 'patients-tab' }); });
        adm.slice(-20).forEach(function (a) { if (n0(a.admittedAt)) recent.push({ t: n0(a.admittedAt), icon: '🛏️', what: 'Patient admitted', who: '', amt: null, tab: 'tables-rooms-tab' }); if (n0(a.dischargedAt)) recent.push({ t: n0(a.dischargedAt), icon: '🏁', what: 'Patient discharged', who: '', amt: null, tab: 'tables-rooms-tab' }); });
        labs.slice(-30).forEach(function (t) { if (n0(t.requestedAt)) recent.push({ t: n0(t.requestedAt), icon: '🧪', what: 'Lab test requested', who: t.requestedBy || '', amt: null, tab: 'laboratory-tab' }); });
        if (money) expAll.slice(-20).forEach(function (e) { recent.push({ t: tsOf(e), icon: '💸', what: 'Expense recorded', who: e.by || e.servedBy || '', amt: n0(e.amount), tab: 'profits-tab' }); });
        recent.sort(function (a, b) { return b.t - a.t; });
        var salesEver = all.length, anyData = salesEver + vAll.length + pats.length + arr(g('queue')).length + adm.length;
        return { range: range, money: money, A: A, P: P, hasCost: hasCost, V: V, VP: VP, seen: seen.length, seenPrev: seenPrev.length, firstTime: firstTime, returning: returning, newPts: newPts.length, newPrev: newPrev, totalPatients: pats.length,
            expTotal: expTotal, expPrevTotal: expPrevTotal, expCat: expCat, exp: exp, apptStatus: apptStatus, apptN: apptN, wards: wards, mat: mat, diag: diag,
            rows: rows, invValue: invValue, units: units, low: low, out: out, expired: expired, expiring: expiring, noCost: noCost, slow: slow, limit: limit, recv: recv, ops: ops, flow: flow, staffRows: staffRows,
            series: series, seriesProfitOk: hasCost && !perHour, perHour: perHour, peakHour: peakHour, peakVal: peakVal, bestDow: bestDow, bestDowVal: bestDowVal, recent: recent.slice(0, 14), salesEver: salesEver, anyData: anyData };
    };

    /* ---------- chart helpers (inline SVG, theme-aware via CSS variables) ---------- */
    function niceMax(v) { if (v <= 0) return 1; var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
    function spark(vals, color) {
        if (!vals || vals.length < 2 || !vals.some(function (v) { return v > 0; })) return '';
        var w = 80, h = 26, mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals), rng = mx - mn || 1;
        var pts = vals.map(function (v, i) { return (i / (vals.length - 1) * w).toFixed(1) + ',' + (h - 3 - (v - mn) / rng * (h - 6)).toFixed(1); }).join(' ');
        return '<svg class="dh-spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + pts + '" fill="none" stroke="' + (color || 'var(--dh-c1)') + '" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>';
    }
    var root = null;
    function cwid(def) { var cw = (root && root.clientWidth) || 0; return cw && cw < 700 ? Math.max(280, cw - 32) : def; }
    function lineChart(pts, key, isMoney, tipOf) {
        if (!pts.length || !pts.some(function (p) { return p[key] > 0; })) return '';
        var W = cwid(900), H = W < 500 ? 210 : 250, L = W < 500 ? 40 : 50, R = 14, T = 14, B = 28, mx = niceMax(Math.max.apply(null, pts.map(function (p) { return p[key]; })));
        var X = function (i) { return pts.length === 1 ? L + (W - L - R) / 2 : L + i * (W - L - R) / (pts.length - 1); }, Y = function (v) { return T + (H - T - B) * (1 - v / mx); };
        var grid = '', i;
        for (i = 0; i <= 4; i++) { var gv = mx * i / 4, gy = Y(gv); grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + gy + '" y2="' + gy + '" class="dh-grid"/><text x="' + (L - 6) + '" y="' + (gy + 4) + '" class="dh-ax" text-anchor="end">' + (isMoney ? short(gv) : (mx < 4 ? (Math.round(gv * 10) / 10) : Math.round(gv))) + '</text>'; }
        var every = Math.max(1, Math.ceil(pts.length / (W < 500 ? 4 : 8))), xl = '';
        pts.forEach(function (p, idx) { if (idx % every === 0 || idx === pts.length - 1) xl += '<text x="' + X(idx) + '" y="' + (H - 8) + '" class="dh-ax" text-anchor="middle">' + esc(p.label) + '</text>'; });
        var line = pts.map(function (p, idx) { return (idx ? 'L' : 'M') + X(idx).toFixed(1) + ' ' + Y(Math.max(0, p[key])).toFixed(1); }).join(' ');
        var area = line + ' L' + X(pts.length - 1).toFixed(1) + ' ' + Y(0) + ' L' + X(0).toFixed(1) + ' ' + Y(0) + ' Z';
        var dots = pts.map(function (p, idx) {
            return '<g class="dh-pt" data-tip="' + esc(tipOf(p)) + '" tabindex="0"><rect x="' + (X(idx) - Math.max(6, (W - L - R) / pts.length / 2)) + '" y="' + T + '" width="' + Math.max(12, (W - L - R) / pts.length) + '" height="' + (H - T - B) + '" fill="transparent"/><circle cx="' + X(idx).toFixed(1) + '" cy="' + Y(Math.max(0, p[key])).toFixed(1) + '" r="' + (pts.length > 40 ? 0 : 3.5) + '" class="dh-dot"/></g>';
        }).join('');
        return '<svg class="dh-line" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Trend chart">' + grid + xl + '<path d="' + area + '" class="dh-area"/><path d="' + line + '" class="dh-stroke"/>' + dots + '</svg>';
    }
    function barChart(items, opts) {   // items: [{label, value, tip}]
        opts = opts || {};
        if (!items.length || !items.some(function (i) { return i.value > 0; })) return '';
        var W = cwid(640), H = 190, L = 38, R = 8, T = 10, B = 26, mx = niceMax(Math.max.apply(null, items.map(function (i) { return i.value; })));
        var bw = (W - L - R) / items.length, g2 = '', i;
        for (i = 0; i <= 3; i++) { var v = mx * i / 3, y = T + (H - T - B) * (1 - v / mx); g2 += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" class="dh-grid"/><text x="' + (L - 5) + '" y="' + (y + 4) + '" class="dh-ax" text-anchor="end">' + (mx < 4 ? Math.round(v * 10) / 10 : short(v)) + '</text>'; }
        var every = Math.max(1, Math.ceil(items.length / (W < 500 ? 6 : 12)));
        var bars = items.map(function (it, idx) {
            var h = (H - T - B) * it.value / mx, x = L + idx * bw + bw * 0.14, w = bw * 0.72, y = T + (H - T - B) - h, hot = opts.hot === idx;
            return '<g class="dh-pt" data-tip="' + esc(it.tip) + '" tabindex="0"><rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(0, h).toFixed(1) + '" rx="3" class="dh-bar' + (hot ? ' hot' : '') + '"/>' + (idx % every === 0 ? '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (H - 8) + '" class="dh-ax" text-anchor="middle">' + esc(it.label) + '</text>' : '') + '<rect x="' + (L + idx * bw) + '" y="' + T + '" width="' + bw + '" height="' + (H - T - B) + '" fill="transparent"/></g>';
        }).join('');
        return '<svg class="dh-line" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opts.label || 'Bar chart') + '">' + g2 + bars + '</svg>';
    }
    function donut(slices, centerTop, centerSub, unitFmt) {   // [{label, value, color}]
        var tot = slices.reduce(function (s, x) { return s + x.value; }, 0); if (!(tot > 0)) return '';
        var R = 54, C = 2 * Math.PI * R, off = 0, segs = '', f = unitFmt || kes;
        slices.forEach(function (s) { var len = s.value / tot * C; segs += '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="' + s.color + '" stroke-width="20" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 70 70)" class="dh-slice" data-tip="' + esc(s.label + ' · ' + f(s.value) + ' · ' + pct(s.value, tot) + '%') + '"/>'; off += len; });
        return '<svg class="dh-donut" viewBox="0 0 140 140" role="img" aria-label="Share chart">' + segs + '<text x="70" y="68" text-anchor="middle" class="dh-dtop">' + esc(centerTop) + '</text><text x="70" y="84" text-anchor="middle" class="dh-dsub">' + esc(centerSub) + '</text></svg>';
    }
    function delta(cur, prev, minPrev) { if (!(prev > (minPrev || 0))) return null; return Math.round((cur - prev) / prev * 1000) / 10; }
    function deltaHtml(d, cmp, invert) {
        if (d == null) return '<span class="dh-delta flat">No earlier data to compare</span>';
        var up = d > 0, cls = d === 0 ? 'flat' : ((up !== !!invert) ? 'up' : 'down');
        return '<span class="dh-delta ' + cls + '">' + (d === 0 ? '→' : up ? '↑' : '↓') + ' ' + Math.abs(d) + '% vs ' + esc(cmp) + '</span>';
    }

    /* ---------- widgets ---------- */
    function orderOf(id) { var i = S.order.indexOf(id); if (i >= 0) return i; for (var k = 0; k < WIDGETS.length; k++) if (WIDGETS[k][0] === id) return 100 + k; return 999; }
    function card(id, title, body, extra) {
        return '<section class="dh-card dh-w-' + (extra && extra.span || 6) + '" data-w="' + id + '" style="order:' + orderOf(id) + '"><header class="dh-card-h"><h4>' + title + '</h4>' + ((extra && extra.head) || '') + '</header><div class="dh-card-b">' + body + '</div></section>';
    }
    function empty(msg) { return '<p class="dh-empty">' + esc(msg) + '</p>'; }
    function viewBtn(tab, label) { return tabVisible(tab) ? '<button type="button" class="dh-link" data-goto="' + tab + '">' + esc(label || 'View report') + ' →</button>' : ''; }
    function tiles(list) { return '<div class="dh-stats">' + list.map(function (s) { return '<div' + (s[2] && tabVisible(s[2]) ? ' class="go" data-goto="' + s[2] + '" role="button" tabindex="0"' : '') + '><b>' + s[1] + '</b><small>' + s[0] + '</small></div>'; }).join('') + '</div>'; }
    var W = {};
    W.trend = function (d) {
        var m = S.metric || (d.money ? 'revenue' : 'visits');
        var defs = [['revenue', 'Revenue', 1], ['visits', 'Visits', 0], ['txns', 'Payments', 1], ['newpts', 'New patients', 0]].filter(function (t) { return !t[2] || d.money; });
        if (!defs.some(function (t) { return t[0] === m; })) m = defs[0][0];
        var key = { revenue: 'rev', visits: 'visits', txns: 'n', newpts: 'newpts' }[m], isMoney = m === 'revenue';
        var tabs = defs.map(function (t) { return '<button type="button" class="dh-seg-btn' + (m === t[0] ? ' on' : '') + '" data-metric="' + t[0] + '">' + t[1] + '</button>'; }).join('');
        var chart = lineChart(d.series, key, isMoney, function (p) { return p.long + ' · ' + pl(p.visits, 'visit', 'visits') + ' · ' + pl(p.newpts, 'new patient', 'new patients') + (d.money ? ' · ' + kes(p.rev) + ' · ' + pl(p.n, 'payment', 'payments') + (d.seriesProfitOk ? ' · gross profit ' + kes(p.profit) : '') : ''); });
        return card('trend', 'Activity trend <span class="dh-sub">' + esc(d.range.text) + '</span>', chart ? '<div class="dh-seg">' + tabs + '</div>' + chart + '<p class="dh-note">' + (d.perHour ? 'By hour of the business day.' : d.range.days > 62 ? 'By week.' : 'By day.') + (d.money ? ' Revenue matches Daily Sales.' : '') + '</p>' : '<div class="dh-seg">' + tabs + '</div>' + empty('Nothing recorded for this metric in this period.'), { span: 12, head: viewBtn(d.money ? 'hospital-report-tab' : 'queue-tab', d.money ? 'Hospital report' : 'Queue') });
    };
    W.departments = function (d) {
        var A = d.A, list = DEPTS.map(function (x) { return { k: x[0], name: x[1], rev: A.dept[x[0]] ? A.dept[x[0]].rev : 0, n: A.dept[x[0]] ? A.dept[x[0]].n : 0 }; }).filter(function (x) { return x.rev !== 0; }).sort(function (a, b) { return b.rev - a.rev; });
        if (!list.length) return card('departments', 'Revenue by department', empty('No payments received in this period.'), { span: 6, head: viewBtn('daily-sales-tab', 'Daily sales') });
        var pos = list.filter(function (x) { return x.rev > 0; }), tot = pos.reduce(function (s, x) { return s + x.rev; }, 0), body;
        if (pos.length <= 6) body = '<div class="dh-donut-wrap">' + donut(pos.map(function (x, i) { return { label: x.name, value: x.rev, color: COLORS[i % 6] }; }), short(tot), 'received') + '<ul class="dh-key">' + pos.map(function (x, i) { return '<li><i style="background:' + COLORS[i % 6] + '"></i><span>' + esc(x.name) + '</span><b>' + pct(x.rev, tot) + '%</b><small>' + kes(x.rev) + ' · ' + pl(x.n, 'line', 'lines') + '</small></li>'; }).join('') + '</ul></div>';
        else { var mx = pos[0].rev || 1; body = '<ul class="dh-bars">' + pos.map(function (x) { return '<li><span>' + esc(x.name) + '</span><div><i style="width:' + Math.max(2, x.rev / mx * 100).toFixed(1) + '%"></i></div><b>' + pct(x.rev, tot) + '%</b><small>' + kes(x.rev) + '</small></li>'; }).join('') + '</ul>'; }
        var neg = list.filter(function (x) { return x.rev < 0; });
        return card('departments', 'Revenue by department', body + (neg.length ? '<p class="dh-row">' + neg.map(function (x) { return esc(x.name) + ': <b>' + kes(x.rev) + '</b>'; }).join(' · ') + '</p>' : '') + '<p class="dh-note">Adds up to total revenue (' + kes(A.revenue) + '). A line is placed by the bill it came from; lines with no department are "Other services".</p>', { span: 6, head: viewBtn('daily-sales-tab', 'Daily sales') });
    };
    W.patients = function (d) {
        if (!d.V.n && !d.newPts) return card('patients', 'Patients seen', empty('No consultations or registrations in this period.'), { span: 6, head: viewBtn('patients-tab', 'Patient records') });
        var unknown = Math.max(0, d.seen - d.firstTime - d.returning);
        var slices = [{ label: 'First visit (registered in period)', value: d.firstTime, color: COLORS[0] }, { label: 'Returning', value: d.returning, color: COLORS[1] }, { label: 'Registration date unknown', value: unknown, color: COLORS[2] }].filter(function (s) { return s.value > 0; });
        var dn = donut(slices, String(d.seen), 'patients', function (v) { return String(v); });
        return card('patients', 'Patients seen', tiles([['Patients seen', d.seen, 'diagnosis-tab'], ['Visits', d.V.n], ['Outpatient visits', d.V.op], ['Inpatient visits', d.V.ip], ['New registrations', d.newPts, 'patients-tab'], ['Registered in total', d.totalPatients]])
            + '<p class="dh-row">' + deltaHtml(delta(d.seen, d.seenPrev, 0), d.range.cmp) + '</p>'
            + (dn ? '<div class="dh-donut-wrap">' + dn + '<ul class="dh-key">' + slices.map(function (s) { return '<li><i style="background:' + s.color + '"></i><span>' + esc(s.label) + '</span><b>' + s.value + '</b><small>' + pct(s.value, d.seen) + '% of patients seen</small></li>'; }).join('') + '</ul></div>' : '')
            + '<p class="dh-note">Distinct patients with a recorded consultation in the period. Counts only - no names or diagnoses are shown here.</p>', { span: 6, head: viewBtn('patients-tab', 'Patient records') });
    };
    W.flow = function (d) {
        var o = d.ops, f = d.flow;
        var st = o ? tiles([['In the facility now', o.queueWaiting, 'queue-tab'], ['Emergency waiting', o.emergencyWaiting, 'queue-tab'], ['Appointments today', o.appointmentsToday, 'appointments-tab'], ['Longest wait now', f.longestMin == null ? '—' : f.longestMin + ' min'], ['Avg wait today', f.avgWaitMin == null ? '—' : f.avgWaitMin + ' min']]) : empty('Queue figures are not available on this device.');
        var tbl = f.stations.length ? '<h5>Stations today</h5><div class="dh-tbl"><table><thead><tr><th>Station</th><th>Waiting</th><th>Serving</th><th>Done</th><th>Avg wait</th></tr></thead><tbody>' + f.stations.map(function (r) { return '<tr><td>' + esc(r.label) + '</td><td>' + r.waiting + '</td><td>' + r.serving + '</td><td>' + r.done + '</td><td>' + (r.avg == null ? '—' : r.avg + ' min') + '</td></tr>'; }).join('') + '</tbody></table></div>' : '';
        var ap = Object.keys(d.apptStatus), apl = ap.length ? '<h5>Appointments in ' + esc(d.range.text) + ' (' + d.apptN + ')</h5><ul class="dh-plain">' + ap.map(function (k) { return '<li>' + esc(k.replace(/[-_]/g, ' ')) + ' <b>' + d.apptStatus[k] + '</b></li>'; }).join('') + '</ul>' : '';
        return card('flow', 'Queue & appointments', st + tbl + apl + '<p class="dh-note">Queue figures are live (right now / today); appointments follow the period you picked.</p>', { span: 6, head: viewBtn('queue-tab', 'Queue') });
    };
    W.clinical = function (d) {
        var w = d.wards, m = d.mat, x = d.diag;
        return card('clinical', 'Wards, maternity & diagnostics',
            '<h5>Wards</h5>' + tiles([['Admitted now', w.now, 'tables-rooms-tab'], ['Admitted in period', w.admitted], ['Discharged in period', w.discharged], ['Beds in use', w.beds ? w.occupied + ' / ' + w.beds + ' (' + Math.round(w.occupied / w.beds * 100) + '%)' : 'No beds set up']])
            + '<h5>Maternity</h5>' + tiles([['ANC visits', m.anc, 'maternity-tab'], ['Deliveries', m.deliveries, 'labour-tab'], ['Newborns registered', m.newborns], ['In labour now', m.inLabour]])
            + '<h5>Diagnostics & theatre</h5>' + tiles([['Lab tests requested', x.labReq, 'laboratory-tab'], ['Lab results in', x.labDone], ['Lab pending now', x.labPending], ['Imaging requested', x.radReq, 'radiology-tab'], ['Imaging open now', x.radOpen], ['Theatre cases requested', x.thReq, 'theatre-tab'], ['In theatre now', x.thIn]])
            + '<p class="dh-note">Counts from the ward, maternity, laboratory, radiology and theatre records. No patient is named.</p>', { span: 6, head: viewBtn('hospital-report-tab', 'Hospital report') });
    };
    W.drugs = function (d) {
        var by = S.topBy; if (by !== 'qty' && !d.money) by = 'qty';
        var list = Object.keys(d.A.drug).map(function (k) { var o = d.A.drug[k]; return { name: o.name, qty: o.qty, rev: o.rev, profit: o.cost > 0 ? o.rev - o.cost : null }; });
        if (!list.length) return card('drugs', 'Top medicines', empty('No medicines sold in this period.'), { span: 6, head: viewBtn('pharmacy-tab', 'Pharmacy') });
        var val = function (o) { return by === 'revenue' ? o.rev : by === 'profit' ? (o.profit == null ? -1e12 : o.profit) : o.qty; };
        list.sort(function (a, b) { return val(b) - val(a); });
        var shown = S.topAll ? list.slice(0, 100) : list.slice(0, 8);
        var tdefs = [['qty', 'Quantity', 0], ['revenue', 'Revenue', 1], ['profit', 'Profit', 1]].filter(function (t) { return (!t[2] || d.money) && (t[0] !== 'profit' || d.hasCost); });
        var tabs = tdefs.length > 1 ? '<div class="dh-seg">' + tdefs.map(function (t) { return '<button type="button" class="dh-seg-btn' + (by === t[0] ? ' on' : '') + '" data-topby="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>' : '';
        var rows = shown.map(function (o, i) { return '<li><em class="dh-rank">#' + (i + 1) + '</em><div class="dh-thumb"><span>' + esc((o.name || '?').charAt(0).toUpperCase()) + '</span></div><div class="dh-li-main"><b>' + esc(o.name) + '</b><small>' + fmtQty(o.qty) + ' dispensed / sold</small></div>' + (d.money ? '<div class="dh-li-val"><b>' + kes(o.rev) + '</b>' + (d.hasCost && o.profit != null ? '<small>profit ' + kes(o.profit) + '</small>' : '') + '</div>' : '') + '</li>'; }).join('');
        return card('drugs', 'Top medicines', tabs + '<ul class="dh-list">' + rows + '</ul>' + (list.length > 8 ? '<button type="button" class="dh-more" data-topall="1">' + (S.topAll ? 'Show top 8' : 'View all ' + list.length + ' medicines') + '</button>' : ''), { span: 6, head: viewBtn('pharmacy-tab', 'Pharmacy') });
    };
    W.stock = function (d) {
        if (!d.rows.length) return card('stock', 'Drug stock & expiry', empty('No pharmacy stock recorded yet.'), { span: 6, head: viewBtn('inventory-list-tab', 'Pharmacy stock') });
        var t = [['Items stocked', d.rows.length, 'inventory-list-tab'], ['Units in stock', fmtQty(d.units)]]; if (d.money) t.push(['Stock value (cost)', kes(d.invValue)]);
        t.push(['Low stock (≤ ' + d.limit + ')', d.low.length], ['Out of stock', d.out.length], ['Expired, still in stock', d.expired.length], ['Expiring in ≤ ' + (n0(g('EXPIRY_WARNING_DAYS')) || 30) + ' days', d.expiring.length], ['No sales in period', d.slow.length]);
        var li = function (title, list, f) { return list.length ? '<details class="dh-det"><summary>' + title + ' (' + list.length + ')</summary><ul class="dh-plain">' + list.slice(0, 8).map(f).join('') + '</ul>' + (list.length > 8 ? '<p class="dh-note">+ ' + (list.length - 8) + ' more</p>' : '') + '</details>' : ''; };
        var dt = function (r) { return r.exp ? new Date(r.exp + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; };
        return card('stock', 'Drug stock & expiry', tiles(t)
            + li('Out of stock', d.out, function (r) { return '<li>' + esc(r.name) + '</li>'; }) + li('Low stock', d.low, function (r) { return '<li>' + esc(r.name) + ' <b>' + fmtQty(r.qty) + '</b></li>'; })
            + li('Expired', d.expired, function (r) { return '<li>' + esc(r.name) + ' <b>' + dt(r) + '</b></li>'; }) + li('Expiring soon', d.expiring, function (r) { return '<li>' + esc(r.name) + ' <b>' + dt(r) + '</b></li>'; })
            + (d.slow.length && d.A.count ? li('No sales in this period', d.slow, function (r) { return '<li>' + esc(r.name) + ' <b>' + (d.money && r.value > 0 ? kes(r.value) : fmtQty(r.qty)) + '</b></li>'; }) : '')
            + '<p class="dh-note">Out of stock = 0 or less; low stock uses the threshold set in Settings. Expiry is the product\'s (or earliest batch\'s) expiry date.</p>', { span: 6, head: viewBtn('inventory-list-tab', 'Pharmacy stock') });
    };
    W.payments = function (d) {
        var m = d.A.method, names = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', other: 'Other' }, list = Object.keys(m).filter(function (k) { return m[k].amt > 0; }).map(function (k) { return { k: k, name: names[k], amt: m[k].amt, n: m[k].n }; }).sort(function (a, b) { return b.amt - a.amt; });
        if (!list.length) return card('payments', 'Payment methods', empty('No payments received in this period.'), { span: 6, head: viewBtn('daily-sales-tab', 'Daily sales') });
        var tot = list.reduce(function (s, x) { return s + x.amt; }, 0);
        return card('payments', 'Payment methods', '<div class="dh-donut-wrap">' + donut(list.map(function (x, i) { return { label: x.name, value: x.amt, color: COLORS[i % 6] }; }), short(tot), 'received') + '<ul class="dh-key">' + list.map(function (x, i) { return '<li><i style="background:' + COLORS[i % 6] + '"></i><span>' + x.name + '</span><b>' + pct(x.amt, tot) + '%</b><small>' + kes(x.amt) + ' · ' + pl(x.n, 'payment', 'payments') + '</small></li>'; }).join('') + '</ul></div>' + (d.A.refundN ? '<p class="dh-row"><b>Refunds paid out:</b> ' + kes(d.A.refundAmt) + ' (' + d.A.refundN + ') - already taken off the figures above.</p>' : ''), { span: 6, head: viewBtn('daily-sales-tab', 'Daily sales') });
    };
    W.receivables = function (d) {
        var r = d.recv;
        if (!(r.total > 0)) return card('receivables', 'Money still to collect', empty('Nothing outstanding right now.'), { span: 6, head: viewBtn('bills-tab', 'Patient bills') });
        return card('receivables', 'Money still to collect', '<button type="button" class="dh-big" data-goto="' + (tabVisible('bills-tab') ? 'bills-tab' : 'sales-tab') + '"><b>' + kes(r.total) + '</b><span>outstanding right now (not limited to the period)</span></button>'
            + tiles([['Unpaid patient bills · ' + r.unpaidBills, kes(r.unpaidAmt), 'sales-tab'], ['Pay-later bills · ' + r.billCount, kes(r.billOwed), 'bills-tab'], ['Debts', kes(r.debtOwed), 'debts-tab'], ['Owed by institutions · ' + r.instCount, kes(r.instOwed), 'contracts-tab']])
            + (r.overdue ? '<p class="dh-warn">⏳ ' + pl(r.overdue, 'pay-later bill is', 'pay-later bills are') + ' past the due date.</p>' : '')
            + (r.noPrice ? '<p class="dh-warn">🏷️ ' + pl(r.noPrice, 'unpaid charge has', 'unpaid charges have') + ' no price yet, so the total is incomplete.</p>' : '')
            + '<p class="dh-note">Unpaid patient bills are charges waiting at the cashier (same as the Hospital Report). No patient names are shown.</p>', { span: 6, head: viewBtn('bills-tab', 'Patient bills') });
    };
    W.profit = function (d) {
        var A = d.A;
        if (!A.count && !A.revenue) return card('profit', 'Profitability', empty('No payments received in this period.'), { span: 6, head: viewBtn('profits-tab', 'Profits & expenses') });
        if (!d.hasCost) return card('profit', 'Profitability', '<p class="dh-empty">Profit on medicines needs buying prices. Add them to your pharmacy stock to see profit here.</p>' + '<table class="dh-mini"><tr><td>Revenue</td><td>' + kes(A.revenue) + '</td></tr><tr><td>Expenses</td><td>' + kes(d.expTotal) + '</td></tr></table>', { span: 6, head: viewBtn('inventory-list-tab', 'Pharmacy stock') });
        var gross = A.revenue - A.cogs, margin = pct(gross, A.revenue), net = gross - d.expTotal, mx = Math.max(A.revenue, A.cogs, Math.abs(gross)) || 1;
        var bar = function (label, v, cls) { return '<div class="dh-hb"><span>' + label + '</span><div><i class="' + cls + '" style="width:' + Math.max(2, Math.abs(v) / mx * 100).toFixed(1) + '%"></i></div><b>' + kes(v) + '</b></div>'; };
        var incomplete = A.missingCost > 0 ? '<p class="dh-warn">⚠️ ' + pl(A.missingCost, 'medicine line has', 'medicine lines have') + ' no buying price, so profit may be higher than shown.</p>' : '';
        var rows = [['Revenue', kes(A.revenue)], ['Cost of medicines sold', kes(A.cogs)], ['Gross profit', kes(gross)], ['Margin on revenue', margin + '%'], ['Expenses', kes(d.expTotal)], ['Net after expenses', kes(net)]];
        return card('profit', 'Profitability', bar('Revenue', A.revenue, 'c1') + bar('Cost', A.cogs, 'c5') + bar('Profit', gross, gross >= 0 ? 'c2' : 'c5') + '<table class="dh-mini">' + rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>'; }).join('') + '</table>' + incomplete + '<p class="dh-note">Same method as Profits &amp; Expenses: cost is the buying price of medicines sold; services carry no cost of their own.</p>', { span: 6, head: viewBtn('profits-tab', 'Profits & expenses') });
    };
    W.expenses = function (d) {
        if (!d.exp.length) return card('expenses', 'Expenses', empty('No expenses recorded in this period.'), { span: 6, head: viewBtn('profits-tab', 'Expenses') });
        var cats = Object.keys(d.expCat).map(function (k) { return { k: k, v: d.expCat[k] }; }).sort(function (a, b) { return b.v - a.v; }), mx = cats[0].v || 1;
        var big = d.exp.slice().sort(function (a, b) { return n0(b.amount) - n0(a.amount); }).slice(0, 4);
        return card('expenses', 'Expenses', '<div class="dh-stats"><div><b>' + kes(d.expTotal) + '</b><small>Total expenses</small></div><div><b>' + (d.A.revenue > 0 ? pct(d.expTotal, d.A.revenue) + '%' : '—') + '</b><small>of revenue</small></div><div>' + deltaHtml(delta(d.expTotal, d.expPrevTotal, 0), d.range.cmp, true) + '</div></div><h5>Top expense categories</h5><ul class="dh-bars">' + cats.slice(0, 5).map(function (c) { return '<li><span>' + esc(c.k) + '</span><div><i style="width:' + Math.max(2, c.v / mx * 100).toFixed(1) + '%"></i></div><b>' + pct(c.v, d.expTotal) + '%</b><small>' + kes(c.v) + '</small></li>'; }).join('') + '</ul><h5>Largest expenses</h5><ul class="dh-plain">' + big.map(function (e) { return '<li>' + esc((e.category || 'Other') + (e.description ? ' · ' + e.description : '')) + ' <b>' + kes(e.amount) + '</b></li>'; }).join('') + '</ul>', { span: 6, head: viewBtn('profits-tab', 'Expenses') });
    };
    W.hours = function (d) {
        if (!d.V.n) return card('hours', 'Busiest hours', empty('No consultations in this period.'), { span: 6 });
        var A = d.A, items = d.V.hour.map(function (x, h) { return { label: (h % 12 || 12) + (h < 12 ? 'a' : 'p'), value: x, tip: pad(h) + ':00–' + pad(h) + ':59 · ' + pl(x, 'consultation', 'consultations') + (d.money ? ' · ' + kes(A.hour[h].rev) + ' received' : '') }; });
        var first = 0, last = 23; while (first < 23 && !d.V.hour[first]) first++; while (last > 0 && !d.V.hour[last]) last--;
        items = items.slice(Math.max(0, first - 1), Math.min(24, last + 2));
        var peak = d.peakHour >= 0 && d.V.n >= 5 ? '<p class="dh-row"><b>Peak period:</b> ' + pad(d.peakHour) + ':00–' + pad(d.peakHour) + ':59 (' + pl(d.peakVal, 'consultation', 'consultations') + ')</p>' : '';
        return card('hours', 'Busiest hours', barChart(items, { label: 'Consultations by hour', hot: items.findIndex(function (i) { return i.value === d.peakVal; }) }) + peak + '<p class="dh-note">Consultations recorded, by hour of the business day.</p>', { span: 6 });
    };
    W.days = function (d) {
        if (d.range.days < 3 || !d.V.n) return card('days', 'Busiest weekdays', empty(d.V.n ? 'Pick a longer period (a week or more) to compare weekdays.' : 'No consultations in this period.'), { span: 6 });
        var nm = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], full = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        return card('days', 'Busiest weekdays', barChart(d.V.dow.map(function (x, i) { return { label: nm[i], value: x, tip: full[i] + ' · ' + pl(x, 'consultation', 'consultations') + (d.money ? ' · ' + kes(d.A.dow[i].rev) + ' received' : '') }; }), { label: 'Consultations by weekday', hot: d.bestDow }) + (d.bestDow >= 0 ? '<p class="dh-row"><b>Busiest day:</b> ' + full[d.bestDow] + ' (' + pl(d.bestDowVal, 'consultation', 'consultations') + ')</p>' : ''), { span: 6 });
    };
    W.staff = function (d) {
        var rows = d.staffRows.slice(), owner = isOwner();
        if (!owner) { var mine = me(); rows = rows.filter(function (r) { return r.name === mine; }); }
        if (!rows.length) return card('staff', 'Staff activity', empty('No staff activity for this period.'), { span: 12 });
        var by = S.staffBy; if ((by === 'rev' || by === 'sales') && !d.money) by = 'visits';
        var val = function (r) { return by === 'sales' ? r.sales : by === 'rev' ? r.rev : r.visits; };
        rows.sort(function (a, b) { return val(b) - val(a) || b.visits - a.visits; });
        var defs = [['visits', 'Consultations', 0], ['sales', 'Payments handled', 1], ['rev', 'Amount received', 1]].filter(function (t) { return !t[2] || d.money; });
        var tabs = defs.map(function (t) { return '<button type="button" class="dh-seg-btn' + (by === t[0] ? ' on' : '') + '" data-staffby="' + t[0] + '">' + t[1] + '</button>'; }).join('');
        var label = { visits: 'consultations recorded', sales: 'payments handled', rev: 'amount received' }[by];
        var mx = Math.max.apply(null, rows.map(val)) || 1, ini = function (n) { return esc(String(n || '?').trim().split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase()); };
        return card('staff', 'Staff activity <span class="dh-sub">ranked by ' + label + '</span>', '<div class="dh-seg">' + tabs + '</div><ul class="dh-list">' + rows.slice(0, 12).map(function (r, i) {
            return '<li><em class="dh-rank">#' + (i + 1) + '</em><div class="dh-avatar">' + ini(r.name) + '</div><div class="dh-li-main"><b>' + esc(r.name) + '</b><small>' + pl(r.visits, 'consultation', 'consultations') + (d.money ? ' · ' + pl(r.sales, 'payment', 'payments') + ' · ' + kes(r.rev) : '') + (r.last && d.money ? ' · last payment ' + new Date(r.last).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '') + '</small><div class="dh-meter"><i style="width:' + Math.max(2, val(r) / mx * 100).toFixed(1) + '%"></i></div></div><div class="dh-li-val"><b>' + (by === 'rev' ? kes(val(r)) : fmtQty(val(r))) + '</b></div></li>';
        }).join('') + '</ul><p class="dh-note">' + (owner ? 'Everyone who recorded a consultation or took a payment in this period.' : 'You can see your own figures only.') + '</p>', { span: 12, head: owner ? viewBtn('staff-tab', 'Staff') : '' });
    };
    D.insights = function (d) {
        var out = [], A = d.A, P = d.P;
        if (d.money) {
            var dl = delta(A.revenue, P.revenue, 0);
            if (dl != null && A.count >= 3) out.push([dl >= 0 ? '📈' : '📉', 'Revenue is ' + (dl >= 0 ? 'up ' : 'down ') + Math.abs(dl) + '% compared with ' + d.range.cmp + ' (' + kes(A.revenue) + ' vs ' + kes(P.revenue) + ').']);
            var ds = Object.keys(A.dept).map(function (k) { return [k, A.dept[k].rev]; }).filter(function (x) { return x[1] > 0; }).sort(function (a, b) { return b[1] - a[1]; }), dt = ds.reduce(function (s, x) { return s + x[1]; }, 0);
            if (ds.length >= 2 && dt > 0) out.push(['🏷️', DEPT_NAME[ds[0][0]] + ' brought in ' + Math.round(ds[0][1] / dt * 100) + '% of revenue.']);
            var allN = A.method.cash.n + A.method.mpesa.n + A.method.card.n + A.method.other.n;
            if (allN >= 10) out.push(['💳', 'Cash was ' + Math.round(A.method.cash.n / allN * 100) + '% of payments, M-Pesa ' + Math.round(A.method.mpesa.n / allN * 100) + '%.']);
            if (d.hasCost && A.revenue > 0) { var mg = pct(A.revenue - A.cogs, A.revenue), pm = P.revenue > 0 ? pct(P.revenue - P.cogs, P.revenue) : null; out.push(['💰', 'Gross margin was ' + mg + '%' + (pm != null && P.count >= 3 ? ' (' + (mg >= pm ? 'up from ' : 'down from ') + pm + '% in ' + d.range.cmp + ')' : '') + '.']); }
            if (d.recv.total > 0 && A.revenue > 0) out.push(['🧾', kes(d.recv.total) + ' is still to be collected (unpaid bills, pay-later bills, debts and institutions).']);
        }
        var vd = delta(d.V.n, d.VP.n, 0);
        if (vd != null && d.V.n >= 3) out.push([vd >= 0 ? '👥' : '📉', 'Consultations are ' + (vd >= 0 ? 'up ' : 'down ') + Math.abs(vd) + '% compared with ' + d.range.cmp + ' (' + d.V.n + ' vs ' + d.VP.n + ').']);
        if (d.seen >= 5 && d.firstTime > 0) out.push(['🗂️', d.firstTime + ' of ' + d.seen + ' patients seen (' + Math.round(d.firstTime / d.seen * 100) + '%) were registered during this period.']);
        if (d.peakHour >= 0 && d.V.n >= 8) out.push(['⏰', 'Your busiest consultation hour was ' + pad(d.peakHour) + ':00–' + pad(d.peakHour) + ':59 (' + d.peakVal + ' consultations).']);
        if (d.flow.avgWaitMin != null) out.push(['⏱️', 'Patients waited ' + d.flow.avgWaitMin + ' min on average before being called today.']);
        if (d.expired.length) out.push(['⛔', pl(d.expired.length, 'medicine is', 'medicines are') + ' past expiry and still counted in stock.']);
        return out;
    };
    W.insights = function (d) {
        var ins = D.insights(d);
        return card('insights', 'Insights', ins.length ? '<ul class="dh-ins">' + ins.map(function (i) { return '<li><span>' + i[0] + '</span>' + esc(i[1]) + '</li>'; }).join('') + '</ul><p class="dh-note">Worked out from your own records for ' + esc(d.range.text) + '; shown only when there is enough data.</p>' : empty('Not enough activity in this period to say anything useful yet.'), { span: 6 });
    };
    D.alerts = function (d) {
        var a = [], o = d.ops || {}, push = function (p, icon, text, tab) { a.push({ p: p, icon: icon, text: text, tab: tab }); };
        var crit = n0(o.labCriticalOpen) + n0(o.imagingCriticalOpen);
        if (crit) push(1, '🚨', pl(crit, 'critical result is', 'critical results are') + ' not yet acknowledged', n0(o.labCriticalOpen) ? 'laboratory-tab' : 'radiology-tab');
        if (n0(o.emergencyWaiting)) push(1, '🚑', pl(o.emergencyWaiting, 'emergency patient is', 'emergency patients are') + ' waiting', 'queue-tab');
        if (d.expired.length) push(1, '⛔', pl(d.expired.length, 'medicine is', 'medicines are') + ' past expiry and still in stock', 'inventory-list-tab');
        if (d.out.length) push(1, '📭', pl(d.out.length, 'medicine is', 'medicines are') + ' out of stock', 'inventory-list-tab');
        if (d.low.length) push(2, '🔔', pl(d.low.length, 'medicine is', 'medicines are') + ' low on stock', 'inventory-list-tab');
        if (d.expiring.length) push(2, '⏳', pl(d.expiring.length, 'medicine expires', 'medicines expire') + ' within ' + (n0(g('EXPIRY_WARNING_DAYS')) || 30) + ' days', 'inventory-list-tab');
        if (n0(o.refundsPending) + n0(o.voidDiscountPending)) push(2, '🛑', pl(n0(o.refundsPending) + n0(o.voidDiscountPending), 'refund / void / discount request is', 'refund / void / discount requests are') + ' waiting for approval', 'cash-shift-tab');
        if (n0(o.shiftsAwaitingApproval)) push(2, '💵', pl(o.shiftsAwaitingApproval, 'cashier shift variance needs', 'cashier shift variances need') + ' approval', 'cash-shift-tab');
        if (d.money && d.recv.unpaidBills) push(3, '🧾', pl(d.recv.unpaidBills, 'patient bill is', 'patient bills are') + ' waiting at the cashier (' + kes(d.recv.unpaidAmt) + ')', 'sales-tab');
        if (!d.money && n0(o.unpaidBills)) push(3, '🧾', pl(o.unpaidBills, 'patient bill is', 'patient bills are') + ' waiting at the cashier', 'sales-tab');
        if (d.money && d.recv.overdue) push(2, '⏰', pl(d.recv.overdue, 'pay-later bill is', 'pay-later bills are') + ' past the due date', 'bills-tab');
        if (d.money && n0(o.claimsAwaitingCount)) push(3, '🏥', pl(o.claimsAwaitingCount, 'insurance claim is', 'insurance claims are') + ' awaiting the payer (' + kes(o.claimsAwaitingAmount) + ')', 'contracts-tab');
        if (n0(o.toDispense)) push(3, '💊', pl(o.toDispense, 'patient is', 'patients are') + ' waiting for paid medicines to be handed over', 'pharmacy-tab');
        if (n0(o.labUnverified)) push(4, '🧪', pl(o.labUnverified, 'lab result is', 'lab results are') + ' awaiting verification', 'laboratory-tab');
        if (n0(o.imagingUnverified)) push(4, '🩻', pl(o.imagingUnverified, 'imaging report is', 'imaging reports are') + ' awaiting verification', 'radiology-tab');
        if (d.money && d.recv.noPrice) push(4, '🏷️', pl(d.recv.noPrice, 'unpaid charge has', 'unpaid charges have') + ' no price yet', 'sales-tab');
        if (d.money && d.noCost.length) push(4, '🏷️', pl(d.noCost.length, 'medicine has', 'medicines have') + ' stock but no buying price, so profit is incomplete', 'inventory-list-tab');
        try { if (typeof hasUnsyncedWork === 'function' && hasUnsyncedWork()) push(2, '🔄', 'Some changes on this device have not reached the server yet', null); } catch (e) { /* none */ }
        a.sort(function (x, y) { return x.p - y.p; });
        return a;
    };
    W.alerts = function (d) {
        var al = D.alerts(d);
        return card('alerts', 'Needs attention', al.length ? '<ul class="dh-alerts">' + al.map(function (x) { var go = x.tab && tabVisible(x.tab); return '<li class="p' + x.p + '">' + (go ? '<button type="button" data-goto="' + x.tab + '">' : '<div>') + '<span>' + x.icon + '</span>' + esc(x.text) + (go ? ' <em>→</em></button>' : '</div>') + '</li>'; }).join('') + '</ul>' : '<p class="dh-ok">✅ Nothing needs your attention right now.</p>', { span: 6 });
    };
    function ago(t) { var s = Math.max(0, (Date.now() - t) / 1000); if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; if (s < 604800) return Math.floor(s / 86400) + 'd'; return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
    W.activity = function (d) {
        if (!d.recent.length) return card('activity', 'Recent activity', empty('No activity yet.'), { span: 6 });
        return card('activity', 'Recent activity', '<ul class="dh-feed">' + d.recent.map(function (e) { var go = tabVisible(e.tab); return '<li><button type="button"' + (go ? ' data-goto="' + e.tab + '"' : ' disabled') + '><span class="dh-fi">' + e.icon + '</span><div><b>' + esc(e.what) + (e.amt != null ? ' · ' + kes(e.amt) : '') + '</b>' + (e.who ? '<small>' + esc(e.who) + '</small>' : '') + '</div><time>' + esc(ago(e.t)) + '</time></button></li>'; }).join('') + '</ul><p class="dh-note">What happened and who did it - patient names are never listed here.</p>', { span: 6 });
    };
    W.actions = function () {
        var acts = [['🛎️', 'Reception', 'reception-tab'], ['🚦', 'Triage queue', 'queue-tab'], ['🩺', 'Consultation', 'diagnosis-tab'], ['📅', 'Appointments', 'appointments-tab'], ['🧪', 'Laboratory', 'laboratory-tab'], ['💳', 'Cashier', 'sales-tab'], ['💊', 'Dispensing', 'pharmacy-tab'], ['📦', 'Pharmacy stock', 'inventory-list-tab'], ['📥', 'Restock', 'restock-tab'], ['🧾', 'Patient bills', 'bills-tab'], ['📊', 'Reports', 'reports-tab'], ['📈', 'Hospital report', 'hospital-report-tab']];
        var html = acts.map(function (a) { if (!tabVisible(a[2])) return ''; return '<button type="button" class="dh-qa" data-goto="' + a[2] + '"><span>' + a[0] + '</span>' + a[1] + '</button>'; }).join('');
        return card('actions', 'Quick actions', html ? '<div class="dh-qas">' + html + '</div>' : empty('No shortcuts available for this account.'), { span: 12 });
    };

    /* ---------- page ---------- */
    function kpis(d) {
        var A = d.A, P = d.P, c = d.range.cmp, o = d.ops, list = [];
        var flat = function (t) { return '<span class="dh-delta flat">' + t + '</span>'; };
        if (d.money) {
            list.push(['💰', d.range.label === 'Today' ? "Today's revenue" : 'Revenue', kes(A.revenue), deltaHtml(delta(A.revenue, P.revenue, 0), c), spark(d.series.map(function (p) { return p.rev; })), 'daily-sales-tab']);
            list.push(['🧾', 'Payments', A.count.toLocaleString('en-US'), deltaHtml(delta(A.count, P.count, 0), c), spark(d.series.map(function (p) { return p.n; }), 'var(--dh-c4)'), 'daily-sales-tab']);
            var avg = A.count ? A.revenue / A.count : 0, pavg = P.count ? P.revenue / P.count : 0;
            list.push(['📊', 'Average payment', A.count ? kes(avg) : '—', A.count && P.count ? deltaHtml(delta(avg, pavg, 0), c) : flat('No earlier data to compare'), '', '']);
        }
        list.push(['🩺', 'Patients seen', String(d.seen), deltaHtml(delta(d.seen, d.seenPrev, 0), c), spark(d.series.map(function (p) { return p.visits; }), 'var(--dh-c2)'), 'diagnosis-tab']);
        list.push(['👥', 'Consultations', String(d.V.n), flat(d.V.op + ' outpatient · ' + d.V.ip + ' inpatient'), '', 'diagnosis-tab']);
        list.push(['🗂️', 'New patients', String(d.newPts), deltaHtml(delta(d.newPts, d.newPrev, 0), c), '', 'patients-tab']);
        list.push(['🚦', 'In the facility now', o ? String(o.queueWaiting) : '—', flat(o ? o.emergencyWaiting + ' emergency · ' + pl(o.appointmentsToday, 'appointment', 'appointments') + ' today' : 'Not available'), '', 'queue-tab']);
        list.push(['🛏️', 'Admitted now', String(d.wards.now), flat(d.wards.beds ? d.wards.occupied + ' of ' + d.wards.beds + ' beds in use' : 'No beds set up'), '', 'tables-rooms-tab']);
        list.push(['🧪', 'Lab tests pending', String(d.diag.labPending), flat(d.diag.radOpen + ' imaging open · ' + d.diag.thIn + ' in theatre'), '', 'laboratory-tab']);
        if (d.hasCost && d.money) { var gross = A.revenue - A.cogs, pg = P.revenue - P.cogs; list.push(['📈', 'Gross profit', kes(gross), deltaHtml(delta(gross, pg, 0), c), d.seriesProfitOk ? spark(d.series.map(function (p) { return p.profit; }), 'var(--dh-c2)') : '', 'profits-tab']); }
        else if (d.money) list.push(['📈', 'Gross profit', 'No data', flat('Add buying prices to see profit'), '', 'inventory-list-tab']);
        if (d.money) {
            list.push(['💸', 'Expenses', kes(d.expTotal), deltaHtml(delta(d.expTotal, d.expPrevTotal, 0), c, true), '', 'profits-tab']);
            list.push(['🧾', 'Still to collect', kes(d.recv.total), flat(pl(d.recv.unpaidBills, 'unpaid bill', 'unpaid bills') + ' at cashier'), '', 'bills-tab']);
            list.push(['📦', 'Drug stock value', kes(d.invValue), flat(d.rows.length + ' items'), '', 'inventory-list-tab']);
        }
        list.push(['💊', 'Low / out of stock', d.low.length + ' / ' + d.out.length, flat(d.expired.length + ' expired · ' + d.expiring.length + ' expiring soon'), '', 'inventory-list-tab']);
        return '<div class="dh-kpis">' + list.map(function (k) { var clickable = k[5] && tabVisible(k[5]); return '<div class="dh-kpi' + (clickable ? ' go' : '') + '"' + (clickable ? ' data-goto="' + k[5] + '" role="button" tabindex="0"' : '') + '><div class="dh-kpi-top"><span class="dh-ico">' + k[0] + '</span><span class="dh-kpi-l">' + k[1] + '</span></div><div class="dh-kpi-v">' + k[2] + '</div>' + k[3] + k[4] + '</div>'; }).join('') + '</div>';
    }
    function header(range) {
        var biz = typeof g('businessName') === 'string' ? g('businessName') : '', now = new Date();
        var chips = PRESETS.map(function (p) { return '<button type="button" class="dh-chip' + (S.preset === p[0] ? ' on' : '') + '" data-preset="' + p[0] + '">' + p[1] + '</button>'; }).join('');
        var custom = S.preset === 'custom' ? '<div class="dh-custom"><input type="date" id="dh-from" value="' + esc(S.from || range.fromKey) + '" aria-label="From"><span>to</span><input type="date" id="dh-to" value="' + esc(S.to || range.toKey) + '" aria-label="To"><button type="button" class="dh-chip on" data-applycustom="1">Apply</button></div>' : '';
        return '<div class="dh-head"><div><h3>' + esc(biz || 'Hospital') + '</h3><p>' + now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ' · <span id="dh-clock">' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '</span>' + (me() ? ' · 👤 ' + esc(me()) : '') + '</p></div><div class="dh-tools"><button type="button" class="dh-btn" data-act="refresh" title="Refresh">🔄 Refresh</button><button type="button" class="dh-btn" data-act="export" title="Download a CSV of these figures">⬇️ Export</button>' + (isOwner() ? '<button type="button" class="dh-btn" data-act="customize">⚙️ Customize</button>' : '') + '</div></div>'
            + '<div class="dh-chips" role="tablist">' + chips + '</div>' + custom + '<p class="dh-range">Showing <b>' + esc(range.text) + '</b>' + (range.label !== 'Custom' ? ' · compared with ' + esc(range.cmp) : '') + '</p>'
            + (D.canSeeMoney() ? '' : '<p class="dh-note dh-restricted">💼 Financial figures are shown only to accounts with access to Reports, Profits &amp; Expenses, Daily Sales or the Hospital Report.</p>');
    }
    function availableWidgets() { var m = D.canSeeMoney(); return WIDGETS.filter(function (w) { return m || !w[2]; }); }
    function ordered() { return availableWidgets().sort(function (a, b) { return orderOf(a[0]) - orderOf(b[0]); }); }
    function customizePanel() {
        return '<div class="dh-panel" id="dh-panel"><div class="dh-panel-h"><b>Customize dashboard</b><button type="button" data-act="closepanel">✕</button></div><p class="dh-note" style="margin-top:0">Show or hide sections and change their order. Saved on this device.</p>' + ordered().map(function (w, i, a) { return '<div class="dh-prow"><label><input type="checkbox" data-wtoggle="' + w[0] + '"' + (S.hidden[w[0]] ? '' : ' checked') + '> ' + esc(w[1]) + '</label><span><button type="button" data-wmove="' + w[0] + ':-1"' + (i === 0 ? ' disabled' : '') + '>▲</button><button type="button" data-wmove="' + w[0] + ':1"' + (i === a.length - 1 ? ' disabled' : '') + '>▼</button></span></div>'; }).join('') + '<button type="button" class="dh-btn" data-act="resetlayout">Reset layout</button></div>';
    }
    var lastData = null, drawTimer = 0;
    function widgetHtml(id, d) {
        if (MONEY_W[id] && !d.money) return '';
        try { return W[id](d); } catch (e) { try { console.error('hospital dashboard widget ' + id, e); } catch (e2) { /* none */ } return '<section class="dh-card dh-w-6" data-w="' + id + '" style="order:' + orderOf(id) + '"><header class="dh-card-h"><h4>' + esc((WIDGETS.filter(function (w) { return w[0] === id; })[0] || [0, id])[1]) + '</h4></header><div class="dh-card-b"><p class="dh-empty">This section could not load.</p><button type="button" class="dh-btn" data-retry="' + id + '">Try again</button></div></section>'; }
    }
    D.render = function () {
        root = document.getElementById('dash-hosp-root'); if (!root) return;
        var tab = document.getElementById('dashboard-tab'); if (tab && !tab.classList.contains('active') && !D.force) return;
        var range = D.rangeFor(S.preset, S.from, S.to);
        root.innerHTML = '<div class="dh-top">' + header(range) + '</div><div class="dh-skel"><i></i><i></i><i></i><i></i></div>';
        clearTimeout(drawTimer);
        drawTimer = setTimeout(function () {
            var d;
            try { d = D.compute(range); } catch (e) { try { console.error('hospital dashboard', e); } catch (e2) { /* none */ } root.innerHTML = '<div class="dh-top">' + header(range) + '</div><p class="dh-empty">The dashboard could not be calculated. <button type="button" class="dh-btn" data-act="refresh">Try again</button></p>'; return; }
            lastData = d;
            var first = ['trend', 'departments', 'patients', 'flow', 'alerts'], rest = WIDGETS.map(function (w) { return w[0]; }).filter(function (id) { return first.indexOf(id) < 0 && !S.hidden[id]; });
            var vis = function (id) { return !S.hidden[id]; }, k;
            try { k = kpis(d); } catch (e) { try { console.error('hospital dashboard kpis', e); } catch (e2) { /* none */ } k = '<p class="dh-empty">The headline figures could not load. <button type="button" class="dh-btn" data-act="refresh">Try again</button></p>'; }
            root.innerHTML = '<div class="dh-top">' + header(range) + '</div>' + (d.anyData ? '' : '<p class="dh-empty">No activity yet — your dashboard fills up as patients are registered, seen and billed.</p>') + k + '<div class="dh-grid-w" id="dh-grid">' + first.filter(vis).map(function (id) { return widgetHtml(id, d); }).join('') + '</div><div id="dh-panelwrap"></div>';
            var grid = document.getElementById('dh-grid'), i = 0;
            // the lower sections are drawn a few at a time so the first screen appears at once and the cashier is never held up
            (function step() { if (!grid || !grid.isConnected || lastData !== d) return; var chunk = rest.slice(i, i + 4); if (!chunk.length) return; grid.insertAdjacentHTML('beforeend', chunk.map(function (id) { return widgetHtml(id, d); }).join('')); i += 4; setTimeout(step, 0); })();
        }, 0);
    };
    // Export: the same figures, as CSV. Money rows only for accounts that may see money; never a patient name or a diagnosis.
    D.csvRows = function (d) {
        d = d || lastData; if (!d) return [];
        var A = d.A, rows = [['Hospital dashboard export'], ['Period', d.range.text], ['Generated', new Date().toLocaleString('en-GB')], [],
            ['Patients seen', d.seen], ['Consultations', d.V.n], ['Outpatient visits', d.V.op], ['Inpatient visits', d.V.ip], ['New patients registered', d.newPts], ['Returning patients seen', d.returning],
            ['Admitted now', d.wards.now], ['Admitted in period', d.wards.admitted], ['Discharged in period', d.wards.discharged], ['ANC visits', d.mat.anc], ['Deliveries', d.mat.deliveries],
            ['Lab tests requested', d.diag.labReq], ['Imaging requested', d.diag.radReq], ['Theatre cases requested', d.diag.thReq], ['Appointments in period', d.apptN],
            ['Drugs low on stock', d.low.length], ['Drugs out of stock', d.out.length], ['Drugs expired in stock', d.expired.length], ['Drugs expiring soon', d.expiring.length], []];
        if (d.money) {
            rows.push(['Revenue', Math.round(A.revenue)], ['Payments', A.count], ['Cost of medicines sold', d.hasCost ? Math.round(A.cogs) : 'n/a'], ['Gross profit', d.hasCost ? Math.round(A.revenue - A.cogs) : 'n/a'], ['Expenses', Math.round(d.expTotal)], ['Unpaid patient bills (KES)', Math.round(d.recv.unpaidAmt)], ['Pay-later bills owed', Math.round(d.recv.billOwed)], ['Debts owed', Math.round(d.recv.debtOwed)], ['Owed by institutions', Math.round(d.recv.instOwed)], [], ['Department', 'Revenue']);
            DEPTS.forEach(function (x) { if (A.dept[x[0]] && A.dept[x[0]].rev !== 0) rows.push([x[1], Math.round(A.dept[x[0]].rev)]); });
            rows.push([], ['Payment method', 'Amount']); Object.keys(A.method).forEach(function (k) { if (A.method[k].amt) rows.push([k, Math.round(A.method[k].amt)]); });
        }
        rows.push([], ['Date / hour', 'Consultations', 'New patients'].concat(d.money ? ['Revenue', 'Payments'] : []));
        d.series.forEach(function (p) { rows.push([p.long, p.visits, p.newpts].concat(d.money ? [Math.round(p.rev), p.n] : [])); });
        rows.push([], ['Medicine', 'Quantity'].concat(d.money ? ['Revenue'] : []));
        Object.keys(A.drug).map(function (k) { return A.drug[k]; }).sort(function (a, b) { return b.qty - a.qty; }).forEach(function (o) { rows.push([o.name, o.qty].concat(d.money ? [Math.round(o.rev)] : [])); });
        return rows;
    };
    D.exportCsv = function () {
        if (!lastData) return; var d = lastData;
        var csv = D.csvRows(d).map(function (r) { return r.map(function (c) { return typeof csvEscape === 'function' ? csvEscape(c) : String(c); }).join(','); }).join('\n');
        if (typeof downloadBlob === 'function') downloadBlob(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), 'hospital-dashboard-' + d.range.fromKey + (d.range.toKey !== d.range.fromKey ? '_to_' + d.range.toKey : '') + '.csv');
    };

    /* ---------- events (one delegated listener) ---------- */
    function onClick(ev) {
        var t = ev.target && ev.target.closest ? ev.target.closest('[data-preset],[data-metric],[data-topby],[data-topall],[data-staffby],[data-goto],[data-act],[data-retry],[data-applycustom],[data-wmove]') : null;
        if (!t || !root || !root.contains(t)) return;
        if (t.dataset.preset) { S.preset = t.dataset.preset; persist(); return D.render(); }
        if (t.dataset.applycustom) { S.from = (document.getElementById('dh-from') || {}).value || ''; S.to = (document.getElementById('dh-to') || {}).value || ''; return D.render(); }
        if (t.dataset.metric) { S.metric = t.dataset.metric; return redrawWidget('trend'); }
        if (t.dataset.topby) { S.topBy = t.dataset.topby; return redrawWidget('drugs'); }
        if (t.dataset.topall) { S.topAll = !S.topAll; return redrawWidget('drugs'); }
        if (t.dataset.staffby) { S.staffBy = t.dataset.staffby; return redrawWidget('staff'); }
        if (t.dataset.retry) return redrawWidget(t.dataset.retry);
        if (t.dataset.goto) { var b = document.querySelector('.tabs .tab-link[data-tab="' + t.dataset.goto + '"]'); if (b && b.style.display !== 'none') b.click(); return; }
        if (t.dataset.wmove) { var p = t.dataset.wmove.split(':'), ids = ordered().map(function (w) { return w[0]; }), i = ids.indexOf(p[0]), j = i + Number(p[1]); if (i >= 0 && j >= 0 && j < ids.length) { var x = ids[i]; ids[i] = ids[j]; ids[j] = x; S.order = ids; persist(); D.render(); setTimeout(function () { D.openPanel(); }, 30); } return; }
        var act = t.dataset.act;
        if (act === 'refresh') { D.force = false; return D.render(); }
        if (act === 'export') return D.exportCsv();
        if (act === 'customize') return D.openPanel();
        if (act === 'closepanel') { var pw = document.getElementById('dh-panelwrap'); if (pw) pw.innerHTML = ''; return; }
        if (act === 'resetlayout') { S.hidden = {}; S.order = []; persist(); return D.render(); }
    }
    function onKey(ev) { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target && ev.target.getAttribute && ev.target.getAttribute('role') === 'button' && ev.target.dataset && ev.target.dataset.goto) { ev.preventDefault(); onClick(ev); } }
    function onChange(ev) { var t = ev.target; if (!t || !t.dataset || !t.dataset.wtoggle) return; S.hidden[t.dataset.wtoggle] = !t.checked; persist(); D.render(); setTimeout(function () { D.openPanel(); }, 30); }
    D.openPanel = function () { if (!isOwner()) return; var pw = document.getElementById('dh-panelwrap'); if (pw) { pw.innerHTML = customizePanel(); if (pw.scrollIntoView) pw.scrollIntoView({ block: 'nearest' }); } };
    function redrawWidget(id) {
        if (!lastData || !root) return; var el = root.querySelector('[data-w="' + id + '"]'); if (!el) return;
        var tmp = document.createElement('div'); tmp.innerHTML = widgetHtml(id, lastData); if (tmp.firstElementChild) el.replaceWith(tmp.firstElementChild);
    }
    var tip = null;
    function showTip(ev) {
        var t = ev.target && ev.target.closest ? ev.target.closest('[data-tip]') : null;
        if (!t || !root || !root.contains(t)) { if (tip) tip.style.display = 'none'; return; }
        if (!tip) { tip = document.createElement('div'); tip.className = 'dh-tip'; document.body.appendChild(tip); }
        tip.textContent = t.getAttribute('data-tip'); tip.style.display = 'block';
        var x = ev.clientX || (t.getBoundingClientRect().left + 10), y = ev.clientY || t.getBoundingClientRect().top;
        var w = tip.offsetWidth; tip.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, x - w / 2)) + 'px'; tip.style.top = Math.max(6, y - tip.offsetHeight - 12) + 'px';
    }
    function bind() {
        var el = document.getElementById('dashboard-tab'); if (!el || el.__dhBound) return; el.__dhBound = true;
        el.addEventListener('click', onClick); el.addEventListener('change', onChange); el.addEventListener('keydown', onKey);
        el.addEventListener('mousemove', showTip); el.addEventListener('mouseover', showTip); el.addEventListener('touchstart', function (e) { showTip(e.touches && e.touches[0] ? { target: e.target, clientX: e.touches[0].clientX, clientY: e.touches[0].clientY } : e); }, { passive: true });
        el.addEventListener('mouseleave', function () { if (tip) tip.style.display = 'none'; });
        document.addEventListener('scroll', function () { if (tip) tip.style.display = 'none'; }, { passive: true, capture: true });
        setInterval(function () { var c = document.getElementById('dh-clock'); if (c) c.textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }, 30000);
    }
    D.open = function () { bind(); D.force = true; try { D.render(); } finally { D.force = false; } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
