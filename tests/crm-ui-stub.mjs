// In-memory fetch stub implementing ONLY the response shapes of the /api/crm/* contract (CRM_ARCHITECTURE.md §3) - used by crm-ui.test.mjs.
export const ALL_PERMS = ['leads.view', 'leads.create', 'leads.edit', 'leads.delete', 'leads.assign', 'leads.claim', 'leads.import', 'leads.export', 'staff.view', 'staff.add', 'staff.edit', 'staff.deactivate', 'staff.roles', 'campaigns.view', 'campaigns.create', 'campaigns.edit', 'campaigns.revenue', 'revenue.own', 'revenue.team', 'revenue.company', 'reports.own', 'reports.team', 'reports.company', 'settings.manage', 'settings.integrations', 'settings.products', 'settings.statuses', 'inbox.view', 'inbox.reply', 'meetings.manage', 'followups.manage', 'sales.record', 'audit.view'];
export const SALES_PERMS = ['leads.view', 'leads.create', 'leads.edit', 'leads.claim', 'inbox.view', 'inbox.reply', 'meetings.manage', 'followups.manage', 'sales.record', 'revenue.own', 'reports.own'];

function cfgItems(list) { return list.map((x, i) => ({ id: 'c' + i + x[0], key: x[0], label: x[1], color: x[2] || '#128c7e', active: true, isWon: x[3] === 'won', isLost: x[3] === 'lost' })); }
const CONFIG = {
  statuses: cfgItems([['new', 'New', '#1a73e8'], ['contacted', 'Contacted', '#e8a100'], ['qualified', 'Qualified', '#7e57c2'], ['won', 'Won', '#1fa855', 'won'], ['lost', 'Lost', '#d93025', 'lost']]),
  classifications: cfgItems([['hot', 'Hot', '#d93025'], ['warm', 'Warm', '#e8a100'], ['cold', 'Cold', '#1a73e8']]),
  sources: cfgItems([['whatsapp', 'WhatsApp'], ['facebook_ads', 'Facebook Ads'], ['referral', 'Referral']]),
  lostReasons: cfgItems([['price', 'Too expensive'], ['no_response', 'No response']]),
};

export function makeStub(opts = {}) {
  const S = {
    calls: [], me: { id: 'u1', name: 'Wanjiru Mwangi', email: 'w@x.co', role: opts.role || 'owner', perms: opts.perms || ALL_PERMS, status: 'active' },
    staff: [{ id: 'u1', name: 'Wanjiru Mwangi', email: 'w@x.co', role: 'owner', status: 'active' }, { id: 'u2', name: 'Otieno Baraka', email: 'o@x.co', phone: '0712000111', role: 'sales', status: 'active' }],
    leads: opts.leads || [
      { id: 'L1', name: 'Amina Hassan', phone: '0711222333', status: 'new', ownerId: null, source: 'whatsapp', createdAt: Date.now() - 3600e3, dealValue: 5000 },
      { id: 'L2', name: 'Brian Kamau', phone: '0722333444', whatsapp: '0722333444', email: 'b@k.co', status: 'contacted', classification: 'hot', ownerId: 'u1', ownerName: 'Wanjiru Mwangi', source: 'facebook_ads', campaign: 'Spring', createdAt: Date.now() - 86400e3, nextFollowupAt: Date.now() - 3600e3 },
    ],
    products: [{ id: 'p1', key: 'pos', label: 'MyDuka POS', price: 15000, active: true }, { id: 'p2', key: 'hotel', label: 'MyDuka Hotel', price: 30000, active: true }],
    conversations: opts.conversations || [{ id: 'cv1', name: 'Amina Hassan', phone: '254711222333', leadId: 'L1', lastMessage: 'Hello, price?', lastAt: Date.now() - 60e3, unread: 2 }],
    messages: { cv1: [{ id: 'm1', direction: 'in', text: 'Hello, price?', at: Date.now() - 60e3 }, { id: 'm2', direction: 'note', text: 'Call after 3pm', at: Date.now() - 30e3, userName: 'Wanjiru' }] },
    apiConfigured: !!opts.apiConfigured, followups: [], meetings: [], imports: {}, notes: [], failLogin: false, staffAdded: [], configPut: null, permsPut: null,
  };
  const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), blob: async () => new Blob([JSON.stringify(body)]) });
  const leadFull = (l) => ({ lead: l, products: [], timeline: S.notes.filter((n) => n.leadId === l.id).map((n) => ({ type: 'note', text: n.text, userName: 'Wanjiru', createdAt: Date.now() })), followups: S.followups.filter((f) => f.leadId === l.id), meetings: [], sales: [], owners: [], attributions: [], conversation: l.id === 'L1' ? { id: 'cv1' } : null });
  S.fetch = async (url, init = {}) => {
    const u = new URL(url, 'https://mydukapos.store'); const p = u.pathname.replace(/^\/api\/crm/, '') || '/'; const q = Object.fromEntries(u.searchParams); const method = (init.method || 'GET').toUpperCase(); const body = init.body ? JSON.parse(init.body) : undefined; const auth = (init.headers || {}).Authorization || '';
    S.calls.push({ method, path: p, q, body, auth });
    if (opts.handler) { const r = opts.handler({ method, p, q, body, S, json }); if (r) return r; }
    const m = (re) => p.match(re);
    if (method === 'POST' && p === '/auth/login') { if (S.failLogin || body.password !== 'secret123') return json(401, { error: 'Wrong email or password.', code: 'bad_credentials' }); return json(200, { token: 'c1.u2.1.sig', user: S.me }); }
    if (!auth && !p.startsWith('/auth/')) return json(401, { error: 'Sign in required', code: 'unauthorized' });
    if (p === '/me') return json(200, { user: S.me, config: CONFIG });
    if (p === '/config') return json(200, CONFIG);
    if (method === 'PUT' && (m(/^\/config\/(\w+)$/))) { S.configPut = { kind: m(/^\/config\/(\w+)$/)[1], body }; return json(200, { items: body.items }); }
    if (p === '/auth/invite' && method === 'GET') return q.token === 'good' ? json(200, { name: 'New Person', email: 'new@x.co', role: 'sales' }) : json(404, { error: 'This invitation is invalid or has expired.', code: 'invalid_token' });
    if (p === '/auth/invite/accept') return json(200, { token: 'c1.u3.1.sig', user: S.me });
    if (p === '/auth/reset/accept') return json(200, { ok: true });
    if (p === '/notifications') return json(200, { items: [{ id: 'n1', title: 'New lead: Amina', createdAt: Date.now(), read: false, leadId: 'L1' }], unread: 1 });
    if (p === '/notifications/read') return json(200, { ok: true });
    if (p === '/staff' && method === 'GET') return json(200, { items: S.staff });
    if (p === '/staff' && method === 'POST') { const u = { id: 'u9', ...body, status: 'invited' }; S.staff.push(u); S.staffAdded.push(body); return json(201, { user: u, inviteLink: 'https://mydukapos.store/crm/#/invite?token=abc123' }); }
    if (p === '/permissions') return json(200, { keys: ['leads.view', 'leads.edit', 'staff.view', 'settings.manage'], roles: { sales: ['leads.view', 'leads.edit'], manager: ['leads.view', 'leads.edit', 'staff.view'], owner: ['*'] } });
    if (m(/^\/staff\/(\w+)\/permissions$/) && method === 'PUT') { S.permsPut = body; return json(200, { ok: true }); }
    if (m(/^\/staff\/(\w+)\/reset-link$/)) return json(200, { link: 'https://mydukapos.store/crm/#/reset?token=zzz' });
    if (m(/^\/staff\/(\w+)\/activity$/)) return json(200, { items: [] });
    if (m(/^\/staff\/(\w+)$/) && method === 'GET') { const u = S.staff.find((x) => x.id === m(/^\/staff\/(\w+)$/)[1]); return u ? json(200, { user: u, stats: { assignedLeads: 4, conversions: 1, revenue: 15000 } }) : json(404, { error: 'Not found' }); }
    if (p === '/products') { if (method === 'POST') { const np = { id: 'p' + (S.products.length + 1), key: 'k', ...body }; S.products.push(np); return json(201, { product: np }); } return json(200, { items: S.products }); }
    if (p === '/campaigns') return json(200, { items: [{ id: 'cm1', name: 'Spring', platform: 'Facebook', status: 'active', metrics: { leads: 12 }, adsets: [{ id: 'as1', name: 'Nairobi 25-40', ads: [{ id: 'ad1', name: 'Video A' }] }] }] });
    if (p === '/leads/check-duplicates') return json(200, { duplicates: [] });
    if (p === '/leads' && method === 'GET') {
      let items = S.leads.slice(); if (q.pool) items = items.filter((l) => !l.ownerId); if (q.q) items = items.filter((l) => l.name.toLowerCase().includes(q.q.toLowerCase())); if (q.status) items = items.filter((l) => l.status === q.status); if (q.staff) items = items.filter((l) => l.ownerId === q.staff);
      const size = Number(q.pageSize || 25); const page = Number(q.page || 1); return json(200, { items: items.slice((page - 1) * size, page * size), total: items.length, page, pageSize: size });
    }
    if (p === '/leads' && method === 'POST') {
      const dup = S.leads.filter((l) => body.phone && l.phone === body.phone); if (dup.length && !body.force && !body.mergeInto) return json(409, { error: 'Possible duplicate', code: 'duplicate', duplicates: dup });
      if (body.mergeInto) return json(200, S.leads.find((l) => l.id === body.mergeInto)); const nl = { id: 'L' + (S.leads.length + 1), status: 'new', createdAt: Date.now(), ...body }; S.leads.push(nl); return json(201, nl);
    }
    if (p === '/leads/bulk') { S.bulk = body; return json(200, { updated: body.ids.length }); }
    if (p === '/leads/export.csv') return json(200, 'a,b');
    let mm;
    if ((mm = m(/^\/leads\/(\w+)\/(\w+)$/)) && method === 'POST') {
      const l = S.leads.find((x) => x.id === mm[1]); if (!l) return json(404, { error: 'Lead not found' });
      if (mm[2] === 'claim') { if (l.ownerId) return json(409, { error: 'Someone else claimed this lead first.', code: 'already_claimed' }); l.ownerId = S.me.id; l.ownerName = S.me.name; return json(200, { lead: l }); }
      if (mm[2] === 'status') { l.status = body.status; l.lostReason = body.lostReason; return json(200, { lead: l }); }
      if (mm[2] === 'note') { S.notes.push({ leadId: l.id, text: body.text }); return json(201, { ok: true }); }
      if (mm[2] === 'followups') { S.followups.push({ id: 'f' + (S.followups.length + 1), leadId: l.id, leadName: l.name, ...body, status: 'open' }); return json(201, { ok: true }); }
      return json(200, { ok: true });
    }
    if ((mm = m(/^\/leads\/(\w+)$/)) && method === 'GET') { const l = S.leads.find((x) => x.id === mm[1]); return l ? json(200, leadFull(l)) : json(404, { error: 'Lead not found', code: 'not_found' }); }
    if (p === '/followups') return json(200, { items: S.followups.filter((f) => q.bucket !== 'completed') });
    if (p === '/meetings') return json(200, { items: S.meetings });
    if (p === '/dashboard') return json(200, { range: { range: q.range, fromDay: '2026-09-30', toDay: '2026-09-30' }, scope: 'company', leads: { created: 7, contacted: 4, converted: 1, lost: 0, conversionRate: 12.5 }, pipeline: [{ key: 'new', label: 'New', color: '#1a73e8', count: 5 }, { key: 'won', label: 'Won', color: '#1fa855', count: 1 }], bySource: [{ source: 'whatsapp', leads: 5, won: 1 }, { source: 'facebook_ads', leads: 2, won: 0 }], followups: { overdue: 1, today: 3, upcoming: 2 }, meetings: { today: 1, next7Days: 2, completed: 0, noShow: 0 }, pool: 2, revenue: { deals: 3, total: 45000, collected: 30000, outstanding: 15000, byProduct: [{ productId: 'p1', product: 'MyDuka POS', deals: 3, revenue: 45000 }] }, marketing: null, staffBoard: [{ userId: 'u1', name: 'Wanjiru', openLeads: 4, contactAttempts: 9, dealsClosed: 3, revenue: 45000 }], inboxUnread: 1 });
    if (p.startsWith('/reports/')) return json(200, { rows: [{ name: 'Wanjiru', leads: 5, revenue: 45000 }] });
    if (p === '/sales') return json(200, { items: [{ id: 's1', leadId: 'L2', leadName: 'Brian Kamau', productLabel: 'MyDuka POS', quantity: 1, total: 15000, closedByName: 'Wanjiru', paymentStatus: 'paid', soldAt: Date.now() }], total: 1 });
    if (p === '/settings') return json(200, { settings: { companyName: 'MyDuka', currency: 'KES', defaultDuplicatePolicy: 'skip', defaultRemindMinutes: 15, firstContactTargetMinutes: 30 }, integrations: { whatsappInbound: true, whatsappApi: S.apiConfigured, metaWebhook: false, metaGraph: false } });
    if (p === '/audit') return json(200, { items: [{ id: 'a1', createdAt: Date.now(), userName: 'Wanjiru', action: 'lead.create', entity: 'lead', entityId: 'L1' }], total: 1 });
    if (p === '/inbox/status') return json(200, { apiConfigured: S.apiConfigured });
    if (p === '/inbox/conversations') return json(200, { items: S.conversations, unread: 1 });
    if ((mm = m(/^\/inbox\/conversations\/(\w+)\/messages$/))) {
      if (method === 'POST') { if (!S.apiConfigured) return json(400, { error: 'WhatsApp is not connected.', code: 'whatsapp_not_configured' }); S.messages[mm[1]].push({ id: 'mx', direction: 'out', text: body.text, at: Date.now() }); return json(201, { ok: true }); }
      return json(200, { items: S.messages[mm[1]] || [], conversation: S.conversations.find((c) => c.id === mm[1]) });
    }
    if ((mm = m(/^\/inbox\/conversations\/(\w+)\/note$/))) { S.messages[mm[1]].push({ id: 'mn', direction: 'note', text: body.text, at: Date.now(), userName: 'Wanjiru' }); return json(201, { ok: true }); }
    if (m(/^\/inbox\/conversations\/(\w+)\/(read|link)$/)) return json(200, { ok: true });
    if (p === '/imports' && method === 'POST') { const id = 'imp1'; S.imports[id] = { rows: [], body }; return json(201, { id }); }
    if (p === '/imports' && method === 'GET') return json(200, { items: [{ id: 'old1', fileName: 'march.csv', status: 'done', total: 10, created: 8, failed: 2, createdAt: Date.now() }] });
    if (p === '/imports/template.csv') return json(200, 'name,phone');
    if ((mm = m(/^\/imports\/(\w+)\/rows$/))) { S.imports[mm[1]].rows.push(...body.rows); return json(200, { added: body.rows.length }); }
    if ((mm = m(/^\/imports\/(\w+)\/preview$/))) return json(200, { counts: { total: S.imports[mm[1]].rows.length, valid: S.imports[mm[1]].rows.length - 1, invalid: 0, duplicates: 1, willCreate: S.imports[mm[1]].rows.length - 1, willUpdate: 0, willSkip: 1, warnings: 0 }, issues: [], sample: S.imports[mm[1]].rows.map((r, i) => ({ rowNo: i + 1, name: r.Name, phone: r.Phone, kind: 'valid' })) });
    if ((mm = m(/^\/imports\/(\w+)\/commit$/))) { const im = S.imports[mm[1]]; im.processed = Math.min((im.processed || 0) + 2, im.rows.length); return json(200, { done: im.processed >= im.rows.length, processed: im.processed, total: im.rows.length }); }
    if ((mm = m(/^\/imports\/(\w+)$/)) && method === 'GET') return json(200, { import: { id: mm[1], created: 2, updated: 0, skipped: 1, failed: 1 } });
    return json(404, { error: 'No such endpoint in the stub: ' + method + ' ' + p, code: 'not_found' });
  };
  return S;
}

