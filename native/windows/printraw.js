// MyDukaPOS for Windows - RAW printing through the Windows print spooler (zip 206).
//
// WHY THIS EXISTS. Until now the Windows app could print only (a) the page as a picture through the printer's Windows driver
// (Chromium -> GDI -> driver) or (b) raw ESC/POS to a NETWORK printer on port 9100. A USB / Windows-installed thermal printer (Xprinter,
// Epson TM, ...) therefore always went through the driver: the DRIVER decides the paper length and whether the cutter runs, a custom page
// size that the driver does not honour gives empty or very long pages, and no ESC/POS byte (cut, drawer, raster logo) ever reached the
// printer. This module sends the app's own ESC/POS bytes (the same bytes Bluetooth printers and the network path already get) to ANY Windows
// printer by name, with the spooler datatype "RAW" - the driver passes them through untouched. No native Node module is needed (nothing to
// unpack from the asar, nothing that can be missing after packaging): the Win32 spooler calls (winspool.drv) are made by the PowerShell that
// ships with every Windows 10 / 11, via a small P/Invoke class. If PowerShell is blocked on a PC the answer says so, and the Windows-driver
// way keeps working.
//
// What "ok" means, honestly: Windows' spooler accepted EVERY byte (WritePrinter wrote them all) and, after a short wait, the job is not in an
// error state (offline / paper out / needs attention). A paper is only ever proven by looking at it - the Printer test in Settings exists for that.
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- the C# class compiled by PowerShell (Add-Type) ----
const CSHARP = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class MyDukaRaw {',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  public class DOCINFO {',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;',
  '    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;',
  '  }',
  '  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]',
  '  static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);',
  '  [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true)]',
  '  static extern bool ClosePrinter(IntPtr hPrinter);',
  '  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]',
  '  static extern int StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);',
  '  [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true)]',
  '  static extern bool EndDocPrinter(IntPtr hPrinter);',
  '  [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true)]',
  '  static extern bool StartPagePrinter(IntPtr hPrinter);',
  '  [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true)]',
  '  static extern bool EndPagePrinter(IntPtr hPrinter);',
  '  [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true)]',
  '  static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);',
  '  // "OK|jobId|bytesWritten"  or  "ERR|stage|win32code"',
  '  public static string Send(string printer, byte[] data) {',
  '    IntPtr h;',
  '    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "ERR|open|" + Marshal.GetLastWin32Error();',
  '    try {',
  '      DOCINFO di = new DOCINFO(); di.pDocName = "MyDukaPOS"; di.pOutputFile = null; di.pDataType = "RAW";',
  '      int job = StartDocPrinter(h, 1, di);',
  '      if (job <= 0) return "ERR|startdoc|" + Marshal.GetLastWin32Error();',
  '      int written = 0; bool ok = false;',
  '      try {',
  '        if (!StartPagePrinter(h)) return "ERR|startpage|" + Marshal.GetLastWin32Error();',
  '        IntPtr p = Marshal.AllocCoTaskMem(data.Length);',
  '        try {',
  '          Marshal.Copy(data, 0, p, data.Length);',
  '          if (!WritePrinter(h, p, data.Length, out written)) return "ERR|write|" + Marshal.GetLastWin32Error();',
  '        } finally { Marshal.FreeCoTaskMem(p); }',
  '        EndPagePrinter(h);',
  '        ok = (written == data.Length);',
  '      } finally { EndDocPrinter(h); }',
  '      return ok ? "OK|" + job + "|" + written : "ERR|short|" + written;',
  '    } finally { ClosePrinter(h); }',
  '  }',
  '}',
].join('\r\n');

// The PowerShell program: compile, send, then look at what Windows says about the printer and the job (best effort - the Printer
// Management cmdlets exist on Windows 8 and later; if they are missing the send result alone is returned).
function psScript(verifyMs) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$src = @'",
    CSHARP,
    "'@",
    'Add-Type -TypeDefinition $src -Language CSharp',
    '$name = $env:MYDUKA_PRN',
    '$bytes = [System.IO.File]::ReadAllBytes($env:MYDUKA_FILE)',
    '$r = [MyDukaRaw]::Send($name, $bytes)',
    '$out = @{ raw = $r }',
    "if ($r.StartsWith('OK|')) {",
    '  $jobId = [int]($r.Split(\'|\')[1])',
    '  try {',
    '    $limit = [DateTime]::UtcNow.AddMilliseconds(' + Math.max(0, Math.min(5000, Number(verifyMs) || 0)) + ')',
    '    do {',
    '      $j = Get-PrintJob -PrinterName $name -ID $jobId -ErrorAction SilentlyContinue',
    '      if (-not $j) { break }',
    '      Start-Sleep -Milliseconds 80',
    '    } while ([DateTime]::UtcNow -lt $limit)',
    '    $pr = Get-Printer -Name $name -ErrorAction Stop',
    '    $out.printerStatus = [string]$pr.PrinterStatus',
    '    $out.workOffline = [bool]$pr.WorkOffline',
    "    if ($j) { $out.jobStatus = [string]$j.JobStatus } else { $out.jobStatus = 'gone' }",
    '  } catch { }',
    '}',
    '$out | ConvertTo-Json -Compress',
  ].join('\r\n');
}
const encodePs = (ps) => Buffer.from(ps, 'utf16le').toString('base64');

// ---- what Windows' error numbers mean to a cashier ----
const WIN_ERR = {
  2: 'Windows cannot find that printer. Choose the printer again in Settings.',
  5: 'Windows refused access to the printer. Run the app normally (not as another user) or check the printer\'s sharing / security.',
  6: 'The printer handle was lost. Try again.',
  21: 'The printer is not ready (switched off, unplugged or offline).',
  31: 'The printer reported a fault. Check it is on, has paper and its cover is closed.',
  32: 'The printer is being used by something else. Wait a moment and try again.',
  87: 'Windows rejected the request. Choose the printer again in Settings.',
  1722: 'The Windows print service is not answering. Restart the "Print Spooler" service or restart the PC.',
  1801: 'Windows does not know a printer with that name. It may have been renamed or removed - choose it again in Settings.',
  1796: 'This printer cannot take raw data. Choose "Windows driver" for it instead.',
  1797: 'The printer driver is missing. Reinstall the printer\'s driver.',
  1805: 'The printer cannot be reached over the network.',
  1930: 'The printer rejected raw data. Choose "Windows driver" for it instead.',
};
const STAGE = { open: 'opening the printer', startdoc: 'starting the print job', startpage: 'starting the page', write: 'sending the data', short: 'sending the data' };
function friendlyError(stage, code) {
  const c = Number(code);
  const base = WIN_ERR[c] || ('Windows reported error ' + (Number.isFinite(c) ? c : code) + ' while ' + (STAGE[stage] || stage) + '.');
  return base;
}

// ---- Windows' printer status bits (PRINTER_INFO_2.Status) ----
const STATUS_BITS = [
  [0x1, 'paused'], [0x2, 'error'], [0x4, 'being deleted'], [0x8, 'paper jam'], [0x10, 'out of paper'], [0x20, 'manual feed'], [0x40, 'paper problem'],
  [0x80, 'offline'], [0x100, 'busy (io)'], [0x200, 'busy'], [0x400, 'printing'], [0x800, 'output bin full'], [0x1000, 'not available'],
  [0x2000, 'waiting'], [0x4000, 'processing'], [0x8000, 'starting'], [0x10000, 'warming up'], [0x20000, 'toner low'], [0x40000, 'no toner'],
  [0x80000, 'page punt'], [0x100000, 'needs attention'], [0x200000, 'out of memory'], [0x400000, 'cover open'], [0x1000000, 'power save'],
];
const BAD_BITS = 0x1 | 0x2 | 0x8 | 0x10 | 0x40 | 0x80 | 0x1000 | 0x100000 | 0x200000 | 0x400000;
function decodeStatus(n) {
  const v = Number(n) || 0;
  const flags = STATUS_BITS.filter(([b]) => (v & b) !== 0).map(([, t]) => t);
  const bad = (v & BAD_BITS) !== 0;
  return { code: v, flags, ready: !bad, text: flags.length ? flags.join(', ') : 'ready' };
}

// ---- turn the PowerShell answer into a result ----
const BAD_STATE = /offline|error|paperout|paperproblem|userintervention|dooropen|notavailable|blocked|paused|notoner|deleted/i;
function interpret(stdout, bytesLen) {
  const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let o = null;
  for (let i = lines.length - 1; i >= 0 && !o; i--) { try { o = JSON.parse(lines[i]); } catch (e) { /* not the JSON line */ } }
  if (!o || typeof o.raw !== 'string') return { ok: false, stage: 'powershell', error: 'Windows printing did not answer correctly.', detail: lines.slice(-3).join(' | ').slice(0, 300) };
  const p = o.raw.split('|');
  if (p[0] !== 'OK') return { ok: false, stage: p[1] || 'send', winError: Number(p[2]) || 0, error: friendlyError(p[1], p[2]), bytes: bytesLen };
  const res = { ok: true, stage: 'spooled', bytes: bytesLen, written: Number(p[2]) || 0, jobId: Number(p[1]) || 0, printerStatus: o.printerStatus || '', jobStatus: o.jobStatus || '', workOffline: !!o.workOffline };
  if (o.workOffline) return { ...res, ok: false, queued: true, stage: 'offline', error: 'Windows says the printer is OFFLINE. The receipt is waiting in the Windows print queue and will print when the printer is back. Check it is on and plugged in.' };
  if (o.jobStatus && BAD_STATE.test(o.jobStatus)) return { ...res, ok: false, queued: true, stage: 'job-error', error: 'The printer did not take the job (' + o.jobStatus + '). Check it is on, has paper and its cover is closed. The receipt is waiting in the Windows print queue.' };
  if (o.printerStatus && BAD_STATE.test(o.printerStatus) && o.jobStatus !== 'gone') return { ...res, ok: false, queued: true, stage: 'printer-error', error: 'The printer reports: ' + o.printerStatus + '. The receipt is waiting in the Windows print queue.' };
  res.stage = o.jobStatus === 'gone' ? 'sent' : (o.jobStatus ? 'queued' : 'spooled');
  return res;
}


// ---- zip 207: ONE long-lived PowerShell. Starting PowerShell and compiling the C# class took 2-4 seconds per print; the worker does it once
// (pre-warmed when the app starts) and then each print is a few milliseconds. If the worker dies or does not answer it is thrown away and the
// next print uses the one-shot way above, so printing never depends on the worker being healthy.
function workerScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$src = @'", CSHARP, "'@",
    // zip 213: compiling the class (csc.exe) used up several seconds of a mid-range PC's CPU every time the app opened. It is compiled ONCE into
    // a small DLL (named after the code, so an update compiles a new one) and every later start just loads it. Any problem -> the old compile.
    '$loaded = $false',
    'try {',
    "  $dir = Join-Path $(if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:TEMP }) 'MyDukaPOS'",
    '  $md5 = [System.Security.Cryptography.MD5]::Create()',
    '  $hash = ([BitConverter]::ToString($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($src))) -replace "-","").Substring(0,12)',
    '  $dll = Join-Path $dir ("rawprint-" + $hash + ".dll")',
    '  if (-not (Test-Path -LiteralPath $dll)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null; Add-Type -TypeDefinition $src -Language CSharp -OutputAssembly $dll }',
    '  Add-Type -Path $dll; $loaded = $true',
    '} catch { $loaded = $false }',
    'if (-not $loaded -or -not ("MyDukaRaw" -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }',
    '[Console]::Out.WriteLine("READY"); [Console]::Out.Flush()',
    'while (($line = [Console]::In.ReadLine()) -ne $null) {',
    '  $out = @{}',
    '  try {',
    '    $req = $line | ConvertFrom-Json',
    '    $out.id = $req.id',
    '    $bytes = [System.IO.File]::ReadAllBytes([string]$req.file)',
    '    $name = [string]$req.name',
    '    $r = [MyDukaRaw]::Send($name, $bytes)',
    '    $out.raw = $r',
    "    if ($r.StartsWith('OK|')) {",
    "      $jobId = [int]($r.Split('|')[1])",
    '      try {',
    '        $limit = [DateTime]::UtcNow.AddMilliseconds([int]$req.verifyMs)',
    '        do { $j = Get-PrintJob -PrinterName $name -ID $jobId -ErrorAction SilentlyContinue; if (-not $j) { break }; Start-Sleep -Milliseconds 60 } while ([DateTime]::UtcNow -lt $limit)',
    '        $pr = Get-Printer -Name $name -ErrorAction Stop',
    '        $out.printerStatus = [string]$pr.PrinterStatus; $out.workOffline = [bool]$pr.WorkOffline',
    "        if ($j) { $out.jobStatus = [string]$j.JobStatus } else { $out.jobStatus = 'gone' }",
    '      } catch { }',
    '    }',
    '  } catch { $out.raw = "ERR|script|0"; $out.detail = [string]$_.Exception.Message }',
    '  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress)); [Console]::Out.Flush()',
    '}',
  ].join('\r\n');
}

const worker = { proc: null, ready: null, buf: '', waiting: new Map(), seq: 0 };
function workerKill() {
  const p = worker.proc; worker.proc = null; worker.ready = null; worker.buf = '';
  try { if (p) p.kill(); } catch (e) { /* gone */ }
  for (const [, w] of worker.waiting) w(null);
  worker.waiting.clear();
}
// opts.spawn is for tests. Resolves true when the worker is compiled and listening, false when it cannot be used.
function warm(opts) {
  const o = opts || {};
  if (worker.proc && worker.ready) return worker.ready;
  if (process.platform !== 'win32' && !o.spawn) return Promise.resolve(false);
  const { spawn } = require('child_process');
  let p;
  try {
    p = (o.spawn || spawn)(o.powershell || powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(workerScript())], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) { return Promise.resolve(false); }
  worker.proc = p; worker.buf = '';
  // zip 213: the worker never competes with the till for the processor (it only matters while the PC is busy; a print is still instant)
  try { if (p && p.pid) require('os').setPriority(p.pid, require('os').constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* not allowed: normal priority */ }
  worker.ready = new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => { fin(false); if (worker.proc === p) workerKill(); }, o.warmMs || 20000);
    p.stdout.on('data', (d) => {
      worker.buf += d.toString('utf8');
      let i;
      while ((i = worker.buf.indexOf('\n')) >= 0) {
        const line = worker.buf.slice(0, i).trim(); worker.buf = worker.buf.slice(i + 1);
        if (line === 'READY') { fin(true); continue; }
        let m = null; try { m = JSON.parse(line); } catch (e) { continue; }
        const w = m && worker.waiting.get(m.id); if (w) { worker.waiting.delete(m.id); w(m); }
      }
    });
    const dead = () => { fin(false); if (worker.proc === p) workerKill(); };
    p.on('exit', dead); p.on('error', dead); p.stdin.on('error', () => {});
  });
  return worker.ready;
}
// one request through the worker; resolves the parsed answer, or null when the worker cannot be used (the caller falls back)
async function viaWorker(name, file, verifyMs, o) {
  if (!(await warm(o))) return null;
  const p = worker.proc; if (!p) return null;
  const id = ++worker.seq;
  return new Promise((resolve) => {
    const t = setTimeout(() => { worker.waiting.delete(id); workerKill(); resolve(null); }, o.timeoutMs || 30000);
    worker.waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    try { p.stdin.write(JSON.stringify({ id, name, file, verifyMs }) + '\n'); } catch (e) { clearTimeout(t); worker.waiting.delete(id); workerKill(); resolve(null); }
  });
}

// ---- one job at a time: jobs never overlap or merge, and each gets its own answer ----
let tail = Promise.resolve();
const enqueue = (fn) => { const run = tail.then(fn, fn); tail = run.catch(() => {}); return run; };

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(p) ? p : 'powershell.exe';
}

// opts: { deviceName, bytes: Buffer, timeoutMs, verifyMs, exec (tests) }
function sendRaw(opts) {
  const o = opts || {};
  const name = String(o.deviceName || '');
  const bytes = Buffer.isBuffer(o.bytes) ? o.bytes : Buffer.from(o.bytes || []);
  if (!name || name.length > 256 || /[\u0000-\u001f]/.test(name)) return Promise.resolve({ ok: false, stage: 'input', error: 'Choose the printer in Settings first.' });
  if (!bytes.length) return Promise.resolve({ ok: false, stage: 'input', error: 'Nothing to print.' });
  if (bytes.length > 8 * 1024 * 1024) return Promise.resolve({ ok: false, stage: 'input', error: 'That is too much to print at once.' });
  const exec = o.exec || execFile;
  return enqueue(() => new Promise((resolve) => {
    const file = path.join(os.tmpdir(), 'mydukapos-raw-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.bin');
    const cleanup = () => { try { fs.unlinkSync(file); } catch (e) { /* gone */ } };
    try { fs.writeFileSync(file, bytes); } catch (e) { resolve({ ok: false, stage: 'file', error: 'Could not prepare the print data: ' + e.message }); return; }
    const verifyMs = o.verifyMs == null ? 900 : o.verifyMs;   // the job is checked until it has left the queue (usually ~100 ms), never a fixed wait
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(psScript(verifyMs))];
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; cleanup(); resolve(r); };
    const oneShot = () => {
    try {
      exec(o.powershell || powershellPath(), args, { env: { ...process.env, MYDUKA_PRN: name, MYDUKA_FILE: file }, windowsHide: true, timeout: o.timeoutMs || 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !String(stdout || '').trim()) {
          const why = err.killed || err.signal ? 'The printer did not answer in time (the Windows print service may be stuck).' : /ENOENT/.test(String(err.code)) ? 'Windows PowerShell was not found on this PC, so raw printing is not available. Choose "Windows driver" for this printer.' : 'Windows printing could not start: ' + String(stderr || err.message).trim().slice(0, 200);
          finish({ ok: false, stage: 'powershell', error: why });
          return;
        }
        finish(interpret(stdout, bytes.length));
      });
    } catch (e) { finish({ ok: false, stage: 'powershell', error: 'Windows printing could not start: ' + e.message }); }
    };
    if (!o.exec && (process.platform === 'win32' || o.spawn)) {
      viaWorker(name, file, verifyMs, o).then((m) => { if (m) finish(interpret(JSON.stringify(m), bytes.length)); else oneShot(); }, oneShot);
    } else oneShot();
  }));
}

module.exports = { warm, workerKill, workerScript, sendRaw, interpret, decodeStatus, friendlyError, psScript, encodePs, CSHARP, enqueue };
