/* MyDuka CRM - dashboard, products, campaigns, sales, reports, staff, settings, audit. */
(function () {
  'use strict';
  const C = window.CRM; const { h, mount, ic, pick, listOf, api, toast, fail, openModal, field, sel, inp, loading, empty, errbox, btn, can, canAny, fmtDT, fmtDate, money } = C;
  const human = (k) => String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const MONEY = /(revenue|spend|cost|cpl|cpa|value|amount|avgdeal|avg_deal|averagedeal|total_sales|paid|budget|price|collected|outstanding|discounts)/i; const PCT = /(rate|percent|pct|conversion|share)/i; const ROAS = /roas/i; const DUR = /(minutes|mins|hours)$/i;
  function fmtVal(k, v) {
    if (v == null || v === '') return null; if (typeof v === 'boolean') return v ? 'Yes' : 'No'; if (typeof v !== 'number') return String(v);
    if (/(At|_at)$/.test(k) && v > 1e12) return fmtDT(v);
    if (ROAS.test(k)) return C.num(v) + 'x'; if (PCT.test(k)) return C.pct(v); if (MONEY.test(k)) return money(v); if (DUR.test(k)) return C.num(v) + ' ' + (/hours$/i.test(k) ? 'h' : 'min'); return C.num(v);
  }
  const kpi = (l, v, accent) => h('div', { class: 'kpi' + (accent ? ' accent' : '') }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
  function bars(rows, title) {
    const vals = rows.map((r) => Number(pick(r, 'count', 'value', 'total', 'leads', 'revenue', 'amount') || 0)); const max = Math.max(1, ...vals);
    return h('div', null, title ? h('h3', { style: { margin: '10px 0 6px' } }, title) : null, h('div', { class: 'bars' }, rows.map((r, i) => h('div', { class: 'bar' }, h('span', { class: 'trunc' }, String(pick(r, 'label', 'name', 'key', 'source', 'status', 'stage', 'campaign', 'product', 'staff') || '-')), h('span', { class: 'track' }, h('span', { class: 'fill', style: { display: 'block', width: Math.round(vals[i] / max * 100) + '%' } })), h('span', { class: 'small' }, MONEY.test(Object.keys(r).find((k) => typeof r[k] === 'number' && !/count/i.test(k)) || '') && !r.count ? money(vals[i]) : C.num(vals[i]))))));
  }
  const SKIPK = new Set(['range', 'scope', 'generatedAt', 'from', 'to', 'fromDay', 'toDay', 'staff']);
  function block(title, data) {
    if (data == null) return null;
    if (Array.isArray(data)) {
      if (!data.length || !isObj(data[0])) return null;
      const nums = Object.keys(data[0]).filter((k) => typeof data[0][k] === 'number' && !/(Id|_id)$/.test(k)); const named = ['label', 'name', 'key', 'source', 'status', 'stage', 'campaign', 'product'].some((k) => k in data[0]);
      return nums.length > 2 || !named ? h('div', null, title ? h('h3', { style: { margin: '10px 0 6px' } }, title) : null, autoTable(data)) : bars(data, title);
    }
    if (!isObj(data)) return null;
    const tiles = [], subs = [];
    Object.keys(data).forEach((k) => {
      const v = data[k]; if (v == null || SKIPK.has(k)) return;
      if (isObj(v) && 'value' in v && Object.keys(v).every((x) => ['label', 'key', 'value', 'unit'].includes(x))) { const s = fmtVal(pick(v, 'key') || k, pick(v, 'value', 'count')); if (s != null) tiles.push(kpi(v.label || human(k), s)); }
      else if (isObj(v) || Array.isArray(v)) { const b = block(human(k), v); if (b) subs.push(b); } else { const s = fmtVal(k, v); if (s != null) tiles.push(kpi(human(k), s)); }
    });
    if (!tiles.length && !subs.length) return null;
    return h('div', null, title ? h('h3', { style: { margin: '10px 0 6px' } }, title) : null, tiles.length ? h('div', { class: 'kpis' }, tiles) : null, subs);
  }
  function autoTable(rows, opts) {
    rows = listOf(rows); if (!rows.length) return empty('Nothing to show for this period.', 'chart');
    const cols = []; rows.slice(0, 20).forEach((r) => Object.keys(r).forEach((k) => { if (!cols.includes(k) && !isObj(r[k]) && !Array.isArray(r[k]) && !/(^id$|Id$|_id$|photo)/.test(k)) cols.push(k); }));
    return h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, cols.map((c) => h('th', null, human(c))))), h('tbody', null, rows.map((r) => h('tr', null, cols.map((c) => { const v = r[c]; return h('td', null, /(At|_at|date)$/i.test(c) && v ? fmtDT(v) : (fmtVal(c, v) == null ? '' : fmtVal(c, v))); }))))));
  }
  C.autoTable = autoTable;

  /* ---------- dashboard ---------- */
  const DB = { range: 'today', from: '', to: '', staff: '', source: '', campaign: '', product: '' };
  async function dashboardScreen(ctx) {
    const root = ctx.root; const me = C.state.me; const team = canAny('reports.team', 'reports.company', 'revenue.team', 'revenue.company'); const staff = team && can('staff.view') ? await C.staffList() : [];
    const box = h('div', null, loading());
    if (!DB.from) { const d = C.rangeDates(DB.range); DB.from = d.from; DB.to = d.to; }
    const top = h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'Hello, ' + ((me.name || 'there').split(' ')[0])), h('div', { class: 'small muted' }, team ? 'Team overview' : 'Your numbers')), staff.length > 1 ? sel(C.staffOptions(staff, true, 'Whole team'), DB.staff, { 'aria-label': 'Staff filter', onchange: (e) => { DB.staff = e.target.value; load(); } }) : null);
    const quick = h('div', { class: 'card' }, h('div', { class: 'btnrow' }, can('leads.claim') ? h('a', { class: 'btn primary', href: '#/leads/pool' }, ic('star'), 'New leads to claim') : null, h('a', { class: 'btn', href: '#/followups' }, ic('clock'), 'Follow-ups due'), can('inbox.view') ? h('a', { class: 'btn', href: '#/inbox' }, ic('chat'), 'Inbox') : null, can('leads.create') ? btn('Add lead', () => C.addLeadDialog(), '') : null));
    async function load() {
      mount(box, loading());
      try {
        const q = { range: DB.range, staff: DB.staff, source: DB.source, campaign: DB.campaign, product: DB.product }; if (DB.range === 'custom') { q.from = DB.from; q.to = DB.to; }
        const d = await api('/dashboard', { query: q }); if (!ctx.alive()) return; const parts = [];
        if (Array.isArray(d.kpis)) parts.push(h('div', { class: 'card' }, h('div', { class: 'kpis' }, d.kpis.map((k) => kpi(k.label || human(k.key), fmtVal(k.key || k.label || '', k.value) || '-')))));
        const NAMES = { mine: 'My work', leads: 'Leads', pipeline: 'Pipeline', bySource: 'Leads by source', byCampaign: 'Leads by campaign', byAdset: 'Leads by ad set', byAd: 'Leads by ad', followups: 'Follow-ups', meetings: 'Meetings', response: 'Response times', revenue: 'Sales', marketing: 'Marketing', staffBoard: 'Team' }; const scal = [];
        Object.keys(d).forEach((k) => { if (['kpis', 'range', 'from', 'to', 'scope', 'generatedAt', 'staff'].includes(k)) return; const v = d[k]; if (v == null) return;
          if (!isObj(v) && !Array.isArray(v)) { const s = fmtVal(k, v); if (s != null) scal.push(kpi(({ pool: 'Unclaimed leads', inboxUnread: 'Unread chats' })[k] || human(k), s)); return; }
          if (k === 'marketing' && !(Number(v.spend) > 0) && !(Number(v.leads) > 0)) return;
          const b = block(null, v); if (b) parts.push(h('div', { class: 'card' }, h('h2', null, NAMES[k] || human(k)), b)); });
        if (scal.length) parts.unshift(h('div', { class: 'card' }, h('div', { class: 'kpis' }, scal)));
        mount(box, parts.length ? h('div', { class: 'stack' }, parts) : empty('No activity in this period yet.', 'chart'));
      } catch (e) { if (ctx.alive()) mount(box, errbox(e, load)); }
    }
    // filters (spec section 30): staff (above), date (below), source, campaign, product
    // zip 161: the dashboard figures no longer wait for the campaign/product lists (they only fill the filter boxes, a moment later)
    const metaP = C.meta().catch(() => ({ campaigns: [], products: [] }));
    const fsel = (key, opts, label) => sel(opts, DB[key], { 'aria-label': label, onchange: (e) => { DB[key] = e.target.value; load(); } });
    const buildFilters = (m) => [fsel('source', C.cfgOptions('sources', true, 'Any source', true), 'Source'), fsel('campaign', [{ v: '', l: 'Any campaign' }].concat((m.campaigns || []).map((c) => ({ v: c.id, l: c.name }))), 'Campaign'), fsel('product', [{ v: '', l: 'Any product' }].concat((m.products || []).map((p) => ({ v: p.id, l: C.pname(p) }))), 'Product')];
    const filt = h('div', { class: 'filters' }, buildFilters({ campaigns: [], products: [] }));
    metaP.then((m) => { if (ctx.alive() && (m.campaigns || m.products)) mount(filt, buildFilters(m)); });
    mount(root, top, quick, filt, h('div', { style: { margin: '12px 0' } }, C.rangeBar(DB, load)), box); load();
  }

  /* ---------- products ---------- */
  async function productsScreen(ctx) {
    const root = ctx.root; const edit = canAny('settings.products', 'settings.manage'); const box = h('div', null, loading());
    async function load() {
      mount(box, loading());
      try { const d = await api('/products'); if (!ctx.alive()) return; const items = listOf(d, 'products'); C.state.meta = null;
        mount(box, items.length ? h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Product', 'Key', 'Price', 'Status', ''].map((x) => h('th', null, x)))), h('tbody', null, items.map((p) => h('tr', null, h('td', null, h('b', null, C.pname(p)), p.description ? h('div', { class: 'small muted' }, p.description) : null), h('td', null, p.key || ''), h('td', null, pick(p, 'price', 'unitPrice', 'unit_price') != null ? money(pick(p, 'price', 'unitPrice', 'unit_price')) : ''), h('td', null, C.pill(p.active === false ? 'Inactive' : 'Active', p.active === false ? '#888888' : '#1fa855')), h('td', null, edit ? btn('Edit', () => dlg(p), 'sm') : null)))))) : empty('No products yet.', 'box', edit ? btn('Add product', () => dlg(), 'primary') : null));
      } catch (e) { if (ctx.alive()) mount(box, errbox(e, load)); }
    }
    function dlg(p) {
      p = p || {}; const name = inp('text', { value: p.label || p.name || '' }), price = inp('number', { value: pick(p, 'price', 'unitPrice', 'unit_price') != null ? pick(p, 'price', 'unitPrice', 'unit_price') : '', min: '0' }), desc = h('textarea'); desc.value = p.description || ''; const act = inp('checkbox', { checked: p.active !== false });
      openModal({ title: p.id ? 'Edit product' : 'Add product', body: h('div', null, field('Name', name), field('Price (KES)', price), field('Description', desc), h('label', { class: 'row' }, act, 'Active (can be selected on leads)')), actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => {
        if (!name.value.trim()) { toast('Enter a product name.', true); return false; } const body = { label: name.value.trim(), price: price.value === '' ? null : Number(price.value), description: desc.value.trim() || null, active: act.checked };
        if (p.id) await api('/products/' + p.id, { method: 'PATCH', body }); else await api('/products', { body }); toast('Product saved.'); load();
      } }] });
    }
    mount(root, h('div', { class: 'pagehead' }, h('h1', null, 'Products'), edit ? btn('Add product', () => dlg(), 'primary') : null), box); load();
  }

  /* ---------- campaigns ---------- */
  async function campaignsScreen(ctx) {
    const root = ctx.root; const edit = canAny('campaigns.create', 'campaigns.edit'); const box = h('div', null, loading());
    const metricsOf = (n) => { const m = Object.assign({}, n.metrics || {}, n); const spend = Number(pick(m, 'spend', 'totalSpend') || 0); const out = [];
      const add = (label, v, f) => { if (v != null && v !== '' && !(typeof v === 'number' && isNaN(v))) out.push(h('span', { class: 'pill', title: label }, label + ' ' + f(v))); };
      add('Leads', pick(m, 'leads', 'leadCount'), C.num); if (spend > 0) { add('Spend', spend, money); add('CPL', pick(m, 'cpl'), money); add('CPA', pick(m, 'cpa'), money); add('ROAS', pick(m, 'roas'), (v) => C.num(v) + 'x'); }
      add('Sales', pick(m, 'sales', 'conversions', 'won'), C.num); add('Revenue', pick(m, 'revenue'), money); return out; };
    const kidsOf = (n, ...k) => { for (const x of k) if (Array.isArray(n[x])) return n[x]; return []; };
    function spendDlg(camp, adset, ad) {
      const date = inp('date', { value: C.ymd() }), amt = inp('number', { min: '0', step: '1', placeholder: '0' });
      openModal({ title: 'Add spend - ' + (ad ? ad.name : adset ? adset.name : camp.name), body: h('div', null, field('Date', date), field('Amount (KES)', amt)), actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => { if (!(Number(amt.value) > 0)) { toast('Enter an amount above zero.', true); return false; } await api('/campaigns/' + camp.id + '/spend', { body: { date: date.value, amount: Number(amt.value), adsetId: adset ? adset.id : undefined, adId: ad ? ad.id : undefined } }); toast('Spend recorded.'); load(); } }] });
    }
    function nameDlg(title, cur, extra, onSave) {
      const n = inp('text', { value: cur || '' }); const ex = extra ? extra() : null;
      openModal({ title, body: h('div', null, field('Name', n), ex && ex.node), actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => { if (!n.value.trim()) { toast('Enter a name.', true); return false; } await onSave(n.value.trim(), ex && ex.get && ex.get()); load(); } }] });
    }
    async function load() {
      mount(box, loading());
      try {
        const d = await api('/campaigns'); if (!ctx.alive()) return; const camps = listOf(d, 'campaigns'); C.state.meta = null;
        const row = (label, node, acts) => h('li', null, h('div', { class: 'row wrap' }, h('b', null, label), C.pill(node.status || (node.active === false ? 'paused' : 'active')), metricsOf(node), h('span', { class: 'right row' }, acts)));
        mount(box, camps.length ? h('div', { class: 'card tree' }, h('ul', null, camps.map((c) => { const sets = kidsOf(c, 'adsets', 'adSets', 'ad_sets');
          return h('li', null, h('div', { class: 'row wrap' }, ic('target'), h('b', null, c.name), c.platform || c.channel ? h('span', { class: 'small muted' }, c.platform || c.channel) : null, C.pill(c.status || (c.active === false ? 'paused' : 'active')), metricsOf(c), h('span', { class: 'right row' }, can('campaigns.edit') ? btn('+ Spend', () => spendDlg(c), 'sm') : null, edit ? btn('+ Ad set', () => nameDlg('New ad set', '', null, (n) => api('/campaigns/' + c.id + '/adsets', { body: { name: n } })), 'sm') : null, edit ? btn(c.status === 'paused' || c.active === false ? 'Resume' : 'Pause', async () => { try { await api('/campaigns/' + c.id, { method: 'PATCH', body: { status: c.status === 'paused' || c.active === false ? 'active' : 'paused' } }); load(); } catch (e) { fail(e); } }, 'sm') : null)),
            sets.length ? h('ul', null, sets.map((s) => { const ads = kidsOf(s, 'ads'); return h('li', null, h('div', { class: 'row wrap' }, h('span', null, s.name), metricsOf(s), h('span', { class: 'right row' }, can('campaigns.edit') ? btn('+ Spend', () => spendDlg(c, s), 'sm') : null, edit ? btn('+ Ad', () => nameDlg('New ad', '', null, (n) => api('/adsets/' + s.id + '/ads', { body: { name: n } })), 'sm') : null)),
              ads.length ? h('ul', null, ads.map((a) => h('li', null, h('div', { class: 'row wrap' }, h('span', { class: 'small' }, a.name), metricsOf(a), h('span', { class: 'right' }, can('campaigns.edit') ? btn('+ Spend', () => spendDlg(c, s, a), 'sm') : null))))) : null); })) : null); }))) : empty('No campaigns yet. Leads from ads are attributed once you create campaigns.', 'target', edit ? btn('Create campaign', newCamp, 'primary') : null));
      } catch (e) { if (ctx.alive()) mount(box, errbox(e, load)); }
    }
    function newCamp() { nameDlg('New campaign', '', () => { const plat = sel([{ v: 'meta', l: 'Meta (Facebook / Instagram)' }, { v: 'google', l: 'Google' }, { v: 'tiktok', l: 'TikTok' }, { v: 'whatsapp', l: 'WhatsApp' }, { v: 'other', l: 'Other' }], 'meta'); return { node: field('Platform', plat), get: () => plat.value }; }, (n, plat) => api('/campaigns', { body: { name: n, platform: plat } })); }
    mount(root, h('div', { class: 'pagehead' }, h('h1', null, 'Campaigns'), edit ? btn('New campaign', newCamp, 'primary') : null), h('p', { class: 'small muted' }, 'Cost and return figures only appear once spend has been recorded.'), box); load();
  }

  /* ---------- sales ---------- */
  const SL = { tab: 'list', range: 'month', from: '', to: '' };
  async function salesScreen(ctx) {
    const root = ctx.root; if (!SL.from) { const d = C.rangeDates(SL.range); SL.from = d.from; SL.to = d.to; } const box = h('div', null, loading()); const bar = h('div', { style: { margin: '10px 0' } });
    const drawTabs = () => mount(bar, C.tabs([['list', 'Sales'], ['lead', 'By lead'], ['staff', 'By staff'], ['product', 'By product'], ['campaign', 'By campaign'], ['ad', 'By ad']].map(([v, l]) => ({ v, l })), SL.tab, (v) => { SL.tab = v; drawTabs(); load(); }));
    const saleF = { staff: (s) => pick(s, 'staffName', 'staff_name', 'closed_by_name', 'closedByName', 'userName', 'user_name'), lead: (s) => pick(s, 'leadName', 'lead_name'), product: (s) => C.txt(pick(s, 'productLabel', 'productName', 'product_name', 'product_label', 'product')), campaign: (s) => C.txt(pick(s, 'campaignName', 'campaign_name', 'campaign')), ad: (s) => C.txt(pick(s, 'adName', 'ad_name', 'ad')) };
    async function load() {
      mount(box, loading());
      try {
        const d = await api('/sales', { query: { from: SL.from, to: SL.to } }); if (!ctx.alive()) return; const items = listOf(d, 'sales'); const amt = (s) => Number(pick(s, 'total', 'amount', 'revenue') || 0); const tt = d.totals || {}; const total = tt.revenue != null ? tt.revenue : items.reduce((a, s) => a + amt(s), 0);
        const head = h('div', { class: 'kpis', style: { marginBottom: '10px' } }, kpi('Sales', String(tt.count != null ? tt.count : items.length)), kpi('Revenue', money(total), true));
        if (!items.length) return mount(box, head, empty('No sales in this period.', 'money'));
        if (SL.tab === 'list') return mount(box, head, h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Date', 'Lead', 'Product', 'Qty', 'Total', 'Staff', 'Payment'].map((x) => h('th', null, x)))), h('tbody', null, items.map((s) => { const ps = pick(s, 'paymentStatus', 'payment_status') || 'unpaid'; const pay = sel([{ v: 'paid', l: 'Paid' }, { v: 'partial', l: 'Part paid' }, { v: 'unpaid', l: 'Unpaid' }], ps, { 'aria-label': 'Payment status', disabled: !can('sales.record') }); pay.addEventListener('change', () => api('/sales/' + s.id, { method: 'PATCH', body: { paymentStatus: pay.value } }).then(() => toast('Payment updated.')).catch((e) => { fail(e); load(); }));
          return h('tr', null, h('td', null, fmtDate(pick(s, 'soldAt', 'sold_at', 'createdAt', 'created_at'))), h('td', null, pick(s, 'leadId', 'lead_id') ? h('a', { href: '#/leads/' + pick(s, 'leadId', 'lead_id') }, saleF.lead(s) || 'Lead') : ''), h('td', null, saleF.product(s)), h('td', null, String(s.quantity || 1)), h('td', null, money(amt(s))), h('td', null, saleF.staff(s) || ''), h('td', null, pay)); })))));
        const groups = {}; items.forEach((s) => { const k = saleF[SL.tab](s) || 'Unknown'; groups[k] = groups[k] || { label: k, value: 0, count: 0 }; groups[k].value += amt(s); groups[k].count++; });
        const rows = Object.values(groups).sort((a, b) => b.value - a.value); mount(box, head, h('div', { class: 'card' }, h('h2', null, 'Revenue ' + SL.tab.replace('lead', 'by lead').replace(/^(staff|product|campaign|ad)$/, 'by $1')), rows.map((r) => h('div', { class: 'listrow' }, h('span', { class: 'grow trunc' }, r.label), h('span', { class: 'small muted' }, r.count + ' sale' + (r.count === 1 ? '' : 's')), h('b', null, money(r.value)))), tt.count > items.length ? h('div', { class: 'small muted' }, 'Showing the latest ' + items.length + ' of ' + tt.count + ' sales.') : null));
      } catch (e) { if (ctx.alive()) mount(box, errbox(e, load)); }
    }
    drawTabs(); mount(root, h('div', { class: 'pagehead' }, h('h1', null, 'Sales')), C.rangeBar(SL, load), bar, box); load();
  }

  /* ---------- reports ---------- */
  const RP = { tab: 'staff', range: 'month', from: '', to: '', staff: '', source: '', campaign: '', product: '' };
  async function reportsScreen(ctx) {
    const root = ctx.root; if (!RP.from) { const d = C.rangeDates(RP.range); RP.from = d.from; RP.to = d.to; } await C.meta(); const staff = await C.staffList(); const box = h('div', null, loading()); const bar = h('div');
    const drawTabs = () => mount(bar, C.tabs([['staff', 'Staff'], ['sources', 'Sources'], ['campaigns', 'Campaigns'], ['products', 'Products'], ['funnel', 'Funnel'], ['response', 'Response']].filter(([v]) => v !== 'campaigns' || can('campaigns.view')).map(([v, l]) => ({ v, l })), RP.tab, (v) => { RP.tab = v; drawTabs(); load(); }));
    const mk = (k, opts, l) => sel(opts, RP[k], { 'aria-label': l, onchange: (e) => { RP[k] = e.target.value; load(); } });
    const filters = h('div', { class: 'filters' }, staff.length > 1 && canAny('reports.team', 'reports.company') ? mk('staff', C.staffOptions(staff, true, 'All staff'), 'Staff') : null, mk('source', C.cfgOptions('sources', true, 'All sources', true), 'Source'), mk('campaign', [{ v: '', l: 'All campaigns' }].concat(C.state.meta.campaigns.map((c) => ({ v: c.id, l: c.name }))), 'Campaign'), mk('product', [{ v: '', l: 'All products' }].concat(C.state.meta.products.map((p) => ({ v: p.id, l: C.pname(p) }))), 'Product'));
    async function load() {
      mount(box, loading());
      try { const d = await api('/reports/' + RP.tab, { query: { from: RP.from, to: RP.to, staff: RP.staff, source: RP.source, campaign: RP.campaign, product: RP.product } }); if (!ctx.alive()) return;
        const rows = Array.isArray(d) ? d : (d.rows || d.items || d.stages || null); let content;
        if (RP.tab === 'funnel' && Array.isArray(d.stages)) content = h('div', null, block(null, d.totals), bars(d.stages.map((r) => ({ label: pick(r, 'label', 'stage', 'name'), count: pick(r, 'reached', 'count', 'value') })), 'Reached each stage'), h('div', { style: { marginTop: '10px' } }, autoTable(d.stages)));
        else if (rows) content = autoTable(rows); else content = block(null, d) || empty('Nothing to show for this period.', 'chart');
        mount(box, h('div', { class: 'card' }, content), d.summary ? h('div', { class: 'card' }, block('Summary', d.summary)) : null);
      } catch (e) { if (ctx.alive()) mount(box, errbox(e, load)); }
    }
    drawTabs(); mount(root, h('div', { class: 'pagehead' }, h('h1', null, 'Reports'), can('leads.export') ? null : null), C.rangeBar(RP, load), filters, bar, h('div', { style: { marginTop: '10px' } }, box)); load();
  }

  /* ---------- staff ---------- */
  const ROLES = [{ v: 'sales', l: 'Sales' }, { v: 'manager', l: 'Manager' }, { v: 'owner', l: 'Owner' }];
  function shareLinkDialog(title, link, phone, name, intro) {
    const msg = (intro || 'Hi ' + (name || '') + ', here is your MyDuka CRM link: ') + link; const inpEl = inp('text', { value: link, readonly: true, 'aria-label': 'Link', onfocus: (e) => e.target.select() });
    openModal({ title, body: h('div', null, h('p', { class: 'muted' }, 'This link works once and expires in 7 days. Send it only to ' + (name || 'the person') + '.'), inpEl, h('div', { class: 'btnrow', style: { marginTop: '10px' } },
      btn('Copy link', async () => { try { await navigator.clipboard.writeText(link); toast('Link copied.'); } catch (e) { inpEl.select(); try { document.execCommand('copy'); toast('Link copied.'); } catch (e2) { toast('Select the link and copy it.', true); } } }, 'primary'), h('a', { class: 'btn wa', target: '_blank', rel: 'noopener', href: (phone ? 'https://wa.me/' + C.waNumber(phone) : 'https://wa.me/') + '?text=' + encodeURIComponent(msg) }, ic('wa'), 'Share via WhatsApp'))), actions: [{ label: 'Done', kind: 'primary' }] });
  }
  async function permMeta() { if (C.state.permMeta) return C.state.permMeta; try { C.state.permMeta = await api('/permissions'); } catch (e) { C.state.permMeta = { keys: [], roles: {} }; } return C.state.permMeta; }
  async function permDialog(u, done) {
    const pm = await permMeta(); const keys = listOf(pm.keys).map((k) => typeof k === 'string' ? { key: k } : k); const roleDefaults = new Set(listOf((pm.roles || {})[u.role])); const all = roleDefaults.has('*');
    const ov = u.overrides || u.permissions || {}; const grant = new Set(listOf(pick(u, 'grant') || ov.grant)), deny = new Set(listOf(pick(u, 'deny') || ov.deny));
    const grid = h('div', { class: 'permgrid' }, h('span', { class: 'h' }, 'Permission'), h('span', { class: 'h' }, 'Role default'), h('span', { class: 'h' }, 'This person')); let group = '';
    keys.forEach((k) => { const g = k.key.split('.')[0]; if (g !== group) { group = g; grid.appendChild(h('b', { style: { gridColumn: '1 / -1', marginTop: '8px', textTransform: 'capitalize' } }, g)); }
      const s = sel([{ v: 'default', l: 'Default' }, { v: 'grant', l: 'Allow' }, { v: 'deny', l: 'Block' }], grant.has(k.key) ? 'grant' : (deny.has(k.key) ? 'deny' : 'default'), { 'aria-label': (k.label || k.key) + ' override', 'data-key': k.key }); grid.append(h('span', null, k.label || k.key), h('span', { class: 'center' }, all || roleDefaults.has(k.key) ? 'Yes' : '-'), s); });
    openModal({ title: 'Permissions - ' + u.name, wide: true, body: keys.length ? h('div', null, h('p', { class: 'small muted' }, 'Role: ' + C.cfgRole(u.role) + '. Overrides add or remove single permissions on top of the role.'), grid) : errbox({ message: 'The permission list is unavailable.' }), actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => {
      const g = [], d = []; grid.querySelectorAll('select[data-key]').forEach((s) => { if (s.value === 'grant') g.push(s.getAttribute('data-key')); if (s.value === 'deny') d.push(s.getAttribute('data-key')); });
      await api('/staff/' + u.id + '/permissions', { method: 'PUT', body: { grant: g, deny: d } }); toast('Permissions saved.'); done && done();
    } }] });
  }
  async function reassignDialog(u, done) {
    const staff = (await C.staffList()).filter((x) => String(x.id) !== String(u.id)); const to = sel(C.staffOptions(staff, true, 'Back to the pool (unassigned)'), ''); const all = inp('checkbox', { checked: true });
    openModal({ title: 'Reassign leads from ' + u.name, body: h('div', null, field('Move to', to), h('label', { class: 'row' }, all, 'All of their open leads')), actions: [{ label: 'Cancel' }, { label: 'Reassign', kind: 'primary', onClick: async () => { const r = await api('/staff/' + u.id + '/reassign', { body: { toUserId: to.value || null, all: true } }); const nf = listOf(r.failed).length; toast('Moved ' + (r.moved != null ? r.moved : 0) + ' lead' + (r.moved === 1 ? '' : 's') + (nf ? ', ' + nf + ' could not be moved' : '') + '.', !!nf); done && done(); } }] });
  }
  async function staffForm(u, forEdit) {
    u = u || {}; const name = inp('text', { value: u.name || '' }), phone = inp('tel', { value: u.phone || '' }), email = inp('email', { value: u.email || '', disabled: forEdit }), dept = inp('text', { value: u.department || '' }), role = sel(ROLES.filter((r) => r.v !== 'owner' || (C.state.me && C.state.me.role === 'owner')), u.role || 'sales', { disabled: forEdit }), photo = inp('file', { accept: 'image/*' });
    return { node: h('div', null, field('Full name', name), h('div', { class: 'grid2' }, field('Phone', phone), field('Email', email)), h('div', { class: 'grid2' }, field('Role', role), field('Department', dept)), field('Photo (optional)', photo)),
      async get() { const errs = []; if (!name.value.trim()) errs.push('Enter a name.'); if (!forEdit && !/^\S+@\S+\.\S+$/.test(email.value.trim())) errs.push('Enter a valid email address.'); const body = { name: name.value.trim(), phone: phone.value.trim() || undefined, email: email.value.trim() || undefined, department: dept.value.trim() || undefined, role: role.value }; if (photo.files && photo.files[0]) { const p = await C.downscalePhoto(photo.files[0]); if (p) body.photo = p; } return { errs, body }; } };
  }
  async function addStaffDialog(done) {
    const f = await staffForm(); const me = C.state.me || {};
    openModal({ title: 'Add team member', wide: true, body: f.node, actions: [{ label: 'Cancel' }, { label: 'Create & get invite link', kind: 'primary', onClick: async () => {
      const r = await f.get(); if (r.errs.length) { toast(r.errs[0], true); return false; }
      const d = await api('/staff', { body: r.body }); C.state.staff = null; toast('Team member added.'); done && done(); shareLinkDialog('Invite ' + r.body.name, d.inviteLink || d.link, r.body.phone, r.body.name, 'Hi ' + r.body.name.split(' ')[0] + ', you have been invited to MyDuka CRM. Set up your account here: ');
    } }] });
  }
  async function statusAction(u, status, done) {
    const txt = { suspended: 'Suspend ' + u.name + '? They are signed out at once and cannot sign in until restored.', inactive: 'Deactivate ' + u.name + '? Their history is kept.', active: 'Restore ' + u.name + '?' };
    if (!(await C.ask(status === 'active' ? 'Restore' : (status === 'suspended' ? 'Suspend' : 'Deactivate') + ' team member', txt[status], 'Confirm', status !== 'active'))) return;
    try { await api('/staff/' + u.id + '/status', { body: { status } }); C.state.staff = null; toast('Updated.'); done && done(); } catch (e) { fail(e); }
  }
  async function removeDialog(u, done) {
    const staff = (await C.staffList()).filter((x) => String(x.id) !== String(u.id) && (x.status || 'active') === 'active'); const to = sel([{ v: '__keep', l: 'Leave their leads as they are' }, { v: '__pool', l: 'Return their open leads to the pool' }].concat(C.staffOptions(staff, false)), '__keep');
    openModal({ title: 'Remove ' + u.name, body: h('div', null, h('p', { class: 'muted' }, 'They can no longer sign in. The account is archived, not deleted - history and reports keep their name.'), field('Their open leads', to)), actions: [{ label: 'Cancel' }, { label: 'Remove', kind: 'danger', onClick: async () => {
      const body = {}; if (to.value === '__pool') body.toUserId = null; else if (to.value !== '__keep') body.toUserId = to.value;
      await api('/staff/' + u.id + '/remove', { body }); C.state.staff = null; toast('Removed.'); done();
    } }] });
  }
  function staffMenu(anchor, u, done) {
    const canEdit = can('staff.edit'), canDeact = can('staff.deactivate'), st = u.status || 'active';
    C.popMenu(anchor, [{ head: u.name }, canEdit ? { label: 'Edit details', icon: 'edit', onClick: async () => { const f = await staffForm(u, true); openModal({ title: 'Edit ' + u.name, wide: true, body: f.node, actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => { const r = await f.get(); if (r.errs.length) { toast(r.errs[0], true); return false; } delete r.body.email; delete r.body.role; await api('/staff/' + u.id, { method: 'PATCH', body: r.body }); C.state.staff = null; toast('Saved.'); done(); } }] }); } } : null,
      can('staff.roles') ? { label: 'Change role', icon: 'shield', onClick: () => { const r = sel(ROLES, u.role); openModal({ title: 'Change role', body: field('Role', r), actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => { await api('/staff/' + u.id + '/role', { body: { role: r.value } }); C.state.staff = null; toast('Role updated.'); done(); } }] }); } } : null,
      can('staff.roles') || canEdit ? { label: 'Permissions', icon: 'lock', onClick: () => permDialog(u, done) } : null,
      canEdit ? { label: st === 'invited' ? 'Invite link' : 'Reset link', icon: 'link', onClick: async () => { try { const d = await api('/staff/' + u.id + '/reset-link', { body: {} }); shareLinkDialog('Password reset link', d.link, u.phone, u.name, 'Hi ' + (u.name || '').split(' ')[0] + ', reset your MyDuka CRM password here: '); } catch (e) { fail(e); } } } : null,
      can('leads.assign') ? { label: 'Reassign leads', icon: 'users', onClick: () => reassignDialog(u, done) } : null,
      canDeact && st === 'active' ? { label: 'Suspend', icon: 'lock', onClick: () => statusAction(u, 'suspended', done) } : null, canDeact && st !== 'active' && st !== 'invited' ? { label: 'Restore', icon: 'check', onClick: () => statusAction(u, 'active', done) } : null,
      canDeact && st !== 'inactive' ? { label: 'Deactivate', icon: 'x', onClick: () => statusAction(u, 'inactive', done) } : null,
      canDeact ? { label: 'Remove', icon: 'trash', onClick: () => removeDialog(u, done) } : null]);
  }
  async function staffScreen(ctx) {
    if (ctx.parts[1]) return staffDetail(ctx, ctx.parts[1]);
    const root = ctx.root; const box = h('div', null, loading());
    async function load() {
      mount(box, loading());
      try { const d = await api('/staff'); if (!ctx.alive()) return; const items = listOf(d, 'staff'); C.state.staff = items;
        mount(box, items.length ? h('div', { class: 'card' }, items.map((u) => h('div', { class: 'listrow' }, C.avatar(u.name, u.photo), h('div', { class: 'grow' }, h('a', { href: '#/staff/' + u.id, style: { fontWeight: 600 } }, u.name), h('div', { class: 'small muted trunc' }, [C.cfgRole(u.role), u.email, u.phone].filter(Boolean).join(' - '))),
          h('span', { class: 'only-wide small muted' }, (pick(u, 'openLeads', 'open_leads', 'leads') != null ? pick(u, 'openLeads', 'open_leads', 'leads') + ' leads' : '')), C.pill(u.status || 'active', (u.status || 'active') === 'active' ? '#1fa855' : ((u.status === 'suspended' || u.status === 'invited') ? '#e8a100' : '#888888')),
          h('span', { style: { position: 'relative' } }, h('button', { class: 'iconbtn sm', type: 'button', 'aria-label': 'Actions for ' + u.name, 'aria-haspopup': 'menu', onclick: (e) => staffMenu(e.currentTarget, u, load) }, ic('more')))))) : empty('No team members yet.', 'users'));
      } catch (e) { if (ctx.alive()) mount(box, errbox(e, load)); }
    }
    mount(root, h('div', { class: 'pagehead' }, h('h1', null, 'Team'), can('staff.add') ? btn('Add team member', () => addStaffDialog(load), 'primary') : null), box); load();
  }
  async function staffDetail(ctx, id) {
    const root = ctx.root; mount(root, loading());
    async function load() {
      try {
        const [d, act, leads, fus, meets] = await Promise.all([api('/staff/' + id), api('/staff/' + id + '/activity').catch(() => ({})), api('/leads', { query: { staff: id, pageSize: 8 } }).catch(() => ({})), api('/followups', { query: { staff: id, bucket: 'upcoming' } }).catch(() => ({})), api('/meetings', { query: { staff: id, from: C.ymd(), to: C.addDays(C.ymd(), 30) } }).catch(() => ({}))]);
        if (!ctx.alive()) return; const u = d.user || d; const stats = d.stats || {}; ctx.setTitle(u.name);
        const head = h('div', { class: 'card' }, h('div', { class: 'row' }, C.avatar(u.name, u.photo, 'lg'), h('div', { class: 'grow' }, h('h1', null, u.name), h('div', { class: 'small muted' }, [C.cfgRole(u.role), u.department, u.email, u.phone].filter(Boolean).join(' - ')), C.pill(u.status || 'active')), h('span', { style: { position: 'relative' } }, h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Actions', 'aria-haspopup': 'menu', onclick: (e) => staffMenu(e.currentTarget, u, load) }, ic('more')))));
        const statCard = h('div', { class: 'card' }, h('h2', null, 'Performance'), block(null, stats) || h('div', { class: 'muted small' }, 'No figures yet.'));
        const leadItems = listOf(leads, 'leads').map(C.LD); const leadCard = h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h2', null, 'Assigned & claimed leads'), leads.total != null ? h('span', { class: 'small muted' }, leads.total + ' total') : null), leadItems.length ? leadItems.map((l) => h('div', { class: 'listrow' }, C.avatar(l.name, null, 'sm'), h('a', { class: 'grow trunc', href: '#/leads/' + l.id }, l.name), C.cfgPill('statuses', l.status))) : h('div', { class: 'muted small' }, 'None.'));
        const fl = listOf(fus, 'followups'); const ml = listOf(meets, 'meetings'); const al = listOf(act, 'activity');
        mount(root, h('div', { class: 'pagehead' }, h('a', { class: 'btn ghost', href: '#/staff' }, ic('back'), 'Team')), h('div', { class: 'stack' }, head, h('div', { class: 'grid2', style: { gap: '12px' } }, h('div', { class: 'stack' }, statCard, leadCard), h('div', { class: 'stack' },
          h('div', { class: 'card' }, h('h2', null, 'Upcoming follow-ups'), fl.length ? fl.slice(0, 6).map((f) => C.followupRow(f, load)) : h('div', { class: 'muted small' }, 'None.')), h('div', { class: 'card' }, h('h2', null, 'Meetings (30 days)'), ml.length ? ml.slice(0, 6).map((m) => C.meetingRow(m, load)) : h('div', { class: 'muted small' }, 'None.')),
          h('div', { class: 'card' }, h('h2', null, 'Recent activity'), al.length ? h('ul', { class: 'tl' }, al.slice(0, 15).map((a) => h('li', null, h('div', null, h('b', null, String(pick(a, 'action', 'type') || '').replace(/_/g, ' ')), ' ', pick(a, 'summary', 'text', 'detail', 'description') || ''), h('div', { class: 'tiny faint' }, fmtDT(pick(a, 'createdAt', 'created_at', 'at')))))) : h('div', { class: 'muted small' }, 'No activity recorded.'))))));
      } catch (e) { if (ctx.alive()) mount(root, h('div', { class: 'pagehead' }, h('a', { class: 'btn ghost', href: '#/staff' }, ic('back'), 'Team')), errbox(e, load)); }
    }
    await load();
  }


  /* ---------- owner-only: import previous leads (legacy KV -> CRM) ---------- */
  const LEG = { plan: null, result: null, verify: null };
  function legacyPanel() {
    const out = h('div', { class: 'card' }); const n0 = (v) => (typeof v === 'number' ? v : 0);
    const KINDS = [['leads', 'Day-sheet leads'], ['meetings', 'Meetings'], ['staff', 'Staff names'], ['messages', 'WhatsApp inbox messages'], ['websiteLeads', 'Website sign-ups']];
    const cell = (v) => h('td', { class: 'num' }, v == null ? '-' : String(v));
    function countsTable(counts, dry) {
      const rows = KINDS.map(([k, label]) => { const c = counts[k] || {}; const found = c.found != null ? c.found : (k === 'messages' ? (dry ? c.created : n0(c.created) + n0(c.skipped)) : null); return h('tr', null, h('td', null, label), cell(found), cell(c.created != null ? c.created : 0), cell(c.skipped != null ? c.skipped : 0), cell(c.failed != null ? c.failed : 0)); });
      return h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Kind', 'Found', dry ? 'Would create' : 'Created', 'Skipped', 'Failed'].map((x, i) => h('th', i ? { class: 'num' } : null, x)))), h('tbody', null, rows)));
    }
    const list = (title, arr, fmt) => (arr && arr.length ? h('div', { style: { marginTop: '8px' } }, h('b', null, title), h('ul', { class: 'small' }, arr.map((x) => h('li', null, fmt ? fmt(x) : String(x))))) : null);
    const busy = (b, on) => { b.disabled = on; };
    async function run(dry, b) {
      busy(b, true); try { const r = await api('/legacy/migrate', { method: 'POST', body: dry ? { dryRun: true } : {} }); if (dry) { LEG.plan = r; LEG.result = null; } else { LEG.result = r; LEG.plan = null; LEG.verify = null; toast('Import finished.'); } draw(); } catch (e) { fail(e); busy(b, false); }
    }
    async function verify(b) { busy(b, true); try { LEG.verify = await api('/legacy/verify'); draw(); } catch (e) { fail(e); busy(b, false); } }
    function verifyView(v) {
      const labels = { leads: 'Leads', won: 'Won', lost: 'Lost', meetings: 'Meetings', staffNames: 'Staff names', websiteLeads: 'Website sign-ups', agreedTotal: 'Agreed total', paidTotal: 'Paid total' };
      const m = isObj(v.match) ? v.match : {}; const kv = isObj(v.kv) ? v.kv : {}; const crm = isObj(v.crm) ? v.crm : {}; const fmt = (k, x) => (x == null ? '-' : /Total$/.test(k) ? money(x) : String(x));
      const rows = Object.keys(labels).filter((k) => k in m || k in kv || k in crm).map((k) => h('tr', null, h('td', null, labels[k]), cell(fmt(k, kv[k])), cell(fmt(k, crm[k])), h('td', null, C.pill(m[k] ? 'Match' : 'Mismatch', m[k] ? '#1fa855' : '#d93025'))));
      return h('div', { style: { marginTop: '12px' }, 'data-legacy': 'verify' }, h('h3', null, 'Verification'), h('p', { class: 'small', role: 'status' }, v.ok ? 'All numbers match. Everything from the old tab is in the CRM.' : 'Some numbers differ or something was not migrated - see below. The CRM count can be higher if you added leads directly in the CRM.'),
        h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, h('th', null, 'What'), h('th', { class: 'num' }, 'Old'), h('th', { class: 'num' }, 'CRM'), h('th', null, 'Result'))), h('tbody', null, rows))),
        list('Leads not migrated', v.missingLeads, (x) => (x.name || '(no name)') + ' - ' + x.legacyId), list('Website sign-ups not migrated', v.missingWebsiteLeads, (x) => (x.name || '(no name)') + ' - ' + x.legacyId), list('Meetings not migrated', v.missingMeetings));
    }
    function draw() {
      const plan = LEG.plan, res = LEG.result; const r = plan || res;
      const check = btn('Check what will be moved', () => run(true, check), '', { 'data-act': 'check' }); const imp = btn('Import now', () => run(false, imp), 'primary', { 'data-act': 'import' }); const ver = btn('Verify counts', () => verify(ver), '', { 'data-act': 'verify' });
      mount(out, h('h2', null, 'Import previous leads'),
        h('p', { class: 'small muted' }, 'Moves the leads, meetings, staff names, WhatsApp inbox and website sign-ups from the old Leads tab into this CRM. The old data is kept untouched - nothing is deleted or changed there - and the import is safe to repeat: anything already moved is skipped and CRM edits are never overwritten.'),
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, check, imp, ver),
        r ? h('div', { style: { marginTop: '12px' }, 'data-legacy': plan ? 'plan' : 'result' }, h('h3', null, plan ? 'Check result (nothing was written)' : 'Import result'), (r.counts && (r.counts.sheets != null)) ? h('p', { class: 'small muted' }, 'Found ' + n0(r.counts.leadRecords) + ' lead records on ' + n0(r.counts.sheets) + ' day sheets. The same person on several sheets becomes one lead.') : null, r.counts ? countsTable(r.counts, !!plan) : null,
          list('Warnings', r.warnings), list('Errors', r.errors), plan ? list('Staff names that would be added', r.plannedStaffNames) : null, !plan && r.note ? h('p', { class: 'small muted' }, r.note) : null) : null,
        LEG.verify ? verifyView(LEG.verify) : null);
    }
    draw(); return out;
  }

  /* ---------- settings ---------- */
  const SET = { tab: 'statuses' };
  async function settingsScreen(ctx) {
    const root = ctx.root; const box = h('div', null, loading()); const bar = h('div', { style: { marginBottom: '10px' } });
    const KINDS = { statuses: 'Statuses', classifications: 'Classifications', sources: 'Sources', lostReasons: 'Lost reasons' };
    const canCfg = canAny('settings.manage', 'settings.statuses'); const isOwner = !!(C.state.me && C.state.me.role === 'owner'); if (SET.tab === 'import' && !isOwner) SET.tab = 'statuses';
    const drawTabs = () => mount(bar, C.tabs(Object.keys(KINDS).map((k) => ({ v: k, l: KINDS[k] })).concat([{ v: 'integrations', l: 'Integrations' }, { v: 'business', l: 'Business' }, { v: 'automation', l: 'Automation' }], isOwner ? [{ v: 'import', l: 'Import previous leads' }] : []), SET.tab, (v) => { SET.tab = v; drawTabs(); draw(); }));
    async function draw() {
      if (KINDS[SET.tab]) return configEditor(SET.tab);
      if (SET.tab === 'import') return mount(box, isOwner ? legacyPanel() : empty('Only the owner can import previous leads.'));
      if (SET.tab === 'automation') return automationPanel();
      mount(box, loading());
      try {
        const s = await api('/settings'); const integ = isObj(s.integrations) ? s.integrations : {}; const biz = isObj(s.settings) ? s.settings : (isObj(s.business) ? s.business : {});
        if (SET.tab === 'integrations') {
          const LBL = { whatsappInbound: ['WhatsApp inbound (webhook)', 'Receives chats and click-to-WhatsApp ad leads.'], whatsappApi: ['WhatsApp Cloud API (send replies)', 'Needed to reply from the Inbox.'], metaWebhook: ['Meta Lead Ads webhook', 'Receives Facebook / Instagram lead-form leads.'], metaGraph: ['Meta Graph lookups', 'Resolves campaign / ad names for form leads.'] };
          const keys = Object.keys(integ); mount(box, h('div', { class: 'card' }, h('h2', null, 'Integrations'), keys.length ? keys.map((k) => { const v = integ[k]; const on = isObj(v) ? !!(v.configured != null ? v.configured : v.connected) : !!v; const l = LBL[k] || [human(k), '']; return h('div', { class: 'listrow' }, h('div', { class: 'grow' }, h('b', null, l[0]), l[1] ? h('div', { class: 'small muted' }, l[1]) : null), C.pill(on ? 'Connected' : 'Not connected', on ? '#1fa855' : '#888888')); }) : h('div', { class: 'muted' }, 'Integration status is only shown to people with the integrations permission.'), h('p', { class: 'small muted' }, 'Keys and tokens are set on the server (Cloudflare Pages environment), never in this page.')));
        } else {
          const LBL = { companyName: 'Company name', currency: 'Currency (3 letters)', defaultDuplicatePolicy: 'Default duplicate policy for imports', defaultRemindMinutes: 'Default follow-up reminder (minutes before)', firstContactTargetMinutes: 'First-contact target (minutes)' };
          const inputs = {}; Object.keys(biz).filter((k) => !/^auto[A-Z]/.test(k)).forEach((k) => { inputs[k] = k === 'defaultDuplicatePolicy' ? sel([{ v: 'skip', l: 'Skip duplicates' }, { v: 'update', l: 'Update existing' }, { v: 'create', l: 'Create anyway' }], biz[k], { disabled: !can('settings.manage') }) : inp(typeof biz[k] === 'number' ? 'number' : 'text', { value: biz[k] == null ? '' : biz[k], disabled: !can('settings.manage') }); });
          mount(box, h('div', { class: 'card' }, h('h2', null, 'Business settings'), Object.keys(inputs).length ? [h('div', { class: 'grid2' }, Object.keys(inputs).map((k) => field(LBL[k] || human(k), inputs[k]))), can('settings.manage') ? btn('Save', async () => { const body = {}; Object.keys(inputs).forEach((k) => { body[k] = typeof biz[k] === 'number' ? Number(inputs[k].value) : inputs[k].value; }); try { await api('/settings', { method: 'PUT', body: { settings: body } }); toast('Settings saved.'); } catch (e) { fail(e); } }, 'primary') : h('div', { class: 'notice' }, 'You can view these but not change them.')] : h('div', { class: 'muted' }, 'No editable settings yet.')));
        }
      } catch (e) { mount(box, errbox(e, draw)); }
    }
    async function configEditor(kind) {
      const items = cfgClone(kind);
      function render() {
        mount(box, h('div', { class: 'card' }, h('h2', null, KINDS[kind]), h('p', { class: 'small muted' }, 'Items are never deleted - switch one off to hide it from new choices. History keeps the old label.'),
          items.map((it, i) => h('div', { class: 'listrow', style: { flexWrap: 'wrap' } }, h('div', { class: 'col', style: { gap: '0' } }, h('button', { class: 'iconbtn sm', type: 'button', 'aria-label': 'Move up', disabled: i === 0 || !canCfg, onclick: () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; render(); }, style: { transform: 'rotate(90deg)' } }, ic('back')), h('button', { class: 'iconbtn sm', type: 'button', 'aria-label': 'Move down', disabled: i === items.length - 1 || !canCfg, onclick: () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; render(); }, style: { transform: 'rotate(-90deg)' } }, ic('back'))),
            h('input', { type: 'text', value: it.label, 'aria-label': 'Label', disabled: !canCfg, style: { flex: '1 1 160px' }, oninput: (e) => { it.label = e.target.value; } }),
            kind === 'lostReasons' ? null : h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(it.color || '') ? it.color : '#128c7e', 'aria-label': 'Colour', disabled: !canCfg, style: { width: '44px', height: '36px', padding: '2px' }, oninput: (e) => { it.color = e.target.value; } }),
            kind === 'statuses' ? [h('label', { class: 'row small' }, inp('checkbox', { checked: !!it.isWon, disabled: !canCfg || !!it.isSystem, onchange: (e) => { it.isWon = e.target.checked; if (it.isWon) it.isLost = false; render(); } }), 'Won'), h('label', { class: 'row small' }, inp('checkbox', { checked: !!it.isLost, disabled: !canCfg || !!it.isSystem, onchange: (e) => { it.isLost = e.target.checked; if (it.isLost) it.isWon = false; render(); } }), 'Lost')] : null,
            h('label', { class: 'row small', title: it.isSystem ? 'Built in - cannot be switched off' : null }, inp('checkbox', { checked: it.active !== false, disabled: !canCfg || !!it.isSystem, onchange: (e) => { it.active = e.target.checked; } }), 'Active'))),
          canCfg ? h('div', { class: 'btnrow', style: { marginTop: '10px' } }, btn('Add ' + KINDS[kind].toLowerCase().replace(/ies$/, 'y').replace(/s$/, ''), () => { items.push({ label: '', color: '#128c7e', active: true }); render(); const ins = box.querySelectorAll('input[type=text]'); ins[ins.length - 1] && ins[ins.length - 1].focus(); }), btn('Save changes', async (ev) => {
            const bad = items.find((x) => !String(x.label).trim()); if (bad) { toast('Every item needs a name.', true); return; } ev.currentTarget.disabled = true;
            try { await api('/config/' + kind, { method: 'PUT', body: { items: items.map((x) => ({ id: x.id, key: x.key, label: x.label.trim(), color: x.color, active: x.active !== false, isWon: !!x.isWon, isLost: !!x.isLost })) } }); await C.reloadConfig(); toast('Saved.'); if (SET.tab === kind) configEditor(kind); } catch (e) { fail(e); ev.currentTarget.disabled = false; }
          }, 'primary')) : h('div', { class: 'notice' }, 'You can view these lists but not change them.')));
      }
      render();
    }
    // zip 158: the Automation screen: two simple rules (minutes, 0 = off) and the recent business events they run on. Rules are executed by the server whenever the CRM is used.
    async function automationPanel() {
      mount(box, loading());
      try {
        const d = await api('/automation'); const rules = listOf(d, 'rules'); const events = listOf(d, 'events'); const edit = !!d.canEdit && can('settings.manage');
        const num = {}; rules.forEach((r) => { num[r.key] = inp('number', { value: r.value, min: '0', max: '10080', 'aria-label': r.label + ' (minutes)', disabled: !edit, style: { width: '90px' } }); });
        const when = (v) => C.fmtDT(v);
        mount(box, h('div', { class: 'card' }, h('h2', null, 'Automation rules'),
          h('p', { class: 'small muted' }, 'Rules run by themselves whenever the CRM is in use (there is no timer). Put 0 to switch a rule off.'),
          rules.map((r) => h('div', { class: 'listrow', 'data-rule': r.key, style: { flexWrap: 'wrap', gap: '8px' } }, h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, r.label + ' for'), h('div', { class: 'small muted' }, 'then: ' + r.action)), num[r.key], h('span', { class: 'small' }, 'minutes' + (r.off ? ' (off)' : '')))),
          edit ? h('div', { class: 'btnrow', style: { marginTop: '10px' } }, btn('Save rules', async (ev) => { ev.currentTarget.disabled = true; try { const body = {}; rules.forEach((r) => { body[r.key] = Number(num[r.key].value); }); await api('/settings', { method: 'PUT', body: { settings: body } }); toast('Rules saved.'); await automationPanel(); } catch (e) { fail(e); ev.currentTarget && (ev.currentTarget.disabled = false); } }, 'primary')) : h('div', { class: 'notice' }, 'You can view the rules but not change them.')),
          h('div', { class: 'card' }, h('h2', null, 'Recent events'), h('p', { class: 'small muted' }, (d.pendingEvents || 0) + ' waiting for an outside automation to pick them up (Integrations).'),
            events.length ? h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['When', 'Event', 'By', 'Handled'].map((x) => h('th', null, x)))), h('tbody', null, events.map((e) => h('tr', { 'data-event': e.id }, h('td', null, when(e.at)), h('td', null, e.name), h('td', null, e.actorName || (String(e.name).startsWith('automation.') ? 'Automation' : 'System')), h('td', null, e.processedAt ? when(e.processedAt) : '-')))))) : h('div', { class: 'muted' }, 'Nothing has happened yet.')));
      } catch (e) { mount(box, errbox(e, automationPanel)); }
    }
    function cfgClone(kind) { return C.cfg(kind).map((x) => Object.assign({}, x)); }
    drawTabs(); mount(root, h('div', { class: 'pagehead' }, h('h1', null, 'Settings')), bar, box); draw();
  }

  /* ---------- audit ---------- */
  const AU = { page: 1, pageSize: 30, entity: '', action: '', from: '', to: '' };
  async function auditScreen(ctx) {
    const root = ctx.root; const box = h('div', null, loading());
    const f = (k, type, ph) => inp(type, { value: AU[k], placeholder: ph, 'aria-label': ph, onchange: (e) => { AU[k] = e.target.value.trim(); AU.page = 1; load(); } });
    async function load() {
      mount(box, loading());
      try { const d = await api('/audit', { query: { entity: AU.entity, action: AU.action, from: AU.from, to: AU.to, page: AU.page, pageSize: AU.pageSize } }); if (!ctx.alive()) return; const items = listOf(d, 'audit', 'entries');
        mount(box, items.length ? [h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['When', 'Who', 'Action', 'Entity', 'Details'].map((x) => h('th', null, x)))), h('tbody', null, items.map((a) => h('tr', null, h('td', null, fmtDT(pick(a, 'createdAt', 'created_at', 'at'))), h('td', null, pick(a, 'userName', 'user_name', 'user') || 'System'), h('td', null, String(pick(a, 'action') || '')), h('td', null, [pick(a, 'entity', 'entityType', 'entity_type'), pick(a, 'entityId', 'entity_id')].filter(Boolean).join(' #')), h('td', { class: 'small', style: { overflowWrap: 'anywhere', maxWidth: '380px' } }, (() => { const v = pick(a, 'summary', 'detail', 'details', 'description', 'next', 'meta'); const s = v && typeof v === 'object' ? JSON.stringify(v) : (v || ''); return String(s).slice(0, 220); })())))))), C.pager(AU, d.total != null ? d.total : items.length, (p) => { AU.page = p; load(); })] : empty('No audit entries match.', 'shield'));
      } catch (e) { if (ctx.alive()) mount(box, errbox(e, load)); }
    }
    mount(root, h('div', { class: 'pagehead' }, h('h1', null, 'Audit log')), h('div', { class: 'filters' }, f('entity', 'text', 'Entity (lead, staff...)'), f('action', 'text', 'Action'), f('from', 'date', 'From'), f('to', 'date', 'To')), box); load();
  }

  C.route('dashboard', dashboardScreen, { label: 'Dashboard', icon: 'home' });
  C.route('products', productsScreen, { label: 'Products', icon: 'box' });
  C.route('campaigns', campaignsScreen, { label: 'Campaigns', icon: 'target' });
  C.route('sales', salesScreen, { label: 'Sales', icon: 'money' });
  C.route('reports', reportsScreen, { label: 'Reports', icon: 'chart' });
  C.route('staff', staffScreen, { label: 'Team', icon: 'users' });
  C.route('settings', settingsScreen, { label: 'Settings', icon: 'gear' });
  C.route('audit', auditScreen, { label: 'Audit log', icon: 'shield' });
})();
