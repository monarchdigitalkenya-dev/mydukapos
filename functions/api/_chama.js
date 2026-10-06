// functions/api/_chama.js — Chama (zip 217). Puts the action tables together and answers one request: who is asking, may they, then do it.
// The parts: _chama-schema.js (tables), _chama-core.js (money, dates, the M-Pesa reader, cycles, sign-in), _chama-a.js / _chama-b.js (the actions).
import { A } from './_chama-a.js';
import './_chama-b.js';   // adds its actions to A
import './_chama-c.js';
import './_chama-d.js';   // zip 232: terms and conditions, the logo, late penalties on demand   // zip 230: chamas that are already running, the status card, cash confirmation helpers, the set-up wizard
import { ChamaError, ensureChamaSchema, memberFromToken, can } from './_chama-core.js';

export { ensureChamaSchema, ChamaError };
export { parseMpesa } from './_chama-core.js';
export const ACTIONS = A;
const OPEN_WHILE_PIN_CHANGE = new Set(['pin.change', 'logout', 'home', 'status']);

// -> the JSON body to send ({ ok: true, ... }); throws ChamaError for anything the person should be told
export async function handle(ctx, action, token) {
  const def = Object.prototype.hasOwnProperty.call(A, action) ? A[action] : null;
  if (!def) throw new ChamaError('Unknown action.', 'unknown_action', 400);
  if (def.p !== 'public') {
    const me = await memberFromToken(ctx, token);
    if (!me) throw new ChamaError('Please sign in.', 'signin_required', 401);
    ctx.me = me;
    if (me.mustChangePin && !OPEN_WHILE_PIN_CHANGE.has(action)) throw new ChamaError('Please choose your own PIN first.', 'must_change_pin', 403);
    if (def.p === '*' ? !can(me, '*') : (def.p !== 'member' && !can(me, def.p))) throw new ChamaError('You do not have permission to do that.', 'forbidden', 403);
  }
  return await def.fn(ctx);
}
