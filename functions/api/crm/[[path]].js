// functions/api/crm/[[path]].js — catch-all for /api/crm/* (Cloudflare Pages Functions). All the logic lives in functions/api/_crm/.
// (/api/crm-lead and /api/crm-meta-webhook are separate files and are not shadowed by this route.)
import { handle } from '../_crm/router.js';

export async function onRequest(context) { return handle(context); }
