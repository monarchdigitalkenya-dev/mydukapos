// zip 263: a Daraja status query that says ResultCode 0 marks the payment paid even if the callback never came; the late callback then adds the receipt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshFromDaraja } from '../functions/api/mpesa-status.js';

const cfg = { mpesaEnv: 'sandbox', mpesaConsumerKey: 'k', mpesaConsumerSecret: 's', mpesaShortcode: '174379', mpesaPasskey: 'p' };
const withQuery = async (answer, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes('oauth') ? new Response(JSON.stringify({ access_token: 't' })) : new Response(JSON.stringify(answer));
  try { return await fn(); } finally { globalThis.fetch = real; }
};

test('ResultCode 0 from the status query is a paid sale (receipt pending)', async () => {
  const r = await withQuery({ ResponseCode: '0', ResultCode: '0', ResultDesc: 'The service request is processed successfully.' }, () => refreshFromDaraja({ status: 'pending', amount: 50 }, 'ws_CO_1', cfg));
  assert.equal(r.status, 'success'); assert.equal(r.receiptNumber, ''); assert.equal(r.receiptPending, true);
});
test('a non-zero ResultCode fails it; an error object keeps waiting', async () => {
  const f = await withQuery({ ResultCode: '1032', ResultDesc: 'Request cancelled by user' }, () => refreshFromDaraja({ status: 'pending' }, 'ws_CO_2', cfg));
  assert.equal(f.status, 'failed');
  const p = await withQuery({ errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' }, () => refreshFromDaraja({ status: 'pending' }, 'ws_CO_3', cfg));
  assert.equal(p, null);
});
