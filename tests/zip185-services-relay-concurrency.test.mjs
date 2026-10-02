import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, until } from './helpers.mjs';

// zip 185: the relay poll (every 4 s, not waiting for the previous one) used to start the SAME job again while its first copy was still being
// written to the printer (the server hands a job out again 20 s after it was claimed), and a second job that arrived meanwhile was written
// at the same time as the first. Two byte streams interleaved on one printer = doubled / overprinted / cut-off lines. Now each job id runs once,
// one job at a time, through the print queue.
test('services: relayed jobs are written to the printer one at a time and never twice', async () => {
  const acks = [];
  let polls = 0;
  const bytesJob = (id, ch) => ({ id, jobType: 'receipt', text: 'X', bytesB64: Buffer.from(new Uint8Array(500).fill(ch.charCodeAt(0))).toString('base64') });
  const fetchMock = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (String(url).includes('print-relay')) {
      if (body.action === 'poll') { polls++; return { ok: true, json: async () => ({ jobs: polls <= 3 ? [bytesJob('A', 'a')] : [bytesJob('A', 'a'), bytesJob('B', 'b')].filter((j) => !acks.includes(j.id)) }) }; }
      if (body.action === 'ack') { acks.push(body.jobId); return { ok: true, json: async () => ({ ok: true }) }; }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const { w, errors, close } = await boot('services/index.html', { fetch: fetchMock, wait: 800 });
  w.eval(`showToast = function () {}; window.__writes = []; window.__active = 0; window.__overlap = false;
    printerMode = 'bluetooth';
    btPrinterCharacteristic = { properties: { writeWithoutResponse: true }, writeValueWithoutResponse: async function (c) {
      window.__active++; if (window.__active > 1) window.__overlap = true;
      window.__writes.push(String.fromCharCode(c[0]));
      await new Promise(function (r) { setTimeout(r, 25); });
      window.__active--; } };`);
  // four polls while the first job is still going out (500 bytes = 3 chunks of 180 + 30 ms gaps)
  for (let i = 0; i < 4; i++) { w.eval('pollPrintRelayJobs()'); await new Promise((r) => setTimeout(r, 40)); }
  assert.ok(await until(() => acks.length >= 2, 8000), 'both jobs were acknowledged: ' + acks.join());
  assert.deepEqual(acks.slice().sort(), ['A', 'B'], 'each job acknowledged once');
  assert.equal(w.eval('window.__overlap'), false, 'two writes never ran at the same time');
  assert.equal(w.eval('window.__writes.join("")'), 'aaa' + 'bbb', 'job A went out completely (once), then job B');
  assert.deepEqual(errors, []);
  close();
});
