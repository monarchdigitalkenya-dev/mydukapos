import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';

// Automatic Daily Report printing (spec sections 27-30). Generation and
// print output are separate concerns (generation always happens and is
// logged; printing is best-effort and its failure never hides the fact
// that the report was generated), duplicate reports for the same
// business date are prevented, and the two missed-report behaviors
// ("only at scheduled time" vs "generate on return") behave differently.
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function session(app) {
  return boot(app, { storage: {}, wait: 900 });
}

for (const app of ['index.html', 'hotel/index.html', 'hospital/index.html', 'production/index.html', 'services/index.html', 'pharmacy/index.html']) {

test(`${app}: with auto-report off, the scheduler never runs anything`, async () => {
  const b = await session(app);
  const { w } = b;
  w.eval("autoDailyReportEnabled = false; checkAutoDailyReportSchedule();");
  assert.equal(w.eval('autoDailyReportLog.length'), 0);
  b.close();
});

test(`${app}: "generate on return" fires once the scheduled time has passed, even if it was missed`, async () => {
  const b = await session(app);
  const { w } = b;
  w.eval("autoDailyReportEnabled = true; autoDailyReportMissedBehavior = 'generate-on-return'; autoDailyReportTime = '00:00';");
  w.eval("checkAutoDailyReportSchedule()");
  const log = w.eval('autoDailyReportLog');
  assert.equal(log.length, 1);
  assert.equal(log[0].businessDate, todayKey());
  b.close();
});

test(`${app}: "only at scheduled time" does NOT fire once the window has passed`, async () => {
  const b = await session(app);
  const { w } = b;
  w.eval("autoDailyReportEnabled = true; autoDailyReportMissedBehavior = 'scheduled-only'; autoDailyReportTime = '00:00';");
  w.eval("checkAutoDailyReportSchedule()");
  assert.equal(w.eval('autoDailyReportLog.length'), 0, 'a time far in the past, outside the catch window, must not fire under scheduled-only');
  b.close();
});

test(`${app}: the same business date is never reported twice, no matter how many times the scheduler ticks`, async () => {
  const b = await session(app);
  const { w } = b;
  w.eval("autoDailyReportEnabled = true; autoDailyReportMissedBehavior = 'generate-on-return'; autoDailyReportTime = '00:00';");
  w.eval("checkAutoDailyReportSchedule(); checkAutoDailyReportSchedule(); checkAutoDailyReportSchedule();");
  assert.equal(w.eval('autoDailyReportLog.length'), 1);
  b.close();
});

test(`${app}: generation is recorded even when printing itself fails — never silently lost`, async () => {
  const b = await session(app);
  const { w } = b;
  w.eval("autoDailyReportEnabled = true; autoDailyReportTime = '00:00'; window.reportsPrint = function() { throw new Error('no printer connected'); };");
  w.eval("runAutoDailyReport()");
  const log = w.eval('autoDailyReportLog');
  assert.equal(log.length, 1);
  assert.equal(log[0].printStatus, 'print-failed', 'a printing failure must be recorded distinctly, not silently swallowed');
  assert.match(log[0].error, /no printer connected/);
  // The report itself was still generated and is visible, independent of the print outcome.
  const out = w.document.getElementById('reports-output').innerHTML;
  assert.match(out, /Automatic Daily Report/);
  b.close();
});

test(`${app}: the settings panel reflects saved state and today's run status without triggering a run itself`, async () => {
  const b = await session(app);
  const { w } = b;
  w.eval("setAutoDailyReportEnabled(true); setAutoDailyReportTime('20:30');");
  w.eval('renderAutoDailyReportStatus()');
  assert.equal(w.document.getElementById('auto-daily-report-enabled-toggle').checked, true);
  assert.equal(w.document.getElementById('auto-daily-report-time-input').value, '20:30');
  assert.equal(w.eval('autoDailyReportLog.length'), 0, 'opening/rendering the settings panel must never itself generate a report');
  b.close();
});
}
