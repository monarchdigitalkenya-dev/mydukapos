// functions/api/_crm/router.js — the CRM API router (NOT a route; functions/api/crm/[[path]].js hands every /api/crm/* request to handle()).
// Every route except the four public auth ones needs a valid token, and each handler checks its permission from D1 for that request.
import { HttpError, E, json, errorResponse, readJson, first, countedDb } from './core.js';
import { configureCache } from './cache.js';
import { ledgerDb } from '../_ledger.js';
import { ensureCrmSchema } from './schema.js';
import { authenticate, requireOwnerOnly, login, inviteInfo, inviteAccept, resetAccept, passwordChange, meUser } from './auth.js';
import { corsHeadersFor } from '../_cors.js';
import * as cfg from './config.js';
import * as leads from './leads.js';
import * as fu from './followups.js';
import * as sales from './sales.js';
import * as staff from './staff.js';
import * as camp from './campaigns.js';
import * as rep from './reports.js';
import * as inbox from './inbox.js';
import * as imp from './imports.js';
import * as misc from './misc.js';
import * as meta from './meta.js';
import * as legacy from './legacy.js';
import * as auto from './automation.js';

const R = [];
const route = (method, pattern, handler, o = {}) => R.push({ method, segs: pattern.split('/').filter(Boolean), handler, ...o });
const pub = { public: true };

route('POST', '/auth/login', login, pub);
route('GET', '/auth/invite', inviteInfo, pub);
route('POST', '/auth/invite/accept', inviteAccept, pub);
route('POST', '/auth/reset/accept', resetAccept, pub);
route('POST', '/auth/password/change', passwordChange);
route('GET', '/me', async (ctx) => { await fu.sweepReminders(ctx.db, ctx.actor.meta); return { user: meUser(ctx.actor), config: await cfg.getConfig(ctx.db, { all: false }), integrations: cfg.integrationStatus(ctx.env) }; });

route('GET', '/boot', misc.boot);
route('GET', '/staff', staff.listStaff);
route('POST', '/staff', staff.createStaff);
route('GET', '/staff/:id', staff.getStaff);
route('PATCH', '/staff/:id', staff.patchStaff);
route('POST', '/staff/:id/status', staff.setStatus);
route('POST', '/staff/:id/reset-link', staff.resetLink);
route('POST', '/staff/:id/reassign', staff.reassign);
route('POST', '/staff/:id/remove', staff.removeStaff);
route('GET', '/staff/:id/activity', staff.staffActivity);
route('GET', '/permissions', staff.permissionsCatalogue);
route('PUT', '/staff/:id/permissions', staff.putPermissions);
route('POST', '/staff/:id/role', staff.putRole);

route('GET', '/config', cfg.configRoute);
route('PUT', '/config/:kind', cfg.putConfig);
route('GET', '/products', cfg.listProductsRoute);
route('POST', '/products', cfg.createProduct);
route('PATCH', '/products/:id', cfg.patchProduct);
route('GET', '/settings', cfg.getSettings);
route('PUT', '/settings', cfg.putSettings);

route('GET', '/leads', leads.listLeads);
route('POST', '/leads', leads.createLeadRoute);
route('POST', '/leads/check-duplicates', leads.checkDuplicatesRoute);
route('POST', '/leads/bulk', leads.bulkRoute);
route('GET', '/leads/export.csv', leads.exportLeads);
route('GET', '/leads/:id', leads.getLead);
route('PATCH', '/leads/:id', leads.patchLead);
route('DELETE', '/leads/:id', leads.deleteLead);
route('POST', '/leads/:id/claim', leads.claimLead);
route('POST', '/leads/:id/assign', leads.assignRoute);
route('POST', '/leads/:id/status', leads.statusRoute);
route('POST', '/leads/:id/classification', leads.classificationRoute);
route('POST', '/leads/:id/note', leads.noteRoute);
route('POST', '/leads/:id/contact', leads.contactRoute);
route('POST', '/leads/:id/products', leads.productsRoute);
route('POST', '/leads/:id/convert', sales.convertLead);
route('POST', '/leads/:id/merge', leads.mergeRoute);
route('POST', '/leads/:id/followups', fu.createFollowup);
route('POST', '/leads/:id/meetings', fu.createMeeting);

route('GET', '/followups', fu.listFollowups);
route('PATCH', '/followups/:id', fu.patchFollowup);
route('POST', '/followups/:id/complete', fu.completeFollowup);
route('GET', '/meetings', fu.listMeetings);
route('PATCH', '/meetings/:id', fu.patchMeeting);
route('POST', '/meetings/:id/status', fu.meetingStatus);

route('GET', '/campaigns', camp.listCampaigns);
route('POST', '/campaigns', camp.createCampaign);
route('GET', '/campaigns/:id', camp.getCampaign);
route('PATCH', '/campaigns/:id', camp.patchCampaign);
route('POST', '/campaigns/:id/adsets', camp.createAdset);
route('POST', '/adsets/:id/ads', camp.createAd);
route('PATCH', '/adsets/:id', camp.patchAdset);
route('PATCH', '/ads/:id', camp.patchAd);
route('POST', '/campaigns/:id/spend', camp.addSpend);

route('GET', '/sales', sales.listSales);
route('GET', '/sales/:id', sales.getSale);
route('PATCH', '/sales/:id', sales.patchSale);

route('GET', '/dashboard', rep.dashboard);
route('GET', '/reports/staff', rep.reportStaff);
route('GET', '/reports/sources', rep.reportSources);
route('GET', '/reports/campaigns', rep.reportCampaigns);
route('GET', '/reports/products', rep.reportProducts);
route('GET', '/reports/funnel', rep.reportFunnel);
route('GET', '/reports/response', rep.reportResponse);

route('GET', '/inbox/conversations', inbox.listConversations);
route('GET', '/inbox/conversations/:id/messages', inbox.conversationMessages);
route('POST', '/inbox/conversations/:id/messages', inbox.sendMessage);
route('POST', '/inbox/conversations/:id/note', inbox.addNote);
route('POST', '/inbox/conversations/:id/read', inbox.markRead);
route('POST', '/inbox/conversations/:id/link', inbox.linkConversation);
route('GET', '/inbox/status', inbox.inboxStatus);
route('GET', '/inbox/media/:id', inbox.inboxMedia);

route('POST', '/imports', imp.createImport);
route('GET', '/imports', imp.listImports);
route('GET', '/imports/template.csv', imp.templateCsv);
route('POST', '/imports/:id/rows', imp.stageRows);
route('GET', '/imports/:id/preview', imp.previewImport);
route('POST', '/imports/:id/commit', imp.commitImport);
route('GET', '/imports/:id/errors.csv', imp.errorsCsv);
route('GET', '/imports/:id', imp.getImport);

route('GET', '/notifications', misc.listNotifications);
route('POST', '/notifications/read', misc.markNotificationsRead);
route('GET', '/audit', misc.listAudit);
route('GET', '/events', misc.listEvents);
route('POST', '/events/ack', misc.ackEvents);
route('GET', '/automation', auto.automationOverview);
route('POST', '/integrations/meta/resolve', meta.resolveUnresolved);

route('POST', '/legacy/migrate', legacy.migrateRoute, { owner: true });
route('GET', '/legacy/verify', legacy.verifyRoute, { owner: true });

// most specific first: '/leads/export.csv' before '/leads/:id'
R.sort((a, b) => b.segs.filter((s) => !s.startsWith(':')).length - a.segs.filter((s) => !s.startsWith(':')).length);

function match(method, segs) {
  let pathExists = false;
  for (const r of R) {
    if (r.segs.length !== segs.length) continue;
    const params = {}; let ok = true;
    for (let i = 0; i < segs.length; i++) {
      if (r.segs[i].startsWith(':')) { try { params[r.segs[i].slice(1)] = decodeURIComponent(segs[i]); } catch (e) { ok = false; break; } }
      else if (r.segs[i] !== segs[i]) { ok = false; break; }
    }
    if (!ok) continue;
    pathExists = true;
    if (r.method === method) return { r, params };
  }
  return { pathExists };
}

// zip 161: Server-Timing on every CRM answer: what the request asked of D1 (round trips / statements / time inside D1 calls) and the Function's own time. The browser's
// Network panel shows it (F12, Timing tab), so a slow screen can be told apart: many trips = a query problem, one slow trip = an index problem, neither = the network.
const timing = (t0, c) => `d1;dur=${c ? c.ms : 0};desc="${c ? c.trips : 0} trips ${c ? c.stmts : 0} stmts", app;dur=${Date.now() - t0}`;
export async function handle(context) {
  const { request, env } = context;
  const t0 = Date.now();
  const cors = corsHeadersFor(request, env, { methods: 'GET, POST, PUT, PATCH, DELETE, OPTIONS', headers: 'Content-Type, Authorization' });
  let counted = null;
  const done = (res) => { for (const [k, v] of Object.entries(cors)) res.headers.set(k, v); if (request.method !== 'OPTIONS') res.headers.set('Server-Timing', timing(t0, counted && counted.counts)); return res; };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const raw = ledgerDb(env);
    if (!raw) throw new HttpError(503, 'crm_database_missing', 'The CRM database (D1 binding LEDGER_DB) is not connected to this deployment.');
    configureCache(env);
    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/api\/crm\/?/, '').split('/').filter(Boolean).map((s) => s.slice(0, 200));
    const m = match(request.method, parts);
    if (!m.r) throw m.pathExists ? new HttpError(405, 'method_not_allowed', 'Method not allowed') : E.notFound('No such CRM endpoint', 'not_found');
    counted = countedDb(raw);
    try { await ensureCrmSchema(counted, { fts: String(env.CRM_FTS == null ? '' : env.CRM_FTS) === '1' }); } catch (e) { console.error('crm schema', e && e.message); throw new HttpError(503, 'crm_database_unavailable', 'The CRM database is not reachable right now.'); }
    const db = counted;
    let body;
    const ctx = { env, db, request, url, query: url.searchParams, params: m.params, context, actor: null, json: () => (body || (body = readJson(request))) };
    if (!m.r.public) ctx.actor = m.r.owner ? await requireOwnerOnly(context, db) : await authenticate(context, db);
    if (!m.r.public) { try { await auto.runAutomation(db, ctx.actor.meta); } catch (e) { console.error('crm automation', e && e.message); } }      // zip 158: lazy rules, never fail the request (zip 161: no round trip unless they are due)
    const out = await m.r.handler(ctx);
    return done(out instanceof Response ? out : json(out));
  } catch (e) {
    if (!(e instanceof HttpError)) console.error('crm error', request.method, new URL(request.url).pathname, e && e.stack || e);   // zip 185: path only - the query string can carry an invitation / reset token
    return done(errorResponse(e));
  }
}
