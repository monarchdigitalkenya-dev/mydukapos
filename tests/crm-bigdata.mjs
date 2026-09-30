// zip 161: a realistic CRM dataset for speed tests and tools/measure-crm-speed.mjs, plus a D1 wrapper that COUNTS round trips.
//   bigDataset(crm, opts)  -> fills the fake D1 of a makeCrm() with leads, activities, conversations, messages, follow-ups, meetings, campaigns ...
//   countingDb(db)         -> wraps a D1 (tests/d1-fake.mjs) and counts what the server sends to it:
//                             trips = round trips (every prepare().run/all/first/raw is one, every batch() is ONE however many statements it holds),
//                             stmts = statements executed, ms = time spent inside the database, log = one entry per trip.
// The numbers are operation counts and sandbox milliseconds (node:sqlite in memory), NOT Cloudflare latency.
import crypto from 'node:crypto';

export const SIZES = { leads: 5000, activities: 20000, conversations: 3000, messages: 30000, followups: 300, meetings: 50, staff: 10, campaigns: 8 };

export function countingDb(db) {
  const stats = { trips: 0, stmts: 0, ms: 0, log: [] };
  const wrap = (inner) => ({
    sql: inner.sql, args: inner.args, _inner: inner,
    bind(...a) { return wrap(inner.bind(...a)); },
    async run() { return timed(1, 1, inner.sql, () => inner.run()); },
    async all() { return timed(1, 1, inner.sql, () => inner.all()); },
    async first(c) { return timed(1, 1, inner.sql, () => inner.first(c)); },
    async raw() { return timed(1, 1, inner.sql, () => inner.raw()); },
  });
  async function timed(trips, stmts, sql, fn) {
    const t0 = performance.now();
    try { return await fn(); } finally { const ms = performance.now() - t0; stats.trips += trips; stats.stmts += stmts; stats.ms += ms; stats.log.push({ sql: String(sql).replace(/\s+/g, ' ').slice(0, 110), stmts, ms }); }
  }
  const w = {
    _db: db._db, _state: db._state, stats,
    prepare: (sql) => wrap(db.prepare(sql)),
    exec: (sql) => db.exec(sql),
    batch: (list) => timed(1, list.length, 'BATCH[' + list.length + '] ' + (list[0] && list[0].sql || ''), () => db.batch(list)),
    query: (sql, ...a) => db.query(sql, ...a),
    reset() { stats.trips = 0; stats.stmts = 0; stats.ms = 0; stats.log = []; },
  };
  return w;
}

const rnd = (seed) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
const FIRST = ['Wanjiru', 'Otieno', 'Achieng', 'Kamau', 'Mwangi', 'Njeri', 'Odhiambo', 'Wafula', 'Kiptoo', 'Chebet', 'Hassan', 'Fatuma', 'Mutiso', 'Nduta', 'Barasa', 'Atieno', 'Kibet', 'Naliaka', 'Omondi', 'Wambui'];
const LAST = ['Kariuki', 'Ochieng', 'Mutua', 'Njoroge', 'Kimani', 'Wekesa', 'Rotich', 'Juma', 'Karanja', 'Mbugua', 'Owino', 'Cheruiyot', 'Maina', 'Akinyi', 'Simiyu', 'Gathoni', 'Kilonzo', 'Mwenda', 'Onyango', 'Waweru'];
const BIZ = ['Duka', 'Pharmacy', 'Hotel', 'Salon', 'Hardware', 'Butchery', 'Agrovet', 'Clinic', 'Supermarket', 'Wines & Spirits'];
const TOWN = ['Nairobi', 'Mombasa', 'Kisumu', 'Nakuru', 'Eldoret', 'Thika', 'Machakos', 'Nyeri', 'Kitale', 'Meru'];
const STATUSES = ['new', 'new', 'new', 'assigned', 'contacting', 'contacted', 'awaiting_response', 'followup_required', 'qualified', 'potential', 'meeting', 'proposal', 'negotiation', 'won', 'lost', 'not_interested', 'invalid_number'];
const CLASSES = [null, null, 'hot', 'warm', 'cold', 'potential', 'dead'];
const SOURCES = ['website', 'whatsapp', 'meta_ads', 'facebook', 'instagram', 'referral', 'walk_in', 'phone', 'import', 'manual'];
const ATYPES = ['note', 'contact', 'status', 'call', 'whatsapp', 'assign'];

// Fills the CRM D1 directly with SQL (fast) — the rows look like the ones the API writes. Returns ids the tests need.
export function bigDataset(crm, o = {}) {
  const N = { ...SIZES, ...o };
  const raw = crm.db._db; const R = rnd(o.seed || 161); const pick = (a) => a[Math.floor(R() * a.length)];
  const t0 = Date.now(), DAY = 86400000;
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec('BEGIN');
  const ins = (sql) => raw.prepare(sql);
  const users = crm.q(`SELECT id FROM crm_users WHERE status = 'active' AND owner_ref IS NULL`).map((r) => r.id);
  const products = crm.q(`SELECT id FROM crm_products ORDER BY position`).map((r) => r.id);
  // campaigns / ad sets / ads / spend
  const camp = [], adset = [], ads = [];
  const iC = ins(`INSERT INTO crm_campaigns (id, name, platform, source_key, status, budget, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  const iS = ins(`INSERT INTO crm_adsets (id, campaign_id, name, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`);
  const iA = ins(`INSERT INTO crm_ads (id, adset_id, campaign_id, name, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`);
  const iSp = ins(`INSERT INTO crm_spend (id, campaign_id, adset_id, ad_id, scope_key, date, amount, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  for (let c = 0; c < N.campaigns; c++) {
    const cid = 'camp' + c; camp.push(cid); iC.run(cid, 'Campaign ' + c, 'meta', 'meta_ads', 'active', 50000, t0 - 200 * DAY, t0);
    for (let s = 0; s < 3; s++) {
      const sid = `${cid}s${s}`; adset.push({ id: sid, c: cid }); iS.run(sid, cid, `Ad set ${c}.${s}`, 'active', t0 - 200 * DAY, t0);
      for (let a = 0; a < 3; a++) { const aid = `${sid}a${a}`; ads.push({ id: aid, s: sid, c: cid }); iA.run(aid, sid, cid, `Ad ${c}.${s}.${a}`, 'active', t0 - 200 * DAY, t0); }
    }
    for (let d = 0; d < 90; d++) { const day = new Date(t0 - d * DAY + 3 * 3600000).toISOString().slice(0, 10); iSp.run(`sp${c}_${d}`, cid, null, null, 'c:' + cid, day, 500 + Math.floor(R() * 1500), t0, t0); }
  }
  // leads (+ product links, owner history, first attribution)
  const iL = ins(`INSERT INTO crm_leads (id, name, phone, phone_norm, whatsapp, whatsapp_norm, email, business_name, location, notes, status_key, class_key, source_key, owner_id, created_by, created_by_name, created_at, updated_at, assigned_at, first_contact_at, converted_at, lost_at, last_activity_at, last_contacted_at, contact_attempts, first_source_key, first_campaign_id, first_adset_id, first_ad_id, first_touch_at, estimated_value, legacy_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const iLP = ins(`INSERT INTO crm_lead_products (lead_id, product_id, added_at) VALUES (?,?,?)`);
  const iLO = ins(`INSERT INTO crm_lead_owners (id, lead_id, user_id, user_name, kind, started_at) VALUES (?,?,?,?,?,?)`);
  const iAt = ins(`INSERT INTO crm_attribution_events (id, lead_id, kind, source_key, campaign_id, adset_id, ad_id, at) VALUES (?,?,?,?,?,?,?,?)`);
  const leadIds = [], leadOwner = new Map(), leadStatus = new Map(), leadRows = [];
  for (let i = 0; i < N.leads; i++) {
    const id = 'L' + String(i).padStart(5, '0'), first = pick(FIRST), last = pick(LAST), name = `${first} ${last}`;
    const ph = '2547' + String(10000000 + Math.floor(R() * 89999999)), owner = R() < 0.18 ? null : pick(users), st = pick(STATUSES), src = pick(SOURCES);
    const created = t0 - Math.floor(R() * 180 * DAY), a = R() < 0.4 ? pick(ads) : null;
    const won = st === 'won', lost = ['lost', 'not_interested', 'invalid_number'].includes(st);
    const lastAct = created + Math.floor(R() * (t0 - created));
    iL.run(id, name, '+' + ph, ph, R() < 0.6 ? '+' + ph : null, R() < 0.6 ? ph : null, R() < 0.5 ? `${first}.${last}${i}@example.co.ke`.toLowerCase() : null, R() < 0.5 ? `${last} ${pick(BIZ)}` : null, pick(TOWN), R() < 0.3 ? 'Asked about pricing and a demo.' : null,
      st, pick(CLASSES), src, owner, owner || users[0], 'Seed', created, lastAct, owner ? created + 60000 : null, ['new', 'assigned'].includes(st) ? null : created + 3600000, won ? lastAct : null, lost ? lastAct : null, lastAct, ['new', 'assigned'].includes(st) ? null : lastAct, ['new', 'assigned'].includes(st) ? 0 : 1 + Math.floor(R() * 4), src, a && a.c, a && a.s, a && a.id, created, R() < 0.5 ? 10000 + Math.floor(R() * 90000) : null, null);
    leadIds.push(id); leadOwner.set(id, owner); leadStatus.set(id, st); leadRows.push({ id, created, owner, name });
    for (let k = 0; k < (R() < 0.7 ? 1 : 2); k++) { const p = products[(i + k) % products.length]; try { iLP.run(id, p, created); } catch (e) { /* same product twice */ } }
    if (owner) iLO.run('lo' + i, id, owner, 'Staff', 'assign', created + 60000);
    iAt.run('at' + i, id, 'create', src, a && a.c, a && a.s, a && a.id, created);
  }
  // activities / notes
  const iAc = ins(`INSERT INTO crm_activities (id, lead_id, user_id, user_name, type, summary, data, created_at) VALUES (?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < N.activities; i++) { const l = leadRows[Math.floor(R() * leadRows.length)]; iAc.run('ac' + i, l.id, pick(users), 'Staff', pick(ATYPES), 'Spoke with the client about the demo and the price, will call back after the weekend.', '{"x":1}', l.created + Math.floor(R() * (t0 - l.created))); }
  // follow-ups, meetings
  const iF = ins(`INSERT INTO crm_followups (id, lead_id, assigned_user_id, type, due_at, notes, remind_minutes, status, created_by, created_at, updated_at, reminded_at, overdue_notified_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < N.followups; i++) { const l = leadRows[i * 13 % leadRows.length]; const open = i % 4 !== 0; const due = t0 + Math.floor((R() - 0.4) * 5 * DAY); iF.run('fu' + i, l.id, l.owner || users[0], 'call', due, 'Call back', 15, open ? 'open' : 'done', users[0], t0 - DAY, t0 - DAY, open && due < t0 ? due - 1 : null, open && due < t0 ? due : null); }
  const iM = ins(`INSERT INTO crm_meetings (id, lead_id, user_id, starts_at, duration_min, type, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < N.meetings; i++) { const l = leadRows[i * 41 % leadRows.length]; iM.run('mt' + i, l.id, l.owner || users[0], t0 + Math.floor((R() - 0.3) * 20 * DAY), 30, 'call', 'scheduled', users[0], t0, t0); }
  // sales: every "won" lead
  const iSa = ins(`INSERT INTO crm_sales (id, lead_id, product_id, product_label, quantity, unit_price, discount, total, payment_status, amount_paid, closed_by, closed_by_name, source_key, campaign_id, adset_id, ad_id, sold_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let sn = 0; for (const l of leadRows) if (leadStatus.get(l.id) === 'won') { const p = pick(products); iSa.run('sa' + sn++, l.id, p, 'Product', 1, 15000, 0, 15000, 'paid', 15000, l.owner || users[0], 'Staff', 'website', null, null, null, l.created + DAY, l.created + DAY, l.created + DAY); }
  // conversations + messages
  const iCv = ins(`INSERT INTO crm_conversations (id, channel, wa_id, contact_name, lead_id, last_message_at, last_message_text, last_direction, unread_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const iMs = ins(`INSERT INTO crm_messages (id, conversation_id, direction, type, text, sender_user_id, sender_name, status, at) VALUES (?,?,?,?,?,?,?,?,?)`);
  const per = Math.floor(N.messages / N.conversations); let mn = 0; const convIds = [];
  for (let i = 0; i < N.conversations; i++) {
    const id = 'cv' + i, l = i < N.leads * 0.6 ? leadRows[i] : null, wa = '2547' + String(20000000 + i);
    const last = t0 - Math.floor(R() * 60 * DAY);
    iCv.run(id, 'whatsapp', wa, l ? l.name : 'Chat ' + i, l && l.id, last, 'Okay, I will send the money tomorrow', i % 2 ? 'in' : 'out', R() < 0.15 ? 1 + Math.floor(R() * 3) : 0, last - 7 * DAY); convIds.push(id);
    for (let k = 0; k < per; k++) iMs.run('m' + mn++, id, k % 2 ? 'out' : 'in', 'text', 'Message ' + k + ' about the shop system and the price per month', k % 2 ? users[0] : null, k % 2 ? 'Staff' : null, 'sent', last - (per - k) * 60000);
  }
  // notifications, audit, events
  const iN = ins(`INSERT INTO crm_notifications (id, user_id, kind, title, body, lead_id, dedupe_key, created_at, read_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 600; i++) iN.run('n' + i, users[i % users.length], 'lead_assigned', 'New lead assigned', 'A lead', leadRows[i].id, 'seed:' + i, t0 - i * 60000, i % 3 ? t0 : null);
  const iAu = ins(`INSERT INTO crm_audit (user_id, user_name, action, entity, entity_id, prev, next, at) VALUES (?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 20000; i++) iAu.run(users[i % users.length], 'Staff', 'lead_update', 'lead', leadRows[i % leadRows.length].id, '{"status":"new"}', '{"status":"contacted"}', t0 - i * 30000);
  const iEv = ins(`INSERT INTO crm_events (name, entity, entity_id, lead_id, actor_id, actor_name, data, at, processed_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 15000; i++) iEv.run(pick(['lead.created', 'lead.contacted', 'lead.claimed']), 'lead', leadRows[i % leadRows.length].id, leadRows[i % leadRows.length].id, users[0], 'Staff', '{}', t0 - i * 40000, t0);
  raw.exec('COMMIT');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('ANALYZE');
  return { leadIds, convIds, users, ms: Date.now() - t0, N };
}
export const uid = () => crypto.randomUUID();
