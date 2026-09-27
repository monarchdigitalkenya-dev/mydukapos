// Runs every tests/*.test.mjs with Node's built-in test runner. A tiny wrapper (rather than
// `node --test tests/`) so it behaves the same on Node 18/20/22 and on Windows.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib.mjs';

const dir = path.join(ROOT, 'tests');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join('tests', f));
// The tills run on Kenya time (the business date follows it — see bizDayKey). The tests do too, so a test that says "today" means the
// same day at any hour of the run (run under UTC after 21:00, "today" in Kenya is already tomorrow).
const r = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, TZ: process.env.TZ || 'Africa/Nairobi' } });
process.exit(r.status ?? 1);
