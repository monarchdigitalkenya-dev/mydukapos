/* MyDuka CRM - inbox (3-pane), follow-ups, calendar. */
(function () {
  'use strict';
  const C = window.CRM; const { h, mount, ic, pick, listOf, api, toast, fail, openModal, field, sel, inp, loading, empty, errbox, btn, can, fmtDT, fmtTime, rel, money } = C;

  /* ---------- lead picker (used by calendar) ---------- */
  function leadPicker(onPick, title) {
    const q = inp('search', { placeholder: 'Search by name or phone...', 'aria-label': 'Search leads' }); const box = h('div', null, h('div', { class: 'muted small' }, 'Type to search leads.'));
    const run = C.debounce(async () => {
      if (q.value.trim().length < 2) return; mount(box, loading());
      try { const d = await api('/leads', { query: { q: q.value.trim(), pageSize: 8 } }); const items = listOf(d, 'leads').map(C.LD); mount(box, items.length ? items.map((l) => h('button', { class: 'conv', type: 'button', onclick: () => { m.close(); onPick(l); } }, C.avatar(l.name, null, 'sm'), h('div', { class: 'grow' }, h('div', { class: 'name trunc' }, l.name), h('div', { class: 'small muted' }, l.phone || l.email || '')))) : empty('No matching leads.', 'search')); } catch (e) { mount(box, errbox(e)); }
    }, 300);
    q.addEventListener('input', run); const m = openModal({ title: title || 'Choose a lead', body: h('div', null, q, h('div', { style: { marginTop: '8px' } }, box)), actions: [{ label: 'Cancel' }] }); return m;
  }
  C.leadPicker = leadPicker;

  /* ---------- inbox ---------- */
  const isNote = (m) => (m.type || m.kind) === 'note' || m.direction === 'note' || m.isNote || m.internal === true || m.direction === 'note';
  const isOut = (m) => m.direction === 'out' || m.direction === 'outbound' || m.fromMe === true || m.from_me === true;
  const lastText = (c) => { const v = pick(c, 'lastMessageText', 'lastMessage', 'last_message', 'last_message_text', 'preview', 'lastText'); return v && typeof v === 'object' ? (v.text || v.body || '') : (v || ''); };

  async function inboxScreen(ctx) {
    ctx.flush(true); const root = ctx.root; const activeId = ctx.parts[1] || null;
    const conv = { list: [], q: '', unread: false, mine: false }; let status = { apiConfigured: false }; let active = null; let infoOpen = false;
    let statusKnown = false;   // zip 161: the conversation list already says whether the WhatsApp API is connected, so /inbox/status is only asked when the list could not answer
    const listPane = h('section', { class: 'p-list', 'aria-label': 'Conversations' }), chatPane = h('section', { class: 'p-chat', 'aria-label': 'Conversation' }), infoPane = h('aside', { class: 'p-info', 'aria-label': 'Lead details' });
    const wrap = h('div', { class: 'inbox', 'data-view': activeId ? 'chat' : 'list' }, listPane, chatPane, infoPane); mount(root, wrap);
    const setView = (v) => wrap.setAttribute('data-view', v);

    /* list */
    const q = inp('search', { placeholder: 'Search chats', 'aria-label': 'Search conversations', value: '' });
    const unreadT = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', onclick: (e) => { conv.unread = !conv.unread; e.currentTarget.setAttribute('aria-pressed', String(conv.unread)); loadList(); } }, 'Unread');
    const mineT = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', onclick: (e) => { conv.mine = !conv.mine; e.currentTarget.setAttribute('aria-pressed', String(conv.mine)); loadList(); } }, 'Mine');
    const convs = h('div', { class: 'convs', role: 'listbox', 'aria-label': 'Conversation list' });
    mount(listPane, h('div', { class: 'p-head' }, q), h('div', { class: 'p-head row', style: { minHeight: '0', padding: '6px 12px' } }, unreadT, mineT), convs);
    q.addEventListener('input', C.debounce(() => { conv.q = q.value.trim(); loadList(); }, 250));
    let listSeq = 0;
    // zip 162: the list is paged (50 conversations, then "Load more"), using the API's limit + before cursor
    const INBOX_PAGE = 50; let nextCur = null, moreBusy = false;
    const moreBox = h('div', { class: 'loadmore', style: { textAlign: 'center', padding: '8px' } });
    const drawMore = () => mount(moreBox, nextCur ? btn(moreBusy ? 'Loading...' : 'Load more', loadMoreConvs, '', { disabled: moreBusy }) : null);
    const convRow = (c) => {
      const name = pick(c, 'name', 'contactName', 'contact_name', 'leadName', 'lead_name') || pick(c, 'phone', 'waId', 'wa_id') || 'Unknown'; const un = Number(pick(c, 'unread', 'unreadCount', 'unread_count') || 0); const st = pick(c, 'status', 'leadStatus', 'lead_status'); const staff = pick(c, 'staffName', 'staff_name', 'ownerName', 'owner_name');
      return h('button', { class: 'conv' + (un ? ' unread' : ''), type: 'button', role: 'option', 'aria-selected': String(c.id) === String(activeId) ? 'true' : 'false', onclick: () => C.go('#/inbox/' + c.id) }, C.avatar(name),
        h('div', { class: 'grow' }, h('div', { class: 'row between' }, h('span', { class: 'name trunc' }, name), h('span', { class: 'tiny ' + (un ? '' : 'faint'), style: un ? { color: 'var(--green-mid)', fontWeight: 700 } : null }, rel(pick(c, 'lastAt', 'last_at', 'lastMessageAt', 'last_message_at', 'updatedAt')))),
          h('div', { class: 'row between' }, h('span', { class: 'last trunc' }, lastText(c) || h('i', null, 'No messages yet')), un ? h('span', { class: 'badge', 'aria-label': un + ' unread' }, String(un)) : null),
          h('div', { class: 'row wrap', style: { marginTop: '2px' } }, st ? C.cfgPill('statuses', st) : null, staff ? h('span', { class: 'tiny faint' }, staff) : null)));
    };
    async function loadMoreConvs() {
      if (moreBusy || !nextCur) return; moreBusy = true; drawMore(); const my = listSeq;
      try {
        const d = await api('/inbox/conversations', { query: { q: conv.q, unread: conv.unread, mine: conv.mine, limit: INBOX_PAGE, before: nextCur } }); if (!ctx.alive() || my !== listSeq) return;
        const more = listOf(d, 'conversations'); nextCur = d.nextCursor || null; conv.list = conv.list.concat(more);
        more.forEach((c) => convs.insertBefore(convRow(c), moreBox));
      } catch (e) { fail(e); } finally { moreBusy = false; if (ctx.alive()) drawMore(); }
    }
    async function loadList() {
      mount(convs, loading()); const my = ++listSeq; moreBusy = false;
      try {
        const d = await api('/inbox/conversations', { query: { q: conv.q, unread: conv.unread, mine: conv.mine, limit: INBOX_PAGE } }); if (!ctx.alive() || my !== listSeq) return; if (d && d.apiConfigured != null) { status = { apiConfigured: !!d.apiConfigured }; statusKnown = true; } conv.list = listOf(d, 'conversations'); nextCur = d.nextCursor || null;
        drawMore();
        mount(convs, conv.list.length ? [conv.list.map(convRow), moreBox] : empty(conv.q || conv.unread || conv.mine ? 'No conversations match.' : 'No conversations yet. WhatsApp chats appear here when customers message you.', 'chat'));
      } catch (e) { if (ctx.alive()) mount(convs, errbox(e, loadList)); }
    }

    /* chat */
    let timer = null;
    async function openChat() {
      if (!activeId) { setView('list'); mount(chatPane, h('div', { class: 'empty', style: { margin: 'auto' } }, ic('chat'), h('div', null, 'Select a conversation'))); mount(infoPane, h('div', { class: 'infopanel muted' }, 'Lead details appear here.')); return; }
      mount(chatPane, loading()); setView(infoOpen ? 'info' : 'chat');
      const c = conv.list.find((x) => String(x.id) === String(activeId)) || { id: activeId };
      const name = () => pick(active, 'name', 'contactName', 'contact_name', 'leadName', 'lead_name') || pick(active, 'phone') || 'Conversation';
      let msgs = [], mode = 'reply', notConfigured = !status.apiConfigured;
      try {
        const d = await api('/inbox/conversations/' + activeId + '/messages'); msgs = listOf(d, 'messages'); active = Object.assign({}, c, d.conversation || {});
        api('/inbox/conversations/' + activeId + '/read', { body: {} }).then(() => C.pollNotifications()).catch(() => {});
      } catch (e) { mount(chatPane, h('div', { class: 'p-head' }, h('button', { class: 'iconbtn back', type: 'button', 'aria-label': 'Back to conversations', onclick: () => C.go('#/inbox') }, ic('back'))), h('div', { style: { padding: '16px' } }, errbox(e, () => openChat()))); return; }
      const leadId = pick(active, 'leadId', 'lead_id'); const phone = pick(active, 'phone', 'waId', 'wa_id');
      const scroller = h('div', { class: 'chatscroll', role: 'log', 'aria-label': 'Messages', tabindex: '0' });
      // zip 158: an attachment shows its typed label ("📷 Image", "🎤 Voice note", "📄 name.pdf"), the caption under it and, when the server can fetch it, an Open button
      const MEDIA_LABEL = { image: '📷 Image', video: '🎥 Video', voice: '🎤 Voice note', audio: '🎧 Audio', document: '📄 Document', sticker: '🙂 Sticker' };
      const openMedia = async (m, b) => {
        b.disabled = true;
        try { const blob = await api('/inbox/media/' + encodeURIComponent(m.id), { blob: true }); const url = URL.createObjectURL(blob); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60000); }
        catch (e) { toast(e && e.status === 409 ? 'The WhatsApp API is not connected on this server, so the file cannot be opened here.' : 'Could not open the file.', true); }
        b.disabled = false;
      };
      const mediaBody = (m) => {
        const label = m.media && m.media.label || (m.type && !isNote(m) ? MEDIA_LABEL[m.type] : null); if (!label) return null;
        const cap = pick(m, 'caption') || ''; const b = h('button', { class: 'btn small', type: 'button', 'data-media': m.id }, 'Open'); b.addEventListener('click', () => openMedia(m, b));
        return h('div', { class: 'media' }, h('div', { class: 'media-label', style: { fontWeight: 600 } }, label), cap ? h('div', { class: 'media-caption' }, cap) : null, m.media && m.media.available ? b : null);
      };
      function drawMsgs() {
        const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80; mount(scroller); let lastDay = '';
        if (!msgs.length) scroller.appendChild(h('div', { class: 'dayline' }, 'No messages yet'));
        msgs.forEach((m) => {
          const t = pick(m, 'at', 'createdAt', 'created_at', 'timestamp'); const day = C.ymd(C.ts(t)); if (day !== lastDay) { lastDay = day; scroller.appendChild(h('div', { class: 'dayline' }, day === C.ymd() ? 'Today' : C.fmtDate(t))); }
          const note = isNote(m), out = isOut(m); const body = mediaBody(m) || pick(m, 'text', 'body', 'content') || (pick(m, 'mediaType', 'media_type') ? '[' + pick(m, 'mediaType', 'media_type') + ']' : '');
          scroller.appendChild(h('div', { class: 'bubble' + (note ? ' note' : (out ? ' out' : '')) }, note ? h('span', { class: 'who' }, 'Internal note - ' + (pick(m, 'userName', 'user_name', 'sender_name', 'senderName') || 'team')) : (out && pick(m, 'userName', 'user_name', 'sender_name', 'senderName') ? h('span', { class: 'who' }, pick(m, 'userName', 'user_name', 'sender_name', 'senderName')) : null), body, h('span', { class: 'meta' }, fmtTime(t) + (out && m.status ? ' - ' + m.status : ''))));
        });
        if (nearBottom || msgs.length < 3) scroller.scrollTop = scroller.scrollHeight;
      }
      drawMsgs();
      const ta = h('textarea', { rows: '1', placeholder: 'Type a message', 'aria-label': 'Message' }); const send = h('button', { class: 'sendbtn', type: 'button', 'aria-label': 'Send' }, ic('send'));
      const modeBar = C.tabs([{ v: 'reply', l: 'Reply' }, { v: 'note', l: 'Internal note' }], mode, (v) => { mode = v; setup(); });
      const compHost = h('div');
      function setup() {
        modeBar.querySelectorAll('.tab').forEach((t, i) => t.setAttribute('aria-selected', String((i === 0 ? 'reply' : 'note') === mode)));
        const blocked = mode === 'reply' && (notConfigured || !can('inbox.reply')); ta.placeholder = mode === 'note' ? 'Write a note only your team sees' : 'Type a message'; ta.disabled = blocked; send.disabled = blocked;
        mount(compHost, blocked ? h('div', { class: 'notice', style: { margin: '8px' } }, can('inbox.reply') ? [h('b', null, 'Connect the WhatsApp API to reply here. '), 'Replies are sent through the WhatsApp Cloud API, which is not connected on this server yet, so nothing is sent from this box. ', phone ? h('a', { href: C.waHref(phone), target: '_blank', rel: 'noopener' }, 'Reply in the WhatsApp app instead') : null, h('div', { class: 'small muted' }, 'Ask the owner to set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID (Settings - Integrations).')] : 'You can read this conversation but not reply.') : null, h('div', { class: 'composer' }, ta, send));
      }
      const doSend = async () => {
        const text = ta.value.trim(); if (!text) return; send.disabled = true;
        try {
          if (mode === 'note') await api('/inbox/conversations/' + activeId + '/note', { body: { text } }); else await api('/inbox/conversations/' + activeId + '/messages', { body: { text } });
          ta.value = ''; await refresh();
        } catch (e) { if (e.code === 'whatsapp_not_configured') { notConfigured = true; toast('WhatsApp API is not connected - message was not sent.', true); } else fail(e); }
        setup();
      };
      send.addEventListener('click', doSend); ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
      // zip 161: the 15 s poll only redraws the thread when something changed (a new / edited message); an unchanged thread is left alone (no DOM rebuild, no scroll jump)
      const sigOf = (l) => l.length + ':' + (l.length ? (l[l.length - 1].id || '') + (pick(l[l.length - 1], 'status', 'deliveryStatus') || '') : '');
      let lastSig = sigOf(msgs);
      async function refresh() { const d = await api('/inbox/conversations/' + activeId + '/messages', { bg: true }); const next = listOf(d, 'messages'); const sg = sigOf(next); if (sg === lastSig) return; lastSig = sg; msgs = next; drawMsgs(); }
      const head = h('div', { class: 'p-head' }, h('button', { class: 'iconbtn back', type: 'button', 'aria-label': 'Back to conversations', onclick: () => C.go('#/inbox') }, ic('back')), C.avatar(name(), null, 'sm'), h('div', { class: 'grow' }, h('div', { class: 'trunc', style: { fontWeight: 700 } }, name()), h('div', { class: 'tiny faint' }, phone || '')),
        phone ? h('a', { class: 'iconbtn', href: C.telHref(phone), 'aria-label': 'Call' }, ic('phone')) : null, phone ? h('a', { class: 'iconbtn', href: C.waHref(phone), target: '_blank', rel: 'noopener', 'aria-label': 'Open in WhatsApp' }, ic('wa')) : null,
        h('button', { class: 'iconbtn infobtn', type: 'button', 'aria-label': 'Lead details', onclick: () => { infoOpen = !infoOpen; setView(infoOpen ? 'info' : 'chat'); } }, ic('user')));
      mount(chatPane, head, notConfigured ? h('div', { class: 'tiny', style: { padding: '4px 12px', background: 'var(--bubble-note)' } }, 'WhatsApp API not connected - showing received messages only.') : null, scroller, h('div', { style: { padding: '4px 8px 0', background: 'var(--surface-2)' } }, modeBar), compHost); setup();
      clearInterval(timer); timer = setInterval(() => { if (!ctx.alive()) return clearInterval(timer); if (!document.hidden) refresh().catch(() => {}); }, 15000); C.timers.push(timer);
      drawInfo(leadId);
    }
    async function drawInfo(leadId) {
      const back = h('div', { class: 'p-head' }, h('button', { class: 'iconbtn infobtn', type: 'button', 'aria-label': 'Back to chat', onclick: () => { infoOpen = false; setView('chat'); } }, ic('back')), h('b', null, 'Lead details'));
      if (!leadId) { mount(infoPane, back, h('div', { class: 'infopanel' }, empty('This chat is not linked to a lead.', 'link', can('leads.edit') || can('leads.create') ? btn('Link to a lead', () => leadPicker(async (l) => { try { await api('/inbox/conversations/' + activeId + '/link', { body: { leadId: l.id } }); toast('Linked.'); C.go(location.hash); } catch (e) { fail(e); } }), 'primary') : null))); return; }
      mount(infoPane, back, h('div', { class: 'infopanel' }, loading()));
      try {
        const d = await api('/leads/' + leadId); const lead = d.lead || d; const l = C.LD(lead); const prods = listOf(d.products, 'products'); const fu = listOf(d.followups).filter((f) => !pick(f, 'completedAt', 'completed_at') && f.status !== 'completed' && f.status !== 'done').sort((a, b) => C.ts(pick(a, 'dueAt', 'due_at')) - C.ts(pick(b, 'dueAt', 'due_at')))[0]; const mt = listOf(d.meetings).filter((m) => !['completed', 'cancelled', 'no_show'].includes(m.status || 'scheduled'))[0]; const notes = listOf(d.timeline).filter((t) => (t.type || t.kind) === 'note').slice(0, 3);
        const st = sel(C.statusPick(false, '', l.status), l.status, { 'aria-label': 'Status', disabled: !can('leads.edit') }); st.addEventListener('change', () => { const i = C.cfgFind('statuses', st.value); if (i && i.isLost) { C.dialogs.statusDialog(l.id, st.value, () => drawInfo(leadId)); } else api('/leads/' + l.id + '/status', { body: { status: st.value } }).then(() => toast('Status updated.')).catch((e) => { fail(e); drawInfo(leadId); }); });
        const cl = sel(C.cfgOptions('classifications', true, 'Not classified', true), l.cls || '', { 'aria-label': 'Classification', disabled: !can('leads.edit') }); cl.addEventListener('change', () => api('/leads/' + l.id + '/classification', { body: { value: cl.value || null } }).then(() => toast('Saved.')).catch(fail));
        mount(infoPane, back, h('div', { class: 'infopanel' }, h('div', { class: 'row' }, C.avatar(l.name), h('div', { class: 'grow' }, h('a', { href: '#/leads/' + l.id, style: { fontWeight: 700 } }, l.name), h('div', { class: 'small muted' }, l.phone || ''))), h('div', { class: 'sep' }), field('Status', st), field('Classification', cl),
          h('dl', { class: 'kv' }, [['Staff', C.txt(l.ownerName) || (l.ownerId ? C.staffName(l.ownerId) : 'Unassigned')], ['Product', prods.map(C.pname).join(', ') || l.product], ['Campaign', l.campaign], ['Ad', l.ad], ['Source', l.source], ['Revenue', l.revenue ? money(l.revenue) : ''], ['Next follow-up', fu ? fmtDT(pick(fu, 'dueAt', 'due_at')) : ''], ['Next meeting', mt ? fmtDT(pick(mt, 'startsAt', 'starts_at')) : '']].filter((x) => x[1]).map(([k, v]) => [h('dt', null, k), h('dd', null, String(v))])),
          h('div', { class: 'btnrow', style: { margin: '10px 0' } }, can('followups.manage') ? btn('Follow-up', () => C.dialogs.followupDialog(l.id, null, () => drawInfo(leadId)), 'sm') : null, can('meetings.manage') ? btn('Meeting', () => C.dialogs.meetingDialog(l.id, null, () => drawInfo(leadId)), 'sm') : null, h('a', { class: 'btn sm', href: '#/leads/' + l.id }, 'Full lead')),
          h('div', { class: 'lbl' }, 'Recent notes'), notes.length ? notes.map((n) => h('div', { class: 'small', style: { padding: '4px 0' } }, pick(n, 'text', 'body', 'summary') || '')) : h('div', { class: 'small faint' }, 'No notes.')));
      } catch (e) { mount(infoPane, back, h('div', { class: 'infopanel' }, errbox(e, () => drawInfo(leadId)))); }
    }
    await loadList(); if (!statusKnown) { try { status = await api('/inbox/status'); } catch (e) { status = { apiConfigured: false, error: e }; } }
    await openChat();
  }

  /* ---------- follow-ups ---------- */
  const FU = { bucket: 'today', staff: '' };
  async function followupsScreen(ctx) {
    const root = ctx.root; const staff = can('staff.view') ? await C.staffList() : [];
    const box = h('div', null, loading());
    const head = h('div', { class: 'pagehead' }, h('h1', null, 'Follow-ups'), staff.length > 1 && can('reports.team') ? sel(C.staffOptions(staff, true, 'Just mine'), FU.staff, { 'aria-label': 'Staff', onchange: (e) => { FU.staff = e.target.value; load(); } }) : null);
    const bar = h('div', { style: { marginBottom: '10px' } }); const drawTabs = () => mount(bar, C.tabs([{ v: 'today', l: 'Today' }, { v: 'overdue', l: 'Overdue' }, { v: 'upcoming', l: 'Upcoming' }, { v: 'completed', l: 'Completed' }], FU.bucket, (v) => { FU.bucket = v; drawTabs(); load(); }));
    async function load() {
      mount(box, loading());
      try { const d = await api('/followups', { query: { bucket: FU.bucket, staff: FU.staff } }); if (!ctx.alive()) return; const items = listOf(d, 'followups'); mount(box, items.length ? h('div', { class: 'card' }, items.map((f) => C.followupRow(f, load))) : empty(({ today: 'Nothing due today - nice.', overdue: 'Nothing overdue.', upcoming: 'No upcoming follow-ups.', completed: 'No completed follow-ups yet.' })[FU.bucket], 'clock')); }
      catch (e) { if (ctx.alive()) mount(box, errbox(e, load)); }
    }
    drawTabs(); mount(root, head, bar, box); load();
  }

  /* ---------- calendar ---------- */
  const CAL = { view: 'month', anchor: null, staff: '' };
  async function calendarScreen(ctx) {
    const root = ctx.root; if (!CAL.anchor) CAL.anchor = C.ymd(); const staff = can('staff.view') && can('reports.team') ? await C.staffList() : [];
    const box = h('div', null, loading()); const dayList = h('div', { class: 'card', style: { marginTop: '12px' } });
    function range() {
      const [y, m] = CAL.anchor.split('-').map(Number);
      if (CAL.view === 'week') { const dow = new Date(C.dayStartMs(CAL.anchor) + C.NBO).getUTCDay(); const from = C.addDays(CAL.anchor, -((dow + 6) % 7)); return { from, to: C.addDays(from, 6) }; }
      const first = y + '-' + String(m).padStart(2, '0') + '-01'; const dow = new Date(C.dayStartMs(first) + C.NBO).getUTCDay(); const from = C.addDays(first, -((dow + 6) % 7)); return { from, to: C.addDays(from, 41) };
    }
    const step = (n) => { if (CAL.view === 'week') CAL.anchor = C.addDays(CAL.anchor, 7 * n); else { const [y, m] = CAL.anchor.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); CAL.anchor = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-01'; } load(); };
    let items = []; let selDay = C.ymd();
    function drawDay() {
      const dm = items.filter((m) => C.ymd(C.ts(pick(m, 'startsAt', 'starts_at'))) === selDay).sort((a, b) => C.ts(pick(a, 'startsAt', 'starts_at')) - C.ts(pick(b, 'startsAt', 'starts_at')));
      mount(dayList, h('div', { class: 'row between' }, h('h2', null, (selDay === C.ymd() ? 'Today' : C.fmtDate(C.dayStartMs(selDay))) + ' - ' + dm.length + ' meeting' + (dm.length === 1 ? '' : 's')), can('meetings.manage') ? btn('Schedule', () => leadPicker((l) => C.dialogs.meetingDialog(l.id, null, load), 'Meeting with which lead?'), 'sm primary') : null), dm.length ? dm.map((m) => C.meetingRow(m, load)) : h('div', { class: 'muted small' }, 'No meetings this day.'));
    }
    function draw() {
      const r = range(); const cells = []; const days = CAL.view === 'week' ? 7 : 42; const curMonth = CAL.anchor.slice(0, 7);
      for (let i = 0; i < days; i++) {
        const d = C.addDays(r.from, i); const ms = items.filter((m) => C.ymd(C.ts(pick(m, 'startsAt', 'starts_at'))) === d);
        cells.push(h('div', { class: 'cell' + (d === C.ymd() ? ' today' : '') + (CAL.view === 'month' && d.slice(0, 7) !== curMonth ? ' other' : ''), tabindex: '0', role: 'button', 'aria-label': C.fmtDate(C.dayStartMs(d)) + ', ' + ms.length + ' meetings', onclick: () => { selDay = d; drawDay(); }, onkeydown: (e) => { if (e.key === 'Enter') { selDay = d; drawDay(); } } }, h('span', { class: 'n' }, String(Number(d.slice(8)))), ms.slice(0, CAL.view === 'week' ? 8 : 2).map((m) => h('span', { class: 'ev' }, C.fmtTime(pick(m, 'startsAt', 'starts_at')) + ' ' + (pick(m, 'leadName', 'lead_name') || m.type || ''))), ms.length > 2 && CAL.view === 'month' ? h('span', { class: 'tiny faint' }, '+' + (ms.length - 2)) : null));
      }
      const title = CAL.view === 'week' ? C.fmtDate(C.dayStartMs(r.from)) + ' - ' + C.fmtDate(C.dayStartMs(r.to)) : (['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(CAL.anchor.slice(5, 7)) - 1] + ' ' + CAL.anchor.slice(0, 4));
      mount(box, h('div', { class: 'row between', style: { marginBottom: '8px' } }, h('span', { class: 'row' }, h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Previous', onclick: () => step(-1) }, ic('back')), h('b', null, title), h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Next', onclick: () => step(1), style: { transform: 'scaleX(-1)' } }, ic('back'))), btn('Today', () => { CAL.anchor = C.ymd(); selDay = C.ymd(); load(); }, 'sm')),
        h('div', { class: 'cal' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => h('div', { class: 'dh' }, x)), cells)); drawDay();
    }
    async function load() {
      const r = range(); mount(box, loading());
      try { const d = await api('/meetings', { query: { from: r.from, to: r.to, staff: CAL.staff } }); if (!ctx.alive()) return; items = listOf(d, 'meetings'); draw(); } catch (e) { if (ctx.alive()) mount(box, errbox(e, load)); }
    }
    mount(root, h('div', { class: 'pagehead' }, h('h1', null, 'Calendar'), C.tabs([{ v: 'month', l: 'Month' }, { v: 'week', l: 'Week' }], CAL.view, (v) => { CAL.view = v; C.go(location.hash); }), staff.length > 1 ? sel(C.staffOptions(staff, true, 'Just mine'), CAL.staff, { 'aria-label': 'Staff', onchange: (e) => { CAL.staff = e.target.value; load(); } }) : null), box, dayList); load();
  }

  C.route('inbox', inboxScreen, { label: 'Inbox', icon: 'chat' });
  C.route('followups', followupsScreen, { label: 'Follow-ups', icon: 'clock' });
  C.route('calendar', calendarScreen, { label: 'Calendar', icon: 'cal' });
})();
