/* MyDuka CRM - leads: list, pool, add, import wizard, lead detail, shared follow-up / meeting / status dialogs. */
(function () {
  'use strict';
  const C = window.CRM; const { h, mount, ic, pick, listOf, api, toast, fail, openModal, field, sel, inp, loading, empty, errbox, btn, can, cfg, cfgPill, cfgLabel, cfgOptions, fmtDT, fmtDate, rel, money } = C;

  const txt = (v) => (v && typeof v === 'object') ? (pick(v, 'label', 'name', 'title', 'key') || '') : (v == null ? '' : String(v));
  function LD(l) {
    const st0 = pick(l, 'status', 'status_key', 'statusKey'); const st = st0 && typeof st0 === 'object' ? pick(st0, 'key', 'id') : st0;
    const cls = pick(l, 'classification', 'class', 'classificationKey', 'class_key', 'classKey');
    const pids = Array.isArray(l.productIds) ? l.productIds : null; const plist = (C.state.meta && C.state.meta.products) || [];
    let prods = pick(l, 'productNames', 'products', 'product_names', 'product') || (pids ? pids.map((id) => { const p = plist.find((x) => String(x.id) === String(id)); return p ? { label: p.label || p.name } : null; }).filter(Boolean) : undefined);
    const ft = l.firstTouch || {};
    prods = Array.isArray(prods) ? prods.map((x) => (x && typeof x === 'object' && x.label && !x.name ? x.label : txt(x))).filter(Boolean).join(', ') : txt(prods);
    const num = (v) => (v == null || v === '' ? undefined : Number(v));
    return { id: l.id, raw: l, name: pick(l, 'name', 'fullName', 'full_name') || 'Unnamed lead', phone: pick(l, 'phone'), whatsapp: pick(l, 'whatsapp'), email: pick(l, 'email'), company: pick(l, 'company', 'business_name', 'businessName'),
      status: st, cls: cls && typeof cls === 'object' ? pick(cls, 'key', 'id') : cls, ownerId: pick(l, 'ownerId', 'owner_id', 'assignedTo', 'assigned_to'), ownerName: pick(l, 'ownerName', 'owner_name', 'assignedName', 'owner') ,
      source: txt(pick(l, 'source', 'firstSourceKey', 'first_source_key', 'firstSource', 'first_source', 'source_key', 'sourceLabel')), campaign: ft.campaignName || attrName('campaigns', txt(ft.campaignId || pick(l, 'campaign', 'campaignName', 'campaign_name', 'firstCampaign', 'first_campaign', 'first_campaign_id'))), adset: ft.adsetName || attrName('adsets', txt(ft.adsetId || pick(l, 'adset', 'adsetName', 'adset_name', 'firstAdset', 'first_adset', 'first_adset_id'))), ad: ft.adName || attrName('ads', txt(ft.adId || pick(l, 'ad', 'adName', 'ad_name', 'firstAd', 'first_ad', 'first_ad_id'))),
      product: prods, dealValue: num(pick(l, 'estimatedValue', 'estimated_value', 'dealValue', 'deal_value')), estimatedValue: num(l.estimatedValue), actualValue: num(l.actualValue), expectedClose: l.expectedCloseDate || '', nextAction: l.nextAction || '', country: l.country || '',
      attempts: Number(l.contactAttempts || 0), lastBy: l.lastContactedByName || '', lastContact: pick(l, 'lastContactedAt', 'last_contacted_at', 'lastContactAt'), nextFollow: pick(l, 'nextFollowupAt', 'next_followup_at', 'nextFollowUp', 'nextFollowup'), nextFollowType: l.nextFollowupType || '', nextFollowNotes: l.nextFollowupNotes || '',
      revenue: num(pick(l, 'revenue', 'revenueWon', 'revenue_won')), created: pick(l, 'createdAt', 'created_at'), unread: Number(pick(l, 'unread', 'unreadCount') || 0), location: pick(l, 'location', 'city') };
  }
  function attrName(kind, v) {
    if (!v) return ''; const m = C.state.meta; if (!m) return v; let hit = '';
    m.campaigns.forEach((c) => { if (kind === 'campaigns' && String(c.id) === String(v)) hit = c.name; kids(c, 'adsets', 'adSets', 'ad_sets').forEach((s) => { if (kind === 'adsets' && String(s.id) === String(v)) hit = s.name; kids(s, 'ads').forEach((a) => { if (kind === 'ads' && String(a.id) === String(v)) hit = a.name; }); }); });
    return hit || v;
  }
  function kids(n, ...k) { for (const x of k) if (Array.isArray(n[x])) return n[x]; return []; }
  const pname = (p) => (p && (p.name || p.label || p.key)) || '';
  C.LD = LD; C.txt = txt; C.pname = pname; C.kidsOf = kids;
  function ownerLabel(l) { if (l.ownerName && typeof l.ownerName === 'object') return txt(l.ownerName); return l.ownerName || (l.ownerId ? (C.staffName(l.ownerId) || 'Assigned') : ''); }

  async function meta() {
    if (C.state.meta) return C.state.meta;
    const [camps, prods] = await Promise.all([api('/campaigns', { query: { lite: 1 } }).catch((e) => (e && e.status === 403 ? api('/campaigns').catch(() => ({})) : {})), api('/products').catch(() => ({}))]);
    C.state.meta = { campaigns: listOf(camps, 'campaigns'), products: listOf(prods, 'products') }; return C.state.meta;
  }
  C.meta = meta; C.invalidateMeta = () => { C.state.meta = null; };
  const errMsg = (e) => (e && e.message) || 'Something went wrong';

  /* ---------- shared dialogs ---------- */
  function statusDialog(leadId, current, done) {
    const st = sel(C.statusPick(false, '', current), current);
    const reasonWrap = h('div', { class: 'hidden' }); const reason = sel(cfgOptions('lostReasons', true, 'Select a reason...'), '');
    reasonWrap.appendChild(field('Lost reason', reason));
    const upd = () => { const i = C.cfgFind('statuses', st.value); reasonWrap.classList.toggle('hidden', !(i && i.isLost)); };
    st.addEventListener('change', upd); upd();
    openModal({ title: 'Change status', body: h('div', null, field('Status', st), reasonWrap), actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => {
      const i = C.cfgFind('statuses', st.value); if (i && i.isLost && !reason.value && cfg('lostReasons').length) { toast('Pick a lost reason.', true); return false; }
      await api('/leads/' + leadId + '/status', { body: { status: st.value, lostReason: reason.value || undefined } }); toast('Status updated.'); done && done();
    } }] });
  }
  async function assignDialog(leadIds, done, current) {
    const staff = await C.staffList(); const s = sel(C.staffOptions(staff, true, 'Unassigned (back to pool)'), current || '');
    openModal({ title: leadIds.length > 1 ? 'Assign ' + leadIds.length + ' leads' : 'Assign lead', body: field('Assign to', s), actions: [{ label: 'Cancel' }, { label: 'Assign', kind: 'primary', onClick: async () => {
      if (leadIds.length > 1) await api('/leads/bulk', { body: { ids: leadIds, action: 'assign', value: s.value || null } });
      else await api('/leads/' + leadIds[0] + '/assign', { body: { userId: s.value || null } });
      toast('Assigned.'); done && done();
    } }] });
  }
  function followupDialog(leadId, existing, done) {
    const tomorrow = C.addDays(C.ymd(), 1) + 'T09:00';
    const due = inp('datetime-local', { value: existing ? C.toLocalInput(pick(existing, 'dueAt', 'due_at')) : tomorrow });
    const type = sel([{ v: 'call', l: 'Call' }, { v: 'whatsapp', l: 'WhatsApp' }, { v: 'email', l: 'Email' }, { v: 'visit', l: 'Visit' }, { v: 'meeting', l: 'Meeting' }, { v: 'demo', l: 'Demo' }, { v: 'task', l: 'Task' }, { v: 'other', l: 'Other' }], existing && existing.type || 'call');
    const notes = h('textarea', { placeholder: 'What to cover...' }); notes.value = (existing && existing.notes) || '';
    const rem = sel([{ v: '', l: 'No reminder' }, { v: '15', l: '15 minutes before' }, { v: '60', l: '1 hour before' }, { v: '1440', l: '1 day before' }], existing && pick(existing, 'remindMinutes', 'remind_minutes') != null ? String(pick(existing, 'remindMinutes', 'remind_minutes')) : '15');
    const quick = h('div', { class: 'btnrow', style: { marginBottom: '8px' } }, [['In 1 hour', 60], ['Tomorrow 9am', 0], ['In 3 days', 3], ['Next week', 7]].map(([l, v]) => btn(l, () => {
      if (l === 'In 1 hour') due.value = C.toLocalInput(Date.now() + 3600e3); else if (l === 'Tomorrow 9am') due.value = C.addDays(C.ymd(), 1) + 'T09:00'; else due.value = C.addDays(C.ymd(), v) + 'T09:00';
    }, 'sm')));
    openModal({ title: existing ? 'Edit follow-up' : 'Schedule follow-up', body: h('div', null, quick, field('Due', due), field('Type', type), field('Notes', notes), field('Reminder', rem)), actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => {
      const dueAt = C.fromLocalInput(due.value); if (!dueAt) { toast('Choose a date and time.', true); return false; }
      const body = { dueAt, type: type.value, notes: notes.value.trim(), remindMinutes: rem.value === '' ? 0 : Number(rem.value) };
      if (existing) await api('/followups/' + existing.id, { method: 'PATCH', body }); else await api('/leads/' + leadId + '/followups', { body });
      toast('Follow-up saved.'); done && done();
    } }] });
  }
  function meetingDialog(leadId, existing, done) {
    const start = inp('datetime-local', { value: existing ? C.toLocalInput(pick(existing, 'startsAt', 'starts_at')) : C.addDays(C.ymd(), 1) + '10:00'.replace(/^/, 'T') });
    const dur = sel([{ v: '15', l: '15 min' }, { v: '30', l: '30 min' }, { v: '45', l: '45 min' }, { v: '60', l: '1 hour' }, { v: '90', l: '1.5 hours' }, { v: '120', l: '2 hours' }], String(existing && pick(existing, 'durationMin', 'duration_min') || 30));
    const type = sel([{ v: 'video', l: 'Video call' }, { v: 'call', l: 'Phone call' }, { v: 'visit', l: 'Visit (at their place)' }, { v: 'office', l: 'At our office' }, { v: 'other', l: 'Other' }], existing && existing.type || 'video');
    const loc = inp('text', { value: (existing && existing.location) || '', placeholder: 'Address or place' }), link = inp('url', { value: (existing && existing.link) || '', placeholder: 'https://meet...' });
    const notes = h('textarea'); notes.value = (existing && existing.notes) || '';
    const who = !existing && can('leads.all') ? sel(C.staffOptions(C.state.staffCache || [], true, 'The lead owner'), '') : null;
    if (who) C.staffList().then((st) => { C.state.staffCache = st; const cur = who.value; who.replaceChildren(...C.staffOptions(st, true, 'The lead owner').map((o) => h('option', { value: o.v }, o.l))); who.value = cur; }).catch(() => {});
    openModal({ title: existing ? 'Reschedule / edit meeting' : 'Schedule meeting', body: h('div', null, who ? field('With', who) : null, field('Starts', start), h('div', { class: 'grid2' }, field('Duration', dur), field('Type', type)), field('Location', loc), field('Video link', link), field('Notes', notes)), actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => {
      const startsAt = C.fromLocalInput(start.value); if (!startsAt) { toast('Choose a date and time.', true); return false; }
      const body = { startsAt, durationMin: Number(dur.value), type: type.value, location: loc.value.trim(), link: link.value.trim(), notes: notes.value.trim() };
      if (who && who.value) body.userId = who.value;
      if (existing) await api('/meetings/' + existing.id, { method: 'PATCH', body }); else await api('/leads/' + leadId + '/meetings', { body });
      toast('Meeting saved.'); done && done();
    } }] });
  }
  function contactDialog(leadId, method, done) {
    const m = sel([{ v: 'call', l: 'Call' }, { v: 'whatsapp', l: 'WhatsApp' }, { v: 'email', l: 'Email' }, { v: 'sms', l: 'SMS' }, { v: 'visit', l: 'Visit' }, { v: 'other', l: 'Other' }], method || 'call');
    const o = sel([{ v: 'answered', l: 'Spoke to them' }, { v: 'reached', l: 'Reached' }, { v: 'replied', l: 'They replied' }, { v: 'interested', l: 'Interested' }, { v: 'not_interested', l: 'Not interested' }, { v: 'callback', l: 'Asked for a callback' }, { v: 'no_answer', l: 'No answer' }, { v: 'busy', l: 'Busy' }, { v: 'voicemail', l: 'Left a message' }, { v: 'wrong_number', l: 'Wrong number' }, { v: 'other', l: 'Other' }], 'answered');
    const n = h('textarea', { placeholder: 'What was said?' }); const na = inp('text', { placeholder: 'e.g. Send the quote', maxlength: '200' });
    openModal({ title: 'Log contact', body: h('div', null, h('div', { class: 'grid2' }, field('How', m), field('Outcome', o)), field('Notes', n), field('Next action (optional)', na)), actions: [{ label: 'Cancel' }, { label: 'Log it', kind: 'primary', onClick: async () => {
      await api('/leads/' + leadId + '/contact', { body: { method: m.value, outcome: o.value, notes: n.value.trim() || undefined, nextAction: na.value.trim() || undefined } }); toast('Contact logged.'); done && done();
    } }] });
  }
  C.dialogs = { statusDialog, assignDialog, followupDialog, meetingDialog, contactDialog };

  async function convertDialog(lead, products, done) {
    const m = await meta(); const plist = m.products.filter((p) => p.active !== false);
    const prod = sel([{ v: '', l: 'Choose product...' }].concat(plist.map((p) => ({ v: p.id, l: pname(p) }))), (products[0] && products[0].id) || '');
    const qty = inp('number', { value: '1', min: '1', step: '1' }), price = inp('number', { value: '', min: '0', step: '1' }), disc = inp('number', { value: '0', min: '0', step: '1' });
    const pay = sel([{ v: 'paid', l: 'Paid in full' }, { v: 'partial', l: 'Part paid' }, { v: 'unpaid', l: 'Not paid yet' }], 'unpaid');
    const paid = inp('number', { min: '0', step: '1', placeholder: 'Amount paid so far' }); const paidWrap = h('div', { class: 'hidden' }, field('Amount paid so far (KES)', paid)); pay.addEventListener('change', () => paidWrap.classList.toggle('hidden', pay.value !== 'partial'));
    const cc = inp('checkbox'); const total = h('div', { class: 'kpi accent' }, h('div', { class: 'v' }, '-'), h('div', { class: 'l' }, 'Sale total'));
    const calc = () => { const t = Math.max(0, Number(qty.value || 0) * Number(price.value || 0) - Number(disc.value || 0)); total.firstChild.textContent = money(t); };
    const fillPrice = () => { const p = plist.find((x) => String(x.id) === String(prod.value)); if (p && pick(p, 'price', 'unitPrice', 'unit_price') != null) price.value = pick(p, 'price', 'unitPrice', 'unit_price'); calc(); };
    prod.addEventListener('change', fillPrice); [qty, price, disc].forEach((x) => x.addEventListener('input', calc));
    if (!price.value && LD(lead).dealValue) price.value = LD(lead).dealValue; fillPrice(); if (LD(lead).dealValue && !prod.value) price.value = LD(lead).dealValue; calc();
    openModal({ title: 'Convert to customer', body: h('div', null, field('Product', prod), h('div', { class: 'grid3' }, field('Quantity', qty), field('Unit price (KES)', price), field('Discount (KES)', disc)), field('Payment', pay), paidWrap, total,
      C.can('leads.edit') ? h('label', { class: 'row', style: { marginTop: '10px' } }, cc, 'Also create the MyDuka client account') : null), actions: [{ label: 'Cancel' }, { label: 'Convert', kind: 'primary', onClick: async () => {
      if (!prod.value) { toast('Choose the product sold.', true); return false; }
      await api('/leads/' + lead.id + '/convert', { body: { productId: prod.value, quantity: Number(qty.value || 1), unitPrice: Number(price.value || 0), discount: Number(disc.value || 0), paymentStatus: pay.value, amountPaid: pay.value === 'partial' ? Number(paid.value || 0) : undefined, createClient: cc.checked } });
      toast('Lead converted. Well done!'); done && done();
    } }] });
  }

  /* ---------- lead form (add / edit) ---------- */
  async function leadForm(initial, opts) {
    initial = initial || {}; const edit = !!(opts && opts.edit); const m = await meta(); const staff = can('leads.assign') ? await C.staffList() : [];
    const name = inp('text', { value: initial.name || '', autocomplete: 'off', required: 'true' }), phone = inp('tel', { value: initial.phone || '', placeholder: '07xx xxx xxx' }), wa = inp('tel', { value: initial.whatsapp || '' }), email = inp('email', { value: initial.email || '' });
    const company = inp('text', { value: initial.company || initial.businessName || '' }), location = inp('text', { value: initial.location || '' }), country = inp('text', { value: initial.country || '', placeholder: 'Kenya' });
    const source = sel(cfgOptions('sources', true, 'Manual entry', edit), initial.source || '');
    const status = edit ? null : sel(cfgOptions('statuses', true, 'New', true).filter((o) => { const i = o.v && C.cfgFind('statuses', o.v); return !i || (!i.isWon && !i.isLost); }), '');
    const cls = edit ? null : sel(cfgOptions('classifications', true, 'Not classified', true), initial.cls || '');
    const est = inp('number', { value: initial.estimatedValue != null ? String(initial.estimatedValue) : '', min: '0', step: '1', placeholder: 'KES' }), close = inp('date', { value: initial.expectedClose || '' }), nextAct = inp('text', { value: initial.nextAction || '', maxlength: '200', placeholder: 'e.g. Send the quote' });
    const notes = h('textarea', { placeholder: 'First note (optional)' }); const owner = staff.length && !edit ? sel(C.staffOptions(staff, true, 'Unassigned (pool)'), initial.ownerId || (opts && opts.defaultOwner) || '') : null;
    const chosen = new Set((initial.productIds || []).map(String));
    const chips = h('div', { class: 'btnrow' }, m.products.filter((p) => p.active !== false).map((p) => { const c = h('button', { class: 'chip', type: 'button', 'aria-pressed': chosen.has(String(p.id)) ? 'true' : 'false', onclick: () => { const on = !chosen.has(String(p.id)); on ? chosen.add(String(p.id)) : chosen.delete(String(p.id)); c.setAttribute('aria-pressed', on ? 'true' : 'false'); } }, pname(p)); return c; }));
    // where the lead came from (only when creating: the first touch of an existing lead is never rewritten)
    let camp = null, aset = null, ad = null, utmS = null, utmC = null, land = null, attr = null;
    if (!edit) {
      camp = sel([{ v: '', l: 'No campaign' }].concat(m.campaigns.map((c) => ({ v: c.id, l: c.name }))), ''); aset = sel([{ v: '', l: 'No ad set' }], ''); ad = sel([{ v: '', l: 'No ad' }], '');
      utmS = inp('text', { placeholder: 'utm_source', maxlength: '80' }); utmC = inp('text', { placeholder: 'utm_campaign', maxlength: '120' }); land = inp('url', { placeholder: 'https://...', maxlength: '300' });
      const fill = (el, first, list) => { el.replaceChildren(...[{ v: '', l: first }].concat(list.map((x) => ({ v: x.id, l: x.name }))).map((o) => h('option', { value: o.v }, o.l))); };
      const adsOf = () => { const c = m.campaigns.find((x) => String(x.id) === camp.value); if (!c) return []; const sets = kids(c, 'adsets', 'adSets', 'ad_sets'); const one = sets.find((x) => String(x.id) === aset.value); return one ? kids(one, 'ads') : sets.reduce((acc, x) => acc.concat(kids(x, 'ads')), []); };
      camp.addEventListener('change', () => { const c = m.campaigns.find((x) => String(x.id) === camp.value); fill(aset, 'No ad set', c ? kids(c, 'adsets', 'adSets', 'ad_sets') : []); fill(ad, 'No ad', adsOf()); });
      aset.addEventListener('change', () => fill(ad, 'No ad', adsOf()));
      attr = h('details', { class: 'field' }, h('summary', null, 'Campaign / ad (optional)'), h('div', { class: 'grid3' }, field('Campaign', camp), field('Ad set', aset), field('Ad', ad)), h('div', { class: 'grid2' }, field('UTM source', utmS), field('UTM campaign', utmC)), field('Landing page', land));
    }
    const node = h('div', null, field('Full name *', name), h('div', { class: 'grid2' }, field('Phone', phone), field('WhatsApp (if different)', wa)), h('div', { class: 'grid2' }, field('Email', email), field('Company', company)),
      h('div', { class: 'grid2' }, field('Location', location), field('Country', country)), h('div', { class: 'grid2' }, field('Source', source), owner ? field('Assign to', owner) : null),
      status || cls ? h('div', { class: 'grid2' }, status ? field('Status', status) : null, cls ? field('Classification', cls) : null) : null,
      h('div', { class: 'grid3' }, field('Estimated value (KES)', est), field('Expected close date', close), field('Next action', nextAct)), attr,
      m.products.length ? h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Products of interest'), chips) : null, edit ? null : field('Note', notes));
    return { node, get() {
      const errs = []; if (!name.value.trim()) errs.push('Enter the lead\'s name.'); if (!phone.value.trim() && !wa.value.trim() && !email.value.trim()) errs.push('Enter a phone number, WhatsApp number or email.');
      if (email.value.trim() && !/^\S+@\S+\.\S+$/.test(email.value.trim())) errs.push('That email address does not look right.');
      if (est.value !== '' && !(Number(est.value) >= 0)) errs.push('Estimated value must be 0 or more.');
      const body = { name: name.value.trim(), phone: phone.value.trim(), whatsapp: wa.value.trim() || undefined, email: email.value.trim() || undefined, businessName: company.value.trim() || undefined, location: location.value.trim() || undefined, source: source.value || undefined, productIds: [...chosen],
        country: country.value.trim() || (edit ? null : undefined), estimatedValue: est.value !== '' ? Number(est.value) : (edit ? null : undefined), expectedCloseDate: close.value || (edit ? null : undefined), nextAction: nextAct.value.trim() || (edit ? null : undefined) };
      if (status && status.value) body.status = status.value; if (cls && cls.value) body.classification = cls.value;
      if (camp) { if (camp.value) body.campaignId = camp.value; if (aset.value) body.adsetId = aset.value; if (ad.value) body.adId = ad.value; if (utmS.value.trim()) body.utm_source = utmS.value.trim(); if (utmC.value.trim()) body.utm_campaign = utmC.value.trim(); if (land.value.trim()) body.landing_url = land.value.trim(); }
      if (owner && owner.value) body.assignTo = owner.value; if (!edit && notes.value.trim()) body.notes = notes.value.trim();
      return { errs, body };
    } };
  }
  function dupDialog(dups, retry) {
    const list = h('div', null, dups.map((d) => { const l = LD(d.lead || d); if (d.restricted || !l.id) return h('div', { class: 'listrow' }, C.avatar(l.name, null, 'sm'), h('div', { class: 'grow' }, h('div', { class: 'trunc' }, l.name), h('div', { class: 'small muted' }, 'Belongs to ' + (ownerLabel(l) || 'another team member') + ' - you cannot open or merge it.'))); return h('div', { class: 'listrow' }, C.avatar(l.name, null, 'sm'), h('div', { class: 'grow' }, h('div', { class: 'trunc' }, l.name), h('div', { class: 'small muted' }, [l.phone, l.email, ownerLabel(l) ? 'Owner: ' + ownerLabel(l) : 'In pool'].filter(Boolean).join(' - '))),
      h('a', { class: 'btn sm', href: '#/leads/' + l.id, onclick: () => { document.getElementById('modal-root').replaceChildren(); } }, 'Open'), btn('Merge into', async (ev) => { ev.currentTarget.disabled = true; try { await retry({ mergeInto: l.id }); document.getElementById('modal-root').replaceChildren(); } catch (e) { fail(e); ev.currentTarget.disabled = false; } }, 'sm primary')); }));
    openModal({ title: 'Possible duplicate', wide: true, body: h('div', null, h('p', { class: 'muted' }, 'A lead with the same phone, WhatsApp or email already exists.'), list), actions: [{ label: 'Cancel' }, { label: 'Create anyway', kind: 'danger', onClick: async () => { await retry({ force: true }); } }] });
  }
  async function addLeadDialog(done) {
    const f = await leadForm({}, { defaultOwner: can('leads.assign') ? '' : (C.state.me && C.state.me.id) });
    const m = openModal({ title: 'Add lead', wide: true, body: f.node, actions: [{ label: 'Cancel' }, { label: 'Save lead', kind: 'primary', onClick: async () => {
      const r = f.get(); if (r.errs.length) { toast(r.errs[0], true); return false; }
      const send = async (extra) => { const d = await api('/leads', { body: Object.assign({}, r.body, extra || {}) }); toast('Lead saved.'); const l = d.lead || d; done ? done(l) : (l.id && C.go('#/leads/' + l.id)); return d; };
      try { await send(); } catch (e) {
        const dd = e.data && (e.data.duplicates || (e.data.extra && e.data.extra.duplicates) || (e.data.details && e.data.details.duplicates)); if (e.status === 409 && dd) { dupDialog(listOf(dd), send); return false; } throw e;
      }
    } }] });
    return m;
  }
  C.addLeadDialog = addLeadDialog;

  /* ---------- leads list ---------- */
  const LST = { all: { page: 1, pageSize: 25, sort: 'created_at', dir: 'desc', f: {} }, mine: { page: 1, pageSize: 25, sort: 'created_at', dir: 'desc', f: {} }, pool: { page: 1, pageSize: 25, sort: 'created_at', dir: 'desc', f: {} } };
  // the spec's column order (section 33); the server sorts by every column that has a sort key
  const COLS = [['name', 'Name', 'name'], ['phone', 'Phone', 'phone'], ['source', 'Source', 'source'], ['campaign', 'Campaign', 'campaign'], ['ad', 'Ad', 'ad'], ['product', 'Product', 'product'], ['status', 'Status', 'status'], ['cls', 'Classification', 'class'], ['owner', 'Staff', 'staff'], ['lastContact', 'Last contact', 'last_contact'], ['nextFollow', 'Next follow-up', 'next_followup'], ['dealValue', 'Deal value', 'deal_value'], ['revenue', 'Revenue', 'revenue'], ['created', 'Created', 'created_at']];
  function cell(l, k) {
    switch (k) {
      case 'name': return h('div', { class: 'row' }, C.avatar(l.name, null, 'sm'), h('div', { style: { minWidth: 0 } }, h('div', { class: 'trunc', style: { fontWeight: 600, maxWidth: '200px' } }, l.name), l.company ? h('div', { class: 'tiny faint trunc' }, l.company) : null));
      case 'phone': return l.phone || l.whatsapp || '';
      case 'status': return cfgPill('statuses', l.status);
      case 'cls': return l.cls ? cfgPill('classifications', l.cls) : h('span', { class: 'faint' }, '-');
      case 'owner': return ownerLabel(l) || h('span', { class: 'faint' }, 'Unassigned');
      case 'source': return C.cfgFind('sources', l.source) ? cfgLabel('sources', l.source) : l.source;
      case 'dealValue': return l.dealValue != null ? money(l.dealValue) : '';
      case 'revenue': return l.revenue ? money(l.revenue) : '';
      case 'campaign': return l.campaign || '';
      case 'ad': return l.ad || '';
      case 'product': return l.product || '';
      case 'lastContact': return l.lastContact ? rel(l.lastContact) : '';
      case 'nextFollow': { const t = C.ts(l.nextFollow); return t ? h('span', { style: t < Date.now() ? { color: 'var(--danger)', fontWeight: 600 } : null }, fmtDT(t)) : ''; }
      case 'created': return fmtDate(l.created);
      default: return l[k] || '';
    }
  }
  function quickBtns(l) {
    const b = [];
    if (l.phone || l.whatsapp) { b.push(h('a', { class: 'btn sm', href: C.telHref(l.phone || l.whatsapp), 'aria-label': 'Call ' + l.name, onclick: (e) => e.stopPropagation() }, ic('phone'), 'Call')); b.push(h('a', { class: 'btn sm wa', href: C.waHref(l.whatsapp || l.phone), target: '_blank', rel: 'noopener', 'aria-label': 'WhatsApp ' + l.name, onclick: (e) => e.stopPropagation() }, ic('wa'), 'WhatsApp')); }
    return b;
  }
  async function claim(id, onLose) {
    try { await api('/leads/' + id + '/claim', { body: {} }); toast('Lead claimed - it is yours now.'); C.go('#/leads/' + id); }
    catch (e) { fail(e); if (e.status === 409 && onLose) onLose(); }
  }

  async function leadsScreen(ctx) {
    const sub = ctx.parts[1];
    if (sub === 'import') return importScreen(ctx);
    if (sub && sub !== 'pool' && sub !== 'mine') return leadDetail(ctx, sub);
    const mode = sub === 'pool' ? 'pool' : (sub === 'mine' ? 'mine' : 'all'); const S = LST[mode]; const f = S.f;
    await meta(); const staff = await C.staffList();
    const root = ctx.root; const sel_ = new Set(); let lastTotal = 0;
    const listBox = h('div', null, loading()); const bulk = h('div');
    const tabsBar = C.tabs([{ v: 'all', l: 'All leads' }, { v: 'mine', l: 'My leads' }, { v: 'pool', l: 'Available' }], mode, (v) => { C.go(v === 'all' ? '#/leads' : '#/leads/' + v); });
    const head = h('div', { class: 'pagehead' }, tabsBar, h('span', { class: 'right row' }, can('leads.import') ? h('a', { class: 'btn', href: '#/leads/import' }, ic('upload'), 'Import') : null, can('leads.export') ? btn('Export', () => C.download('/leads/export.csv', 'leads.csv', queryOf()).catch(fail), '') : null, can('leads.create') ? btn('Add lead', () => addLeadDialog(), 'primary', { 'aria-label': 'Add lead' }) : null));
    const q = inp('search', { class: 'search', placeholder: 'Search name, phone, WhatsApp, email, company...', value: f.q || '', 'aria-label': 'Search leads' });
    const mk = (key, options, label) => { const s = sel(options, f[key] || '', { 'aria-label': label }); s.addEventListener('change', () => { f[key] = s.value; S.page = 1; load(); }); return s; };
    const campOpts = [{ v: '', l: 'Any campaign' }].concat(C.state.meta.campaigns.map((c) => ({ v: c.id, l: c.name }))), adOpts = [{ v: '', l: 'Any ad' }].concat(C.state.meta.campaigns.reduce((acc, c) => acc.concat(kids(c, 'adsets', 'adSets', 'ad_sets').reduce((a2, x) => a2.concat(kids(x, 'ads')), [])), []).map((a) => ({ v: a.id, l: a.name }))), setOpts = [{ v: '', l: 'Any ad set' }].concat(C.state.meta.campaigns.reduce((acc, c) => acc.concat(kids(c, 'adsets', 'adSets', 'ad_sets')), []).map((a) => ({ v: a.id, l: a.name }))), prodOpts = [{ v: '', l: 'Any product' }].concat(C.state.meta.products.map((p) => ({ v: p.id, l: pname(p) })));
    const adv = h('div', { class: 'filters filters-adv' }, mk('status', cfgOptions('statuses', true, 'Any status', true), 'Status'), mk('class', cfgOptions('classifications', true, 'Any class', true), 'Classification'),
      mode === 'pool' ? null : mk('staff', C.staffOptions(staff, true, 'Any staff'), 'Staff'), mk('source', cfgOptions('sources', true, 'Any source', true), 'Source'), mk('campaign', campOpts, 'Campaign'), mk('adset', setOpts, 'Ad set'), mk('ad', adOpts, 'Ad'), mk('product', prodOpts, 'Product'),
      mk('follow', [{ v: '', l: 'Any follow-up' }, { v: 'today', l: 'Due today' }, { v: 'overdue', l: 'Overdue' }, { v: 'upcoming', l: 'Upcoming' }, { v: 'none', l: 'None set' }], 'Follow-up'), can('revenue.own') || can('revenue.team') || can('revenue.company') ? mk('revenue', [{ v: '', l: 'Any revenue' }, { v: 'won', l: 'Won' }, { v: 'none', l: 'No revenue' }], 'Revenue') : null,
      C.inp('date', { value: f.from || '', 'aria-label': 'Created from', onchange: (e) => { f.from = e.target.value; S.page = 1; load(); } }), C.inp('date', { value: f.to || '', 'aria-label': 'Created to', onchange: (e) => { f.to = e.target.value; S.page = 1; load(); } }),
      btn('Clear', () => { Object.keys(f).forEach((k) => delete f[k]); S.page = 1; C.go(location.hash); }, 'sm ghost'));
    const filtBtn = h('button', { class: 'btn only-narrow-inline', type: 'button', 'aria-expanded': 'false', onclick: (e) => { const o = adv.classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', String(o)); } }, ic('filter'), 'Filters');
    const filters = h('div', null, h('div', { class: 'filters' }, q, filtBtn), adv);
    q.addEventListener('input', C.debounce(() => { const v = q.value.trim(); if (v === (f.q || '')) return; f.q = v; S.page = 1; load(); }, 250));
    function queryOf() { const o = Object.assign({}, f, { sort: S.sort, dir: S.dir, page: S.page, pageSize: S.pageSize }); if (mode === 'pool') o.pool = 1; if (mode === 'mine') o.staff = 'me'; return o; }
    function renderBulk() {
      if (!sel_.size || mode === 'pool') return mount(bulk);
      const st = sel(C.statusPick(true, 'Set status...'), ''), cl = sel(cfgOptions('classifications', true, 'Set class...'), '');
      const send = async (action, value, lostReason) => { try { const r = await api('/leads/bulk', { body: { ids: [...sel_], action, value, lostReason } }); const failed = Number(r.failed || 0); const bad = listOf(r.results).find((x) => x.ok === false); toast(failed ? ('Updated ' + (r.ok != null ? r.ok : sel_.size - failed) + ', ' + failed + ' failed: ' + (bad && bad.error || 'not allowed')) : 'Updated ' + sel_.size + ' leads.', !!failed); sel_.clear(); load(); } catch (e) { fail(e); } };
      const run = (action, value) => { if (!value) return; const i = action === 'status' && C.cfgFind('statuses', value); if (i && i.isLost && cfg('lostReasons').length) { const rs = sel(cfgOptions('lostReasons', false, '', false), ''); openModal({ title: 'Mark ' + sel_.size + ' leads lost', body: field('Lost reason', rs), actions: [{ label: 'Cancel', onClick: () => { st.value = ''; } }, { label: 'Mark lost', kind: 'primary', onClick: async () => { await send(action, value, rs.value); } }] }); } else send(action, value); };
      st.addEventListener('change', () => run('status', st.value)); cl.addEventListener('change', () => run('classification', cl.value));
      mount(bulk, h('div', { class: 'bulkbar' }, h('b', null, sel_.size + ' selected'), can('leads.assign') ? btn('Assign...', () => assignDialog([...sel_], () => { sel_.clear(); load(); }), 'sm') : null, can('leads.edit') ? [st, cl] : null, btn('Clear', () => { sel_.clear(); load(); }, 'sm ghost', { style: { color: '#fff' } })));
    }
    function draw(d) {
      const items = listOf(d, 'leads').map(LD); lastTotal = Number(d.total != null ? d.total : items.length);
      if (!items.length) { mount(listBox, empty(mode === 'pool' ? 'No unclaimed leads right now. New leads land here first.' : 'No leads match these filters.', 'users', can('leads.create') ? btn('Add a lead', () => addLeadDialog(), 'primary') : null)); return; }
      const allBox = inp('checkbox', { 'aria-label': 'Select all on this page', onchange: () => { items.forEach((l) => allBox.checked ? sel_.add(l.id) : sel_.delete(l.id)); load(); } });
      const canRev = d.canSeeRevenue !== false;
      const cols = COLS.filter((c) => (mode !== 'pool' || !['owner', 'nextFollow', 'lastContact', 'revenue'].includes(c[0])) && (canRev || c[0] !== 'revenue'));
      const thead = h('tr', null, mode === 'pool' ? null : h('th', null, allBox), cols.map(([k, label, sk]) => h('th', { class: sk ? 'sortable' : '', tabindex: sk ? '0' : null, role: sk ? 'button' : null, 'aria-sort': sk && S.sort === sk ? (S.dir === 'asc' ? 'ascending' : 'descending') : null,
        onclick: sk ? () => { if (S.sort === sk) S.dir = S.dir === 'asc' ? 'desc' : 'asc'; else { S.sort = sk; S.dir = 'asc'; } load(); } : null, onkeydown: sk ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } } : null }, label + (S.sort === sk ? (S.dir === 'asc' ? ' ▲' : ' ▼') : ''))), h('th', null, ''));
      const tbody = h('tbody', null, items.map((l) => h('tr', { class: 'click', tabindex: '0', onclick: () => C.go('#/leads/' + l.id), onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) C.go('#/leads/' + l.id); } },
        mode === 'pool' ? null : h('td', { onclick: (e) => e.stopPropagation() }, inp('checkbox', { checked: sel_.has(l.id), 'aria-label': 'Select ' + l.name, onchange: (e) => { e.target.checked ? sel_.add(l.id) : sel_.delete(l.id); renderBulk(); } })),
        cols.map(([k]) => h('td', null, cell(l, k))), h('td', { style: { whiteSpace: 'nowrap' } }, mode === 'pool' || (!l.ownerId && can('leads.claim')) ? (can('leads.claim') ? btn('Claim', (e) => { e.stopPropagation(); claim(l.id, load); }, 'sm primary') : null) : quickBtns(l)))));
      const wide = window.innerWidth >= 820;   // zip 161: build ONE layout (the table or the cards), not both (halves the DOM)
      const table = !wide ? null : h('div', { class: 'tablewrap only-wide' }, h('table', { class: 't' }, h('thead', null, thead), tbody));
      const cards = wide ? null : h('div', { class: 'only-narrow' }, items.map((l) => h('div', { class: 'lcard', tabindex: '0', onclick: () => C.go('#/leads/' + l.id), onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) C.go('#/leads/' + l.id); } }, C.avatar(l.name),
        h('div', { class: 'grow' }, h('div', { class: 'row between' }, h('b', { class: 'trunc' }, l.name), cfgPill('statuses', l.status)), h('div', { class: 'small muted trunc' }, [l.phone, l.source, l.campaign, ownerLabel(l)].filter(Boolean).join(' - ')),
          l.product || l.dealValue != null ? h('div', { class: 'tiny muted trunc' }, [l.product, l.dealValue != null ? money(l.dealValue) : ''].filter(Boolean).join(' - ')) : null,
          l.lastContact ? h('div', { class: 'tiny faint' }, 'Last contact ' + rel(l.lastContact)) : null,
          l.nextFollow ? h('div', { class: 'tiny', style: C.ts(l.nextFollow) < Date.now() ? { color: 'var(--danger)' } : null }, 'Follow-up ' + fmtDT(l.nextFollow)) : null,
          h('div', { class: 'actions' }, !l.ownerId && can('leads.claim') ? btn('Claim', (e) => { e.stopPropagation(); claim(l.id, load); }, 'sm primary') : null, quickBtns(l))))));
      mount(listBox, table, cards, C.pager(S, lastTotal, (p) => { S.page = p; load(); }));
    }
    let loadCtl = null, loadSeq = 0, lastD = null;
    let wasWide = window.innerWidth >= 820; const onResize = () => { if (!ctx.alive()) return window.removeEventListener('resize', onResize); const w = window.innerWidth >= 820; if (w !== wasWide) { wasWide = w; if (lastD) draw(lastD); } }; window.addEventListener('resize', onResize);
    async function load() {
      renderBulk(); mount(listBox, loading());
      if (loadCtl) { try { loadCtl.abort(); } catch (e) { /* ignore */ } } loadCtl = window.AbortController ? new AbortController() : null; const my = ++loadSeq;
      try { const d = await api('/leads', { query: queryOf(), signal: loadCtl ? loadCtl.signal : undefined }); if (!ctx.alive() || my !== loadSeq) return; lastD = d; draw(d); } catch (e) { if (ctx.alive()) mount(listBox, errbox(e, load)); }
    }
    mount(root, head, filters, bulk, listBox); load();
  }

  /* ---------- CSV parsing (chunked, resumable state machine) ---------- */
  function createCsvParser() {
    let field = '', row = [], inQ = false, pendingQuote = false; const rows = [];
    return {
      rows,
      push(chunk, final) {
        for (let i = 0; i < chunk.length; i++) {
          const ch = chunk[i];
          if (pendingQuote) { pendingQuote = false; if (ch === '"') { field += '"'; continue; } inQ = false; }
          if (inQ) { if (ch === '"') pendingQuote = true; else field += ch; continue; }
          if (ch === '"' && field === '') inQ = true;
          else if (ch === ',') { row.push(field); field = ''; }
          else if (ch === '\n') { row.push(field.replace(/\r$/, '')); field = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
          else field += ch;
        }
        if (final) { if (pendingQuote) { pendingQuote = false; inQ = false; } if (field !== '' || row.length) { row.push(field.replace(/\r$/, '')); if (row.length > 1 || row[0] !== '') rows.push(row); field = ''; row = []; } }
      }
    };
  }
  async function parseCsvFile(file, onProgress) {
    let text = await (file.text ? file.text() : new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsText(file); }));
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const p = createCsvParser(); const CH = 200000;
    for (let i = 0; i < text.length; i += CH) { p.push(text.slice(i, i + CH), i + CH >= text.length); onProgress && onProgress(Math.min(1, (i + CH) / text.length)); await new Promise((r) => setTimeout(r, 0)); }
    if (!text.length) p.push('', true);
    return p.rows;
  }
  C.parseCsv = (text) => { const p = createCsvParser(); p.push(text, true); return p.rows; };
  const TARGETS = [['name', 'Full name', /^(full ?name|name|lead|customer|contact)/], ['phone', 'Phone', /(phone|mobile|tel|msisdn|cell|number)/], ['whatsapp', 'WhatsApp', /whats/], ['email', 'Email', /e[\s-]?mail/], ['businessName', 'Company', /(company|business|organi[sz]ation|shop)/], ['location', 'Location', /(location|town|city|area|county)/], ['country', 'Country', /^country$/],
    ['source', 'Source', /^source/], ['campaign', 'Campaign', /^campaign( name)?$/], ['adset', 'Ad set', /^ad ?(set|group)( name)?$/], ['ad', 'Ad', /^(ad( name)?|creative)$/], ['utm_source', 'UTM source', /utm ?source/], ['utm_medium', 'UTM medium', /utm ?medium/], ['utm_campaign', 'UTM campaign', /utm ?campaign/], ['utm_content', 'UTM content', /utm ?content/], ['utm_term', 'UTM term', /utm ?term/],
    ['product', 'Product(s)', /product/], ['status', 'Status', /status/], ['classification', 'Classification', /(class|temperature|priority)/], ['assignedTo', 'Assigned staff (email or name)', /(assign|owner|staff|agent|sales ?rep)/], ['estimatedValue', 'Estimated value', /(estimated|deal) ?value|^(value|amount)$/], ['expectedCloseDate', 'Expected close date', /expected ?clos/], ['notes', 'Notes', /(note|comment|remark)/], ['createdDate', 'Created date', /^(created( date| at)?|date( created)?|lead date)$/]];
  function suggestMapping(headers) {
    const map = {}; const used = new Set();
    const norm = (s) => String(s).toLowerCase().replace(/[_\-]+/g, ' ').trim();
    ['whatsapp', 'email', 'utm_source', 'utm_medium', 'utm_content', 'utm_term', 'utm_campaign', 'estimatedValue', 'expectedCloseDate', 'createdDate', 'adset', 'ad', 'campaign', 'source', 'status', 'classification', 'assignedTo', 'product', 'businessName', 'country', 'location', 'notes', 'phone', 'name'].forEach((key) => {
      const t = TARGETS.find((x) => x[0] === key);
      const hIdx = headers.findIndex((hd, i) => !used.has(i) && (norm(hd) === key.toLowerCase() || t[2].test(norm(hd))));
      if (hIdx >= 0) { map[key] = hIdx; used.add(hIdx); }
    });
    return map;
  }
  C.suggestMapping = suggestMapping;

  /* ---------- import wizard ---------- */
  async function importScreen(ctx) {
    if (!can('leads.import')) { mount(ctx.root, errbox({ message: 'You do not have permission to import leads.' })); return; }
    await meta(); const staff = await C.staffList(); const root = ctx.root;
    const W = { step: 1, file: null, rows: [], headers: [], map: {}, source: '', dup: 'skip', assign: 'none', assignUsers: [], importId: null, preview: null, result: null, fileName: '' };
    const stepsBar = () => h('div', { class: 'steps' }, ['Upload', 'Map columns', 'Options', 'Preview', 'Import'].map((s, i) => h('span', { class: 's' + (W.step === i + 1 ? ' on' : (W.step > i + 1 ? ' done' : '')) }, (i + 1) + '. ' + s)));
    const body = h('div');
    const draw = () => { mount(root, h('div', { class: 'pagehead' }, h('a', { class: 'btn ghost', href: '#/leads' }, ic('back'), 'Leads'), h('h1', null, 'Import leads')), stepsBar(), body); [step1, step2, step3, step4, step5][W.step - 1](); };
    const go = (n) => { W.step = n; draw(); };
    function step1() {
      const fileIn = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'CSV file' }); const bar = h('div', { class: 'progress hidden' }, h('i')); const msg = h('div', { class: 'small muted' });
      fileIn.addEventListener('change', async () => {
        const f = fileIn.files && fileIn.files[0]; if (!f) return; bar.classList.remove('hidden'); msg.textContent = 'Reading ' + f.name + '...';
        try {
          const rows = await parseCsvFile(f, (p) => { bar.firstChild.style.width = Math.round(p * 100) + '%'; });
          if (rows.length < 2) { msg.textContent = 'That file has no data rows.'; return; }
          W.headers = rows[0].map((x) => String(x).trim()); W.rows = rows.slice(1); W.fileName = f.name; W.map = suggestMapping(W.headers); msg.textContent = W.rows.length + ' rows found.'; go(2);
        } catch (e) { msg.textContent = 'Could not read that file: ' + errMsg(e); }
      });
      mount(body, h('div', { class: 'card' }, h('h2', null, 'Upload a CSV file'), h('p', { class: 'muted' }, 'The first row must be the column headings. Large files are read in pieces, so the page stays responsive.'), fileIn, bar, msg,
        h('div', { class: 'btnrow', style: { marginTop: '10px' } }, btn('Download template', () => C.download('/imports/template.csv', 'myduka-leads-template.csv').catch(fail), '', { 'aria-label': 'Download CSV template' }))), historyCard());
    }
    function historyCard() {
      const box = h('div', { class: 'card' }, h('h2', null, 'Import history'), loading());
      const asg = (i) => { const m = (i.assignment && i.assignment.mode) || 'none'; return { none: 'Unassigned', one: 'One person', csv: 'From the file', roundrobin: 'Round-robin', equal: 'Split equally' }[m] || m; };
      const n = (v) => String(v == null ? '' : v);
      api('/imports').then((d) => { const items = listOf(d, 'imports'); mount(box, h('h2', null, 'Import history'), items.length ? h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Import ID', 'File', 'Date', 'Uploaded by', 'Source', 'Assignment', 'Status', 'Total', 'Created', 'Updated', 'Skipped', 'Failed', 'Errors'].map((x) => h('th', null, x)))), h('tbody', null, items.map((i) => h('tr', null, h('td', { class: 'small' }, String(i.id || '').slice(0, 8)), h('td', null, pick(i, 'fileName', 'file_name') || ''), h('td', null, fmtDT(pick(i, 'createdAt', 'created_at'))), h('td', null, pick(i, 'uploadedBy', 'createdByName', 'userName', 'user_name') || ''), h('td', null, C.cfgFind('sources', i.source) ? cfgLabel('sources', i.source) : (i.source || '')), h('td', null, asg(i)), h('td', null, i.status || ''),
        h('td', null, n(pick(i, 'total', 'totalRows', 'total_rows'))), h('td', null, n(pick(i, 'created', 'imported', 'createdCount'))), h('td', null, n(i.updated)), h('td', null, n(i.skipped)),
        h('td', null, n(pick(i, 'failed', 'errors', 'errorCount', 'invalid') || 0)), h('td', null, Number(pick(i, 'failed', 'errors', 'errorCount', 'invalid') || 0) > 0 ? btn('Report', () => C.download('/imports/' + i.id + '/errors.csv', 'import-' + i.id + '-errors.csv').catch(fail), 'sm') : '-')))))) : empty('No imports yet.', 'upload')); }).catch((e) => mount(box, h('h2', null, 'Import history'), errbox(e)));
      return box;
    }
    function step2() {
      const selects = TARGETS.map(([key, label]) => { const s = sel([{ v: '', l: '(not imported)' }].concat(W.headers.map((hd, i) => ({ v: String(i), l: hd || 'Column ' + (i + 1) }))), W.map[key] != null ? String(W.map[key]) : '', { 'aria-label': 'Column for ' + label }); s.addEventListener('change', () => { if (s.value === '') delete W.map[key]; else W.map[key] = Number(s.value); }); return field(label + (key === 'name' ? ' *' : ''), s); });
      const sample = h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, W.headers.map((x) => h('th', null, x)))), h('tbody', null, W.rows.slice(0, 3).map((r) => h('tr', null, W.headers.map((_, i) => h('td', null, r[i] || '')))))));
      mount(body, h('div', { class: 'card' }, h('h2', null, 'Match your columns'), h('p', { class: 'muted' }, W.rows.length + ' rows in ' + W.fileName + '. We guessed the matches - check them.'), h('div', { class: 'grid2' }, selects), h('h3', null, 'First rows'), sample,
        h('div', { class: 'btnrow', style: { marginTop: '12px' } }, btn('Back', () => go(1)), btn('Continue', () => { if (W.map.name == null) { toast('Map the Full name column: every lead needs a name.', true); return; } if (W.map.phone == null && W.map.whatsapp == null && W.map.email == null) { toast('Map at least one of Phone, WhatsApp or Email.', true); return; } go(3); }, 'primary'))));
    }
    function step3() {
      const src = sel(cfgOptions('sources', true, 'Use the file’s source column / unknown', true), W.source);
      const dup = sel([{ v: 'skip', l: 'Skip duplicates (keep existing lead)' }, { v: 'update', l: 'Update existing lead with new details' }, { v: 'create', l: 'Create duplicates anyway' }], W.dup);
      const asg = sel([{ v: 'none', l: 'Leave unassigned (Available pool)' }, { v: 'one', l: 'Assign all to one person' }, { v: 'csv', l: 'Use the "Assigned to" column' }, { v: 'roundrobin', l: 'Round-robin between selected staff' }, { v: 'equal', l: 'Split equally between selected staff' }], W.assign);
      const users = staff.filter((u) => (u.status || 'active') === 'active'); const chosen = new Set(W.assignUsers.map(String));
      const usersBox = h('div', { class: 'btnrow' }, users.map((u) => { const c = h('button', { class: 'chip', type: 'button', 'aria-pressed': chosen.has(String(u.id)) ? 'true' : 'false', onclick: () => { const on = !chosen.has(String(u.id)); if (asg.value === 'one') chosen.clear(); on ? chosen.add(String(u.id)) : chosen.delete(String(u.id)); usersBox.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', x.dataset.id && chosen.has(x.dataset.id) ? 'true' : 'false')); } }, u.name); c.dataset.id = String(u.id); return c; }));
      const usersField = h('div', { class: 'field hidden' }, h('span', { class: 'lbl' }, 'Staff'), usersBox); const sync = () => usersField.classList.toggle('hidden', !['one', 'roundrobin', 'equal'].includes(asg.value)); asg.addEventListener('change', sync); sync();
      const errs = validateRows(); const errBox = errs.bad ? h('div', { class: 'notice' }, errs.bad + ' of ' + W.rows.length + ' rows look invalid (missing name or contact, bad phone or email). They will be reported and skipped. ', errs.samples.slice(0, 5).map((s) => h('div', { class: 'small' }, 'Row ' + s.row + ': ' + s.msg))) : h('div', { class: 'small muted' }, 'Quick check passed: every row has a name and a way to contact them.');
      mount(body, h('div', { class: 'card' }, h('h2', null, 'Import options'), errBox, h('div', { class: 'sep' }), field('Source for these leads', src), field('When a lead already exists', dup), field('Assignment', asg), usersField,
        h('div', { class: 'btnrow' }, btn('Back', () => go(2)), btn('Validate & preview', async (ev) => {
          W.source = src.value; W.dup = dup.value; W.assign = asg.value; W.assignUsers = [...chosen];
          if (['one', 'roundrobin', 'equal'].includes(W.assign) && !W.assignUsers.length) { toast('Choose at least one staff member.', true); return; }
          if (W.assign === 'csv' && W.map.assignedTo == null) { toast('Map the "Assigned to" column first.', true); return; }
          ev.currentTarget.disabled = true; await stage(ev.currentTarget);
        }, 'primary'))));
    }
    function validateRows() {
      let bad = 0; const samples = [];
      W.rows.forEach((r, i) => { const g = (k) => W.map[k] != null ? String(r[W.map[k]] || '').trim() : ''; let m = '';
        if (!g('name')) m = 'no name'; else if (!g('phone') && !g('whatsapp') && !g('email')) m = 'no phone, WhatsApp or email'; else if (g('email') && !/^\S+@\S+\.\S+$/.test(g('email'))) m = 'invalid email'; else if (g('phone') && C.waNumber(g('phone')).length < 9) m = 'phone too short';
        if (m) { bad++; if (samples.length < 50) samples.push({ row: i + 2, msg: m }); } });
      return { bad, samples };
    }
    async function stage(button) {
      const prog = h('div', { class: 'progress' }, h('i')); const label = h('div', { class: 'small muted' }, 'Creating import...');
      mount(body, h('div', { class: 'card' }, h('h2', null, 'Checking your file'), label, prog));
      try {
        const mapping = {}; Object.keys(W.map).forEach((k) => { mapping[k] = W.headers[W.map[k]]; });
        const created = await api('/imports', { body: { fileName: W.fileName, source: W.source || undefined, mapping, options: { duplicates: W.dup, assign: { mode: W.assign, userIds: W.assignUsers } } } });
        W.importId = created.id || (created.import && created.import.id);
        const BATCH = 500;
        for (let i = 0; i < W.rows.length; i += BATCH) {
          const rows = W.rows.slice(i, i + BATCH).map((r) => { const o = {}; W.headers.forEach((hd, j) => { o[hd] = r[j] == null ? '' : r[j]; }); return o; });
          await api('/imports/' + W.importId + '/rows', { body: { rows } });
          prog.firstChild.style.width = Math.round(Math.min(1, (i + BATCH) / W.rows.length) * 100) + '%'; label.textContent = 'Uploaded ' + Math.min(i + BATCH, W.rows.length) + ' of ' + W.rows.length + ' rows...';
        }
        W.preview = await api('/imports/' + W.importId + '/preview'); go(4);
      } catch (e) { fail(e); mount(body, errbox(e, () => go(3))); }
    }
    function step4() {
      const p = W.preview || {}; const c = p.counts || p; const n = (...k) => { const v = pick(c, ...k); return v == null ? 0 : v; };
      const kpi = (v, l, cls) => h('div', { class: 'kpi ' + (cls || '') }, h('div', { class: 'v' }, String(v)), h('div', { class: 'l' }, l));
      const total = n('total', 'totalRows', 'rows') || W.rows.length; const bad = n('invalid', 'errors', 'errorCount'); const dupes = n('duplicates', 'duplicate', 'existing');
      const willCreate = n('willCreate', 'new', 'toCreate', 'create', 'valid'); const sample = listOf(p.sample || p.rows || p.samples).slice(0, 8); const issues = listOf(p.issues).slice(0, 10); const un = p.assignment && p.assignment.unmatchedAssignees;
      const dupLabel = W.dup === 'update' ? 'Duplicates (will update)' : (W.dup === 'create' ? 'Duplicates (created anyway)' : 'Duplicates (skipped)');
      mount(body, h('div', { class: 'card' }, h('h2', null, 'Preview'), h('div', { class: 'kpis' }, kpi(total, 'Rows in file'), kpi(willCreate, 'New leads', 'accent'), kpi(dupes, dupLabel), kpi(bad, 'Invalid rows (skipped)')),
        (n('missingName') || n('missingContact') || n('invalidPhone') || n('invalidEmail')) ? h('div', { class: 'small muted', style: { marginTop: '8px' } }, ['Missing name: ' + n('missingName'), 'Missing phone/email: ' + n('missingContact'), 'Invalid phone: ' + n('invalidPhone'), 'Invalid email: ' + n('invalidEmail')].join(' · ')) : null,
        un ? h('div', { class: 'notice', style: { marginTop: '10px' } }, un + ' row(s) name someone in the "Assigned to" column who could not be matched - those leads stay unassigned.') : null,
        sample.length ? h('div', { class: 'tablewrap', style: { marginTop: '10px' } }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Row', 'Name', 'Phone', 'Result'].map((x) => h('th', null, x)))), h('tbody', null, sample.map((s) => h('tr', null, h('td', null, String(pick(s, 'rowNo', 'row', 'rowNumber', 'n') || '')), h('td', null, pick(s, 'name') || ''), h('td', null, pick(s, 'phone', 'whatsapp', 'email') || ''), h('td', null, String(pick(s, 'kind', 'result', 'status', 'error') || '').replace(/_/g, ' '))))))) : null,
        issues.length ? h('div', { style: { marginTop: '10px' } }, h('div', { class: 'lbl' }, 'Things to know'), issues.map((i) => h('div', { class: 'small' }, 'Row ' + pick(i, 'rowNo', 'row') + ': ' + (i.message || i.kind)))) : null,
        h('div', { class: 'btnrow', style: { marginTop: '12px' } }, btn('Back', () => go(3)), btn('Import ' + (willCreate + (W.dup === 'update' ? dupes : 0)) + ' leads', () => go(5), 'primary'))));
    }
    async function step5() {
      const prog = h('div', { class: 'progress' }, h('i')); const label = h('div', { class: 'small muted' }, 'Starting...');
      mount(body, h('div', { class: 'card' }, h('h2', null, 'Importing...'), label, prog));
      try {
        let done = false, guard = 0;
        while (!done && guard++ < 2000) {
          const r = await api('/imports/' + W.importId + '/commit', { body: {} }); done = !!r.done; const total = r.total || W.rows.length;
          prog.firstChild.style.width = Math.round(Math.min(1, (r.processed || 0) / total) * 100) + '%'; label.textContent = 'Processed ' + (r.processed || 0) + ' of ' + total;
        }
        const fin = await api('/imports/' + W.importId).catch(() => ({})); const s = fin.import || fin; const g = (...k) => { const v = pick(s, ...k); return v == null ? 0 : v; };
        const bad = Number(g('failed', 'errors', 'errorCount', 'invalid'));
        mount(body, h('div', { class: 'card' }, h('h2', null, 'Import complete'), h('div', { class: 'kpis' }, [[g('created', 'imported', 'createdCount'), 'Leads created', 'accent'], [g('updated', 'updatedCount'), 'Updated'], [g('skipped', 'duplicates', 'skippedCount'), 'Skipped duplicates'], [bad, 'Rows with errors']].map(([v, l, cl]) => h('div', { class: 'kpi ' + (cl || '') }, h('div', { class: 'v' }, String(v)), h('div', { class: 'l' }, l)))),
          h('div', { class: 'btnrow', style: { marginTop: '12px' } }, bad > 0 ? btn('Download error report', () => C.download('/imports/' + W.importId + '/errors.csv', 'import-errors.csv').catch(fail), 'danger') : null, h('a', { class: 'btn primary', href: '#/leads' }, 'View leads'), btn('Import another file', () => { W.step = 1; W.rows = []; draw(); }))));
      } catch (e) { fail(e); mount(body, errbox(e, () => step5()), h('p', { class: 'small muted' }, 'Nothing is lost - press Try again to continue from where it stopped.')); }
    }
    draw();
  }

  /* ---------- lead detail ---------- */
  async function leadDetail(ctx, id) {
    const root = ctx.root; await meta();
    async function load() {
      let d; try { d = await api('/leads/' + encodeURIComponent(id)); } catch (e) { if (ctx.alive()) mount(root, h('div', { class: 'pagehead' }, h('a', { class: 'btn ghost', href: '#/leads' }, ic('back'), 'Leads')), errbox(e, load)); return; }
      if (!ctx.alive()) return; draw(d);
    }
    function draw(d) {
      const lead = d.lead || d; const l = LD(lead); const prods = listOf(d.products, 'products'); const timeline = listOf(d.timeline); const fups = listOf(d.followups); const meets = listOf(d.meetings); const sales = listOf(d.sales); const owners = listOf(d.owners); const attrs = listOf(d.attributions);
      ctx.setTitle(l.name); const reload = () => load(); const me = C.state.me || {};
      const mine = l.ownerId && String(l.ownerId) === String(me.id); const canEdit = can('leads.edit') && (mine || can('leads.assign') || !l.ownerId || me.role === 'owner' || me.role === 'manager');
      const won = C.cfgFind('statuses', l.status) && C.cfgFind('statuses', l.status).isWon;
      const actions = h('div', { class: 'btnrow' },
        !l.ownerId && can('leads.claim') ? btn('Claim lead', () => claim(l.id, reload), 'primary') : null,
        l.phone || l.whatsapp ? h('a', { class: 'btn', href: C.telHref(l.phone || l.whatsapp) }, ic('phone'), 'Call') : null,
        l.phone || l.whatsapp ? h('a', { class: 'btn wa', href: C.waHref(l.whatsapp || l.phone), target: '_blank', rel: 'noopener' }, ic('wa'), 'WhatsApp') : null,
        l.email ? h('a', { class: 'btn', href: 'mailto:' + l.email }, ic('mail'), 'Email') : null,
        btn('Log contact', () => contactDialog(l.id, 'call', reload), ''),
        can('followups.manage') ? btn('Follow-up', () => followupDialog(l.id, null, reload)) : null, can('meetings.manage') ? btn('Meeting', () => meetingDialog(l.id, null, reload)) : null,
        can('leads.assign') ? btn('Assign', () => assignDialog([l.id], reload, l.ownerId)) : null, canEdit ? btn('Status', () => statusDialog(l.id, l.status, reload)) : null,
        canEdit && !won && can('sales.record') ? btn('Convert', () => convertDialog(lead, prods, reload), 'primary') : null,
        d.conversation ? h('a', { class: 'btn', href: '#/inbox/' + (d.conversation.id || d.conversation) }, ic('chat'), 'Open chat') : null);
      const clsSel = sel(cfgOptions('classifications', true, 'Not classified', true), l.cls || '', { 'aria-label': 'Classification', disabled: !canEdit });
      clsSel.addEventListener('change', async () => { try { await api('/leads/' + l.id + '/classification', { body: { value: clsSel.value || null } }); toast('Classification saved.'); reload(); } catch (e) { fail(e); } });
      const header = h('div', { class: 'card' }, h('div', { class: 'row' }, C.avatar(l.name, null, 'lg'), h('div', { class: 'grow' }, h('h1', { class: 'trunc' }, l.name), h('div', { class: 'row wrap', style: { marginTop: '4px' } }, cfgPill('statuses', l.status), l.cls ? cfgPill('classifications', l.cls) : null, h('span', { class: 'small muted' }, ownerLabel(l) ? 'Owner: ' + ownerLabel(l) : 'In the pool')), h('div', { class: 'small muted trunc', style: { marginTop: '2px' } }, [l.phone, l.whatsapp && l.whatsapp !== l.phone ? 'WhatsApp ' + l.whatsapp : '', C.cfgFind('sources', l.source) ? cfgLabel('sources', l.source) : l.source].filter(Boolean).join(' - '))),
        can('leads.edit') ? h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Edit lead', onclick: async () => { const f = await leadForm(Object.assign({}, l, { productIds: prods.map((p) => p.id) }), { edit: true }); openModal({ title: 'Edit lead', wide: true, body: f.node, actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => { const r = f.get(); if (r.errs.length) { toast(r.errs[0], true); return false; } const pids = r.body.productIds; delete r.body.productIds; await api('/leads/' + l.id, { method: 'PATCH', body: r.body }); if (pids) await api('/leads/' + l.id + '/products', { body: { productIds: pids } }); toast('Lead updated.'); reload(); } }] }); } }, ic('edit')) : null), h('div', { style: { marginTop: '12px' } }, actions));
      const details = h('div', { class: 'card' }, h('h2', null, 'Details'), h('dl', { class: 'kv' },
        [['Phone', l.phone], ['WhatsApp', l.whatsapp], ['Email', l.email], ['Company', l.company], ['Location', l.location], ['Country', l.country], ['Estimated value', l.estimatedValue != null ? money(l.estimatedValue) : ''], ['Actual value', l.actualValue != null ? money(l.actualValue) : ''], ['Revenue won', (l.revenue || sales.length) ? money(l.revenue || sales.reduce((a, s) => a + Number(pick(s, 'total') || 0), 0)) : ''],
          ['Expected close', l.expectedClose], ['Next action', l.nextAction], ['Next follow-up', l.nextFollow ? fmtDT(l.nextFollow) + (l.nextFollowType ? ' (' + l.nextFollowType + ')' : '') + (l.nextFollowNotes ? ' - ' + l.nextFollowNotes : '') : ''],
          ['Created', fmtDT(l.created)], ['Last contacted', l.lastContact ? fmtDT(l.lastContact) + (l.lastBy ? ' by ' + l.lastBy : '') : ''], ['Contact attempts', l.attempts ? String(l.attempts) : ''], ['Products', prods.map(pname).join(', ') || l.product]].filter((x) => x[1]).map(([k, v]) => [h('dt', null, k), h('dd', null, String(v))]),
        h('dt', null, 'Class'), h('dd', null, clsSel)));
      const attrCard = h('div', { class: 'card' }, h('h2', null, 'Attribution'), h('dl', { class: 'kv' }, [['Original source', C.cfgFind('sources', l.source) ? cfgLabel('sources', l.source) : l.source], ['Campaign', l.campaign], ['Ad set', l.adset], ['Ad', l.ad]].map(([k, v]) => [h('dt', null, k), h('dd', null, v || h('span', { class: 'faint' }, 'Not recorded'))])),
        attrs.length > 1 ? [h('div', { class: 'sep' }), h('div', { class: 'small muted' }, 'Every touch (' + attrs.length + ')'), attrs.map((a) => h('div', { class: 'small' }, fmtDT(pick(a, 'createdAt', 'created_at', 'at')) + ' - ' + [txt(pick(a, 'source')), txt(pick(a, 'campaign', 'campaignName')), txt(pick(a, 'ad', 'adName'))].filter(Boolean).join(' / ')))] : null);
      const chosen = new Set(prods.map((p) => String(p.id))); const pl = C.state.meta.products.filter((p) => p.active !== false || chosen.has(String(p.id)));
      const prodCard = h('div', { class: 'card' }, h('h2', null, 'Products'), pl.length ? h('div', { class: 'btnrow' }, pl.map((p) => { const c = h('button', { class: 'chip', type: 'button', disabled: !canEdit, 'aria-pressed': chosen.has(String(p.id)) ? 'true' : 'false', onclick: async () => { const on = !chosen.has(String(p.id)); on ? chosen.add(String(p.id)) : chosen.delete(String(p.id)); c.setAttribute('aria-pressed', on ? 'true' : 'false'); try { await api('/leads/' + l.id + '/products', { body: { productIds: [...chosen] } }); } catch (e) { fail(e); reload(); } } }, pname(p)); return c; })) : h('div', { class: 'muted' }, 'No products set up yet.'));
      const noteBox = h('textarea', { placeholder: 'Add a note...', 'aria-label': 'New note' }); const notes = timeline.filter((t) => (t.type || t.kind) === 'note');
      const noteCard = h('div', { class: 'card' }, h('h2', null, 'Notes'), noteBox, h('div', { class: 'btnrow', style: { margin: '8px 0' } }, btn('Save note', async (ev) => { if (!noteBox.value.trim()) return; ev.currentTarget.disabled = true; try { await api('/leads/' + l.id + '/note', { body: { text: noteBox.value.trim() } }); toast('Note added.'); reload(); } catch (e) { fail(e); ev.currentTarget.disabled = false; } }, 'primary')),
        notes.length ? notes.map((n) => h('div', { class: 'listrow' }, h('div', { class: 'grow' }, h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, pick(n, 'text', 'body', 'summary', 'message') || ''), h('div', { class: 'tiny faint' }, (pick(n, 'userName', 'user_name') || '') + ' - ' + fmtDT(pick(n, 'createdAt', 'created_at', 'at')))))) : h('div', { class: 'muted small' }, 'No notes yet.'));
      const fuCard = h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h2', null, 'Follow-ups'), can('followups.manage') ? btn('Add', () => followupDialog(l.id, null, reload), 'sm') : null), grouped(fups, (f) => f.status === 'done' || f.status === 'cancelled' || pick(f, 'completedAt', 'completed_at'), (f) => followupRow(f, reload)));
      const mtCard = h('div', { class: 'card' }, h('div', { class: 'row between' }, h('h2', null, 'Meetings'), can('meetings.manage') ? btn('Add', () => meetingDialog(l.id, null, reload), 'sm') : null), grouped(meets, (m) => ['completed', 'cancelled', 'no_show'].includes(m.status), (m) => meetingRow(m, reload)));
      const saleCard = h('div', { class: 'card' }, h('h2', null, 'Sales'), sales.length ? sales.map((s) => h('div', { class: 'listrow' }, h('div', { class: 'grow' }, h('b', null, money(pick(s, 'total', 'amount', 'revenue'))), h('div', { class: 'small muted' }, [txt(pick(s, 'productName', 'product_name', 'product_label', 'product')), 'x' + (s.quantity || 1), fmtDate(pick(s, 'soldAt', 'sold_at', 'createdAt', 'created_at'))].join(' - '))), C.pill(pick(s, 'paymentStatus', 'payment_status') || '-'))) : h('div', { class: 'muted small' }, 'No sales yet.'));
      const tlCard = h('div', { class: 'card' }, h('h2', null, 'Timeline'), timeline.length ? h('ul', { class: 'tl' }, timeline.map((t) => h('li', null, h('div', null, h('b', null, (t.type || t.kind || 'event').replace(/_/g, ' ')), ' ', pick(t, 'summary', 'text', 'description', 'message', 'body') || ''), h('div', { class: 'tiny faint' }, (pick(t, 'userName', 'user_name') || 'System') + ' - ' + fmtDT(pick(t, 'createdAt', 'created_at', 'at')))))) : h('div', { class: 'muted small' }, 'Nothing has happened yet.'),
        owners.length > 1 ? [h('div', { class: 'sep' }), h('div', { class: 'small muted' }, 'Ownership history'), owners.map((o) => h('div', { class: 'small' }, (pick(o, 'userName', 'user_name', 'name') || 'Unassigned') + ' - ' + fmtDate(pick(o, 'startedAt', 'started_at', 'createdAt', 'created_at', 'assignedAt'))))] : null);
      mount(root, h('div', { class: 'pagehead' }, h('a', { class: 'btn ghost', href: '#/leads' }, ic('back'), 'Leads')), h('div', { class: 'stack' }, header, h('div', { class: 'grid2', style: { gap: '12px' } }, h('div', { class: 'stack' }, details, prodCard, fuCard, mtCard, saleCard), h('div', { class: 'stack' }, noteCard, attrCard, tlCard))));
    }
    await load();
  }
  // upcoming (open) first, oldest due first; finished ones below under their own heading
  function grouped(list, isClosed, row) {
    if (!list.length) return h('div', { class: 'muted small' }, 'None scheduled.');
    const key = (x) => C.ts(pick(x, 'dueAt', 'due_at', 'startsAt', 'starts_at')) || 0;
    const open = list.filter((x) => !isClosed(x)).sort((a, b) => key(a) - key(b)), closed = list.filter(isClosed);
    return h('div', null, open.length ? [h('div', { class: 'tiny faint' }, 'Upcoming'), open.map(row)] : h('div', { class: 'muted small' }, 'Nothing upcoming.'), closed.length ? [h('div', { class: 'tiny faint', style: { marginTop: '8px' } }, 'Completed / closed'), closed.map(row)] : null);
  }
  function followupRow(f, reload) {
    const due = pick(f, 'dueAt', 'due_at'); const done = pick(f, 'completedAt', 'completed_at') || f.status === 'completed' || f.status === 'done'; const over = !done && C.ts(due) < Date.now();
    return h('div', { class: 'listrow' }, h('div', { class: 'grow' }, h('div', { style: over ? { color: 'var(--danger)', fontWeight: 600 } : { fontWeight: 600 } }, fmtDT(due), ' - ', f.type || 'follow-up'), f.notes ? h('div', { class: 'small muted' }, f.notes) : null, pick(f, 'leadName', 'lead_name') ? h('div', { class: 'small' }, h('a', { href: '#/leads/' + pick(f, 'leadId', 'lead_id') }, pick(f, 'leadName', 'lead_name'))) : null),
      f.status === 'cancelled' ? C.pill('Cancelled') : done ? C.pill('Done') : [C.can('followups.manage') ? btn('Edit', () => followupDialog(pick(f, 'leadId', 'lead_id'), f, reload), 'sm') : null, btn('Done', async (ev) => { ev.currentTarget.disabled = true; try { await api('/followups/' + f.id + '/complete', { body: {} }); toast('Follow-up completed.'); reload(); } catch (e) { fail(e); ev.currentTarget.disabled = false; } }, 'sm primary')]);
  }
  function meetingRow(m, reload) {
    const setStatus = async (status) => { try { await api('/meetings/' + m.id + '/status', { body: { status } }); toast('Meeting marked ' + status.replace('_', ' ') + '.'); reload(); } catch (e) { fail(e); } };
    const st = m.status || 'scheduled'; const open = !['completed', 'cancelled', 'no_show'].includes(st);
    return h('div', { class: 'listrow' }, h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, fmtDT(pick(m, 'startsAt', 'starts_at')), ' - ', (m.type || 'meeting').replace('_', ' ')), h('div', { class: 'small muted' }, [pick(m, 'leadName', 'lead_name'), m.location, m.link].filter(Boolean).join(' - ')), m.notes ? h('div', { class: 'small muted' }, m.notes) : null),
      C.pill(st.replace('_', ' ')), open && C.can('meetings.manage') ? h('span', { class: 'row wrap' }, btn('Reschedule', () => meetingDialog(pick(m, 'leadId', 'lead_id'), m, reload), 'sm'), btn('Done', () => setStatus('completed'), 'sm primary'), btn('No-show', () => setStatus('no_show'), 'sm'), btn('Cancel', () => setStatus('cancelled'), 'sm danger')) : null);
  }
  C.followupRow = followupRow; C.meetingRow = meetingRow;

  C.route('leads', leadsScreen, { label: 'Leads', icon: 'users' });
})();
