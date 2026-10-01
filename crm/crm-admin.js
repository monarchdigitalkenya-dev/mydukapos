/* MyDuka CRM - dashboard, products, campaigns, sales (loaded with the page). Reports, staff, settings and the audit log live in crm-admin-more.js, which is fetched the first time one of them is opened (zip 162). */
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
  const SALES_PAGE = 50;                                   // zip 162: rows per page on the Sales list (the API pages with limit + before)
  async function salesScreen(ctx) {
    const root = ctx.root; if (!SL.from) { const d = C.rangeDates(SL.range); SL.from = d.from; SL.to = d.to; } const box = h('div', null, loading()); const bar = h('div', { style: { margin: '10px 0' } });
    const drawTabs = () => mount(bar, C.tabs([['list', 'Sales'], ['lead', 'By lead'], ['staff', 'By staff'], ['product', 'By product'], ['campaign', 'By campaign'], ['ad', 'By ad']].map(([v, l]) => ({ v, l })), SL.tab, (v) => { SL.tab = v; drawTabs(); load(); }));
    const saleF = { staff: (s) => pick(s, 'staffName', 'staff_name', 'closed_by_name', 'closedByName', 'userName', 'user_name'), lead: (s) => pick(s, 'leadName', 'lead_name'), product: (s) => C.txt(pick(s, 'productLabel', 'productName', 'product_name', 'product_label', 'product')), campaign: (s) => C.txt(pick(s, 'campaignName', 'campaign_name', 'campaign')), ad: (s) => C.txt(pick(s, 'adName', 'ad_name', 'ad')) };
    async function load() {
      mount(box, loading());
      try {
        const paged = SL.tab === 'list';   // zip 162: the plain list is paged (50 + Load more); the "by ..." tabs add everything up, so they still take the whole period
        const d = await api('/sales', { query: paged ? { from: SL.from, to: SL.to, limit: SALES_PAGE } : { from: SL.from, to: SL.to } }); if (!ctx.alive()) return; const items = listOf(d, 'sales'); const amt = (s) => Number(pick(s, 'total', 'amount', 'revenue') || 0); const tt = d.totals || {}; const total = tt.revenue != null ? tt.revenue : items.reduce((a, s) => a + amt(s), 0);
        const head = h('div', { class: 'kpis', style: { marginBottom: '10px' } }, kpi('Sales', String(tt.count != null ? tt.count : items.length)), kpi('Revenue', money(total), true));
        if (!items.length) return mount(box, head, empty('No sales in this period.', 'money'));
        if (paged) {
          const saleRow = (s) => { const ps = pick(s, 'paymentStatus', 'payment_status') || 'unpaid'; const pay = sel([{ v: 'paid', l: 'Paid' }, { v: 'partial', l: 'Part paid' }, { v: 'unpaid', l: 'Unpaid' }], ps, { 'aria-label': 'Payment status', disabled: !can('sales.record') }); pay.addEventListener('change', () => api('/sales/' + s.id, { method: 'PATCH', body: { paymentStatus: pay.value } }).then(() => toast('Payment updated.')).catch((e) => { fail(e); load(); }));
            return h('tr', null, h('td', null, fmtDate(pick(s, 'soldAt', 'sold_at', 'createdAt', 'created_at'))), h('td', null, pick(s, 'leadId', 'lead_id') ? h('a', { href: '#/leads/' + pick(s, 'leadId', 'lead_id') }, saleF.lead(s) || 'Lead') : ''), h('td', null, saleF.product(s)), h('td', null, String(s.quantity || 1)), h('td', null, money(amt(s))), h('td', null, saleF.staff(s) || ''), h('td', null, pay)); };
          const tbody = h('tbody', null, items.map(saleRow)); const moreBox = h('div', { class: 'loadmore', style: { textAlign: 'center', margin: '10px 0' } });
          let shown = items.length, cursor = d.nextCursor || null, busy = false;
          const drawMore = () => mount(moreBox, h('div', { class: 'small muted' }, 'Showing ' + shown + ' of ' + (tt.count != null ? tt.count : shown) + ' sales.'), cursor ? btn(busy ? 'Loading...' : 'Load more', loadMore, '', { disabled: busy }) : null);
          async function loadMore() {
            if (busy || !cursor) return; busy = true; drawMore();
            try {
              const n = await api('/sales', { query: { from: SL.from, to: SL.to, limit: SALES_PAGE, before: cursor } }); if (!ctx.alive()) return;
              const more = listOf(n, 'sales'); more.forEach((x) => tbody.appendChild(saleRow(x))); shown += more.length; cursor = n.nextCursor || null;
            } catch (e) { fail(e); } finally { busy = false; if (ctx.alive()) drawMore(); }
          }
          drawMore();
          return mount(box, head, h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Date', 'Lead', 'Product', 'Qty', 'Total', 'Staff', 'Payment'].map((x) => h('th', null, x)))), tbody)), moreBox);
        }
        const groups = {}; items.forEach((s) => { const k = saleF[SL.tab](s) || 'Unknown'; groups[k] = groups[k] || { label: k, value: 0, count: 0 }; groups[k].value += amt(s); groups[k].count++; });
        const rows = Object.values(groups).sort((a, b) => b.value - a.value); mount(box, head, h('div', { class: 'card' }, h('h2', null, 'Revenue ' + SL.tab.replace('lead', 'by lead').replace(/^(staff|product|campaign|ad)$/, 'by $1')), rows.map((r) => h('div', { class: 'listrow' }, h('span', { class: 'grow trunc' }, r.label), h('span', { class: 'small muted' }, r.count + ' sale' + (r.count === 1 ? '' : 's')), h('b', null, money(r.value)))), tt.count > items.length ? h('div', { class: 'small muted' }, 'Showing the latest ' + items.length + ' of ' + tt.count + ' sales.') : null));
      } catch (e) { if (ctx.alive()) mount(box, errbox(e, load)); }
    }
    drawTabs(); mount(root, h('div', { class: 'pagehead' }, h('h1', null, 'Sales')), C.rangeBar(SL, load), bar, box); load();
  }

  // zip 162: the helpers crm-admin-more.js shares with this file
  C.adminKit = { human, isObj, fmtVal, bars, block, autoTable };

  C.route('dashboard', dashboardScreen, { label: 'Dashboard', icon: 'home' });
  C.route('products', productsScreen, { label: 'Products', icon: 'box' });
  C.route('campaigns', campaignsScreen, { label: 'Campaigns', icon: 'target' });
  C.route('sales', salesScreen, { label: 'Sales', icon: 'money' });
  // zip 162: these four open from crm-admin-more.js (C.lazyAdmin fetches it once, then calls the real screen)
  C.route('reports', C.lazyAdmin('reports'), { label: 'Reports', icon: 'chart' });
  C.route('staff', C.lazyAdmin('staff'), { label: 'Team', icon: 'users' });
  C.route('settings', C.lazyAdmin('settings'), { label: 'Settings', icon: 'gear' });
  C.route('audit', C.lazyAdmin('audit'), { label: 'Audit log', icon: 'shield' });
})();
