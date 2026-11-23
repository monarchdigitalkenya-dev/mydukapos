// tools/film/record-demo-film.mjs - zip 305. Re-shoots the home-page demo film from the REAL shop app (sample retail shop, no server).
// Frames come from Chrome's screencast (sharp, as fluid as the page), then tools/film/encode-demo-film.cmd / the ffmpeg lines at the bottom
// turn them into public-site/img/demo-film-720.mp4 + .webm + demo-film-poster.jpg. Needs Playwright's Chromium and ffmpeg.
//   node tools/film/record-demo-film.mjs      (writes tools/film/out/frames + frames.json + concat.txt)
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { chromium } = createRequire(ROOT + '/package.json')('playwright');
const { SEED_BUILDERS } = await import(ROOT + '/functions/api/_demo-seeds.js');
const OUTDIR = path.join(ROOT, 'tools', 'film', 'out'); const OUT = path.join(OUTDIR, 'frames'); fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const W = 1600, H = 900;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => { let p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html'); if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + srv.address().port;
const seed = SEED_BUILDERS.retail(Date.now());
const H256 = crypto.createHash('sha256').update('pw').digest('hex');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await ctx.route('**/api/**', (r) => r.abort());
await ctx.addInitScript(([h, s]) => {
  if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
  const L = (k, v) => localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  L('pos_pw_hash', h); L('pos_biz_name', 'Mama Njeri Supermarket');
  for (const k of ['pos_notif_prompt_last', 'pos_cd_detect_last']) L(k, String(Date.now()));
  L('pos_inventory', s.inventory); L('pos_sales_log', s.salesLog); L('pos_customers', s.customers); L('pos_expenses', s.expenses); L('pos_debts', s.debts); L('pos_bills', s.bills);
  L('pos_locked_tabs', []); L('pos_round_up', '0'); L('pos_cash_config', [{ id: 'cfg', enabled: false, updatedAt: 1 }]);
  L('pos_auto_print', 'false'); L('pos_tax_cfg', { v: 1, vatRegistered: true, rates: [{ from: 0, A: 16, B: 8, seed: true }], reg: [{ from: 0, on: true }], updatedAt: 0 });
}, [H256, seed]);
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e.message)));
await page.goto(base + '/', { waitUntil: 'load' });
await page.waitForTimeout(3500);
await page.evaluate(() => {
  for (const id of ['login-screen', 'registration-screen', 'boot-splash']) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
  const a = document.getElementById('app-container'); if (a) a.style.display = '';
  document.querySelectorAll('.modal, .modal-backdrop').forEach((m) => { if (getComputedStyle(m).display !== 'none') m.style.display = 'none'; });
  try { autoPrintEnabled = false; } catch (e) {} window.print = () => {}; window.confirm = () => true; window.closeReceiptAfterPrint = function () {};
  try { showToast = function () {}; } catch (e) {}
  // ---- the film's own layer: camera, cursor, captions, title cards (outside <body>, so the camera never moves them) ----
  const st = document.createElement('style'); st.textContent = `
    body { transition: transform 2.6s cubic-bezier(.45,.05,.2,1), transform-origin 2.6s cubic-bezier(.45,.05,.2,1); transform-origin: 50% 30%; will-change: transform; }
    #dm-cur { position: fixed; z-index: 2147483600; left: 0; top: 0; width: 26px; height: 26px; margin: -4px 0 0 -4px; pointer-events: none; transition: transform .9s cubic-bezier(.45,.05,.2,1); filter: drop-shadow(0 3px 6px rgba(0,0,0,.35)); }
    #dm-ring { position: fixed; z-index: 2147483599; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid rgba(47,128,237,.9); pointer-events: none; opacity: 0; transform: scale(.4); }
    #dm-ring.go { animation: dmRing .55s ease-out; } @keyframes dmRing { 0% { opacity: .95; transform: scale(.4); } 100% { opacity: 0; transform: scale(1.6); } }
    #dm-cap { position: fixed; z-index: 2147483500; left: 56px; bottom: 54px; max-width: 720px; padding: 16px 24px 16px 20px; border-radius: 16px; background: rgba(12,22,38,.86); color: #fff; font: 600 26px/1.25 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; letter-spacing: -.01em; backdrop-filter: blur(6px); box-shadow: 0 18px 50px rgba(0,0,0,.35); opacity: 0; transform: translateY(18px); transition: opacity .6s ease, transform .6s cubic-bezier(.2,.8,.2,1); display: flex; gap: 16px; align-items: center; }
    #dm-cap.on { opacity: 1; transform: none; }
    #dm-cap b { flex: 0 0 auto; display: inline-flex; width: 42px; height: 42px; border-radius: 12px; align-items: center; justify-content: center; background: linear-gradient(135deg,#2f80ed,#56ccf2); font-size: 22px; }
    #dm-cap small { display: block; font-weight: 500; font-size: 17px; opacity: .78; margin-top: 3px; }
    #dm-card { position: fixed; inset: 0; z-index: 2147483550; display: flex; align-items: center; justify-content: center; flex-direction: column; text-align: center; background: radial-gradient(1200px 700px at 30% 20%, #1b3a66 0%, #0b1424 55%, #060b14 100%); color: #fff; font-family: 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; opacity: 0; transition: opacity .9s ease; pointer-events: none; }
    #dm-card.on { opacity: 1; }
    #dm-card .k { font-size: 18px; letter-spacing: .32em; text-transform: uppercase; color: #8ec5ff; opacity: 0; transform: translateY(10px); transition: all .9s .2s ease; }
    #dm-card h1 { margin: 18px 0 0; font-size: 76px; line-height: 1.04; font-weight: 800; letter-spacing: -.03em; opacity: 0; transform: translateY(18px) scale(.98); transition: all 1.1s .35s cubic-bezier(.2,.8,.2,1); }
    #dm-card h1 span { background: linear-gradient(90deg,#56ccf2,#2f80ed 45%,#f2994a); -webkit-background-clip: text; background-clip: text; color: transparent; }
    #dm-card p { margin: 22px 0 0; font-size: 26px; color: #c9d6e6; opacity: 0; transform: translateY(12px); transition: all 1s .7s ease; }
    #dm-card.on .k, #dm-card.on h1, #dm-card.on p { opacity: 1; transform: none; }
    #dm-card .glow { position: absolute; width: 900px; height: 900px; border-radius: 50%; background: radial-gradient(circle, rgba(47,128,237,.25), transparent 60%); animation: dmGlow 9s ease-in-out infinite alternate; }
    @keyframes dmGlow { from { transform: translate(-180px,-80px) scale(.9); } to { transform: translate(200px,90px) scale(1.15); } }
    #dm-card .pill { margin-top: 34px; display: inline-block; padding: 16px 30px; border-radius: 14px; background: #2f80ed; font-size: 24px; font-weight: 700; box-shadow: 0 14px 40px rgba(47,128,237,.45); opacity: 0; transform: translateY(12px); transition: all 1s 1s ease; }
    #dm-card.on .pill { opacity: 1; transform: none; }
    #dm-vig { position: fixed; inset: 0; z-index: 2147483400; pointer-events: none; background: radial-gradient(ellipse at center, transparent 62%, rgba(4,10,20,.28) 100%); }
    #dm-fade { position: fixed; inset: 0; z-index: 2147483560; background: #060b14; opacity: 0; transition: opacity .7s ease; pointer-events: none; }
    #dm-fade.on { opacity: 1; }
    html.dm-keepr #receipt-modal { display: flex !important; }
    html.dm-live #dst-bar, html.dm-live #dst-help { display: none !important; }
    html.dm-nocur #dm-cur { opacity: 0; } #dm-cur { transition: transform .9s cubic-bezier(.45,.05,.2,1), opacity .4s ease; }
    #dst-bar.dm-pop { outline: 4px solid rgba(242,153,74,.85); outline-offset: 4px; border-radius: 14px; transition: outline-color .4s; }`;
  document.head.appendChild(st);
  const H = document.documentElement;
  const mk = (id, html) => { const d = document.createElement('div'); d.id = id; if (html) d.innerHTML = html; H.appendChild(d); return d; };
  H.classList.add('dm-live', 'dm-nocur'); mk('dm-vig'); mk('dm-ring'); mk('dm-cap'); mk('dm-card'); mk('dm-fade');
  mk('dm-cur', '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l15 9.2-6.6 1.3 3.8 7.4-2.6 1.3-3.8-7.4L4 18.6z" fill="#fff" stroke="#0b1424" stroke-width="1.4" stroke-linejoin="round"/></svg>');
  document.getElementById('dm-cur').style.transform = 'translate(1300px, 700px)';
  window.__dm = {
    origin(x, y) { const b = document.body.getBoundingClientRect(), m = /scale\(([\d.]+)\)/.exec(document.body.style.transform || ''), k = m ? +m[1] : 1; return [(x - b.left) / k, (y - b.top) / k]; },
    focus(o, s) { document.body.style.transformOrigin = o[0] + 'px ' + o[1] + 'px'; document.body.style.transform = 'scale(' + s + ')'; },
    reset() { const b = document.body; b.style.transition = 'none'; b.style.transform = 'none'; b.style.transformOrigin = '50% 30%'; void b.offsetWidth; setTimeout(() => { b.style.transition = ''; }, 50); },
    cam(s, x, y) { document.body.style.transform = s === 1 ? 'none' : `translate(${x || 0}px, ${y || 0}px) scale(${s})`; },
    cap(n, t, sub) { const c = document.getElementById('dm-cap'); if (!t) { c.classList.remove('on'); return; } c.innerHTML = (n ? '<b>' + n + '</b>' : '') + '<div>' + t + (sub ? '<small>' + sub + '</small>' : '') + '</div>'; c.classList.add('on'); },
    card(k, h, p, pill) { const c = document.getElementById('dm-card'); document.documentElement.classList.toggle('dm-nocur', !!h); if (!h) { c.classList.remove('on'); return; } c.innerHTML = '<div class="glow"></div><div class="k">' + k + '</div><h1>' + h + '</h1>' + (p ? '<p>' + p + '</p>' : '') + (pill ? '<div class="pill">' + pill + '</div>' : ''); void c.offsetWidth; c.classList.add('on'); },
    fade(on) { document.getElementById('dm-fade').classList.toggle('on', !!on); },
    move(x, y) { document.getElementById('dm-cur').style.transform = `translate(${x}px, ${y}px)`; },
    ring(x, y) { const r = document.getElementById('dm-ring'); r.style.left = x + 'px'; r.style.top = y + 'px'; r.classList.remove('go'); void r.offsetWidth; r.classList.add('go'); },
  };
});
// ---------------- capture ----------------
const cdp = await ctx.newCDPSession(page);
const frames = []; let n = 0;
cdp.on('Page.screencastFrame', async (f) => {
  const file = path.join(OUT, String(n++).padStart(6, '0') + '.jpg');
  fs.writeFileSync(file, Buffer.from(f.data, 'base64')); frames.push({ file, t: f.metadata.timestamp });
  try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch (e) {}
});
const wait = (ms) => page.waitForTimeout(ms);
const dm = (fn, ...a) => page.evaluate(([f, args]) => window.__dm[f](...args), [fn, a]);
async function at(sel, idx = 0) { return page.evaluate(([s, i]) => { const els = [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null); const e = els[i]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, [sel, idx]); }
async function point(sel, idx = 0, ms = 950) { const p = await at(sel, idx); if (!p) { console.log('missing', sel); return null; } await dm('move', p.x, p.y); await wait(ms); return p; }
async function click(sel, idx = 0) { const p = await point(sel, idx); if (!p) return; await dm('ring', p.x, p.y); await page.evaluate(([s, i]) => { const els = [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null); els[i] && els[i].click(); }, [sel, idx]); await wait(450); }
async function spot(sel) { const p = await at(sel); if (!p) { console.log('no spot', sel); return null; } return page.evaluate(([x, y]) => window.__dm.origin(x, y), [p.x, p.y]); }
async function focus(o, sc) { if (o) await page.evaluate(([oo, ss]) => window.__dm.focus(oo, ss), [o, sc]); }
const tab = (id) => page.evaluate((t) => { const b = document.querySelector('.tab-link[data-tab="' + t + '"]'); b && b.click(); }, id);

await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
const mark = {}; const m = (k) => { mark[k] = frames.length; };
// S0 title
await dm('card', 'MyDuka POS', 'Run your business <span>smarter</span>.', 'One real sale — from scan to dashboard.');
m('s0'); await wait(4200);
await tab('sales-tab'); await wait(400);
await dm('card'); await wait(1100);
// S1 sell
const oGrid = await spot('#sales-tab .item-grid-cell'), oCart = await spot('#main-checkout-btn');
m('s1'); await focus(oGrid, 1.12);
await dm('cap', '1', 'Tap or scan products', 'Photos, categories and barcode search on one screen');
await wait(1200);
const idxOf = (name) => page.evaluate((nm) => [...document.querySelectorAll('#sales-tab .item-grid-cell')].filter((e) => e.offsetParent !== null).findIndex((e) => (e.querySelector('.igc-name') || {}).textContent === nm), name);
for (const nm of ['Unga Maize Flour 2kg', 'Cooking Oil 1L', 'Fresh Milk 500ml']) { const i = await idxOf(nm); console.log(nm, i); if (i >= 0) await click('#sales-tab .item-grid-cell', i); }
await click('#sales-tab .item-grid-cell', await idxOf('Fresh Milk 500ml'));
await wait(600);
// S2 cart and pay
m('s2'); await focus(oCart, 1.22);
await dm('cap', '2', 'The total updates as you sell', 'Cash, M-Pesa, card or split');
await wait(1600);
await page.evaluate(() => { try { currentPaymentMethod = 'cash'; } catch (e) {} const t = document.getElementById('cash-tendered-input'); if (t) { t.value = '1000'; t.dispatchEvent(new Event('input', { bubbles: true })); } });
await point('#cash-tendered-input', 0, 900); await wait(700);
const done = '#main-checkout-btn';
await point(done, 0, 1000);
await dm('ring', ...(Object.values(await at(done) || { x: 0, y: 0 })));
await page.evaluate(() => { try { checkoutCart(); } catch (e) { console.log(e); } });
await wait(1500);
// S3 receipt
m('s3'); await page.evaluate(() => { document.documentElement.classList.add('dm-keepr'); try { const m = document.getElementById('receipt-modal'); if (!m || getComputedStyle(m).display === 'none') renderReceipt(salesLog[salesLog.length - 1]); } catch (e) { console.log('rr', e.message); } }); await wait(400);
await dm('cap', '3', 'Payment recorded · receipt ready', 'Print, share on WhatsApp, or send by SMS');
await focus(await spot('#receipt-paper'), 1.45);
for (let i = 0; i < 8; i++) { await wait(500); await page.evaluate(() => { const m = document.getElementById('receipt-modal'); if (m && getComputedStyle(m).display === 'none') { try { renderReceipt(salesLog[salesLog.length - 1]); } catch (e) {} } }); }
await page.evaluate(() => { document.documentElement.classList.remove('dm-keepr'); const m = document.getElementById('receipt-modal'); if (m) m.style.display = 'none'; document.querySelectorAll('.modal').forEach((x) => { if (getComputedStyle(x).display !== 'none') x.style.display = 'none'; }); });
await dm('fade', true); await wait(800);
// S4 stock
await dm('reset'); await tab('inventory-list-tab'); await wait(500);
await page.evaluate(() => { const i = document.getElementById('inventory-search-input'); if (i) { i.value = 'Unga'; i.dispatchEvent(new Event('input', { bubbles: true })); } });
await wait(900); await focus(await spot('#inventory-list-tab tbody tr'), 1.45);
await dm('fade', false); m('s4');
await dm('cap', '4', 'Stock comes off by itself', 'Sold 1 bag of Unga: 3 left — flagged as low stock');
await wait(3800);
await dm('fade', true); await wait(800);
// S5 dashboard
await dm('reset'); await tab('dashboard-tab'); await wait(1200); await page.evaluate(() => window.scrollTo(0, 0));
await dm('fade', false); m('s5');
await dm('cap', '5', 'Your dashboard, live', 'Sales, profit, payment methods and what needs attention');
await wait(1200); await focus(await spot('.dp-kpis'), 1.12); await wait(3600);
// S6 offline
await ctx.setOffline(true);
await page.evaluate(() => { try { window.PosNet && window.PosNet.check && window.PosNet.check('film'); } catch (e) {} });
await dm('cam', 1, 0, 0); await wait(900);
await page.evaluate(() => { document.documentElement.classList.remove('dm-live'); try { window.dashStatus && window.dashStatus.draw(); } catch (e) {} const b = document.getElementById('dst-bar'); if (b) b.classList.add('dm-pop'); });
await wait(400); await focus(await spot('#dst-bar'), 1.22);
await dm('cap', '6', 'No internet? Keep selling.', 'Sales are saved on the device and sync when the connection returns');
m('s6'); await wait(4200);
await ctx.setOffline(false);
await dm('fade', true); await wait(800);
// S7 tax
await page.evaluate(() => document.documentElement.classList.add('dm-live')); await dm('reset'); await tab('tax-tab'); await wait(600); await page.evaluate(() => window.scrollTo(0, 0));
await page.evaluate(() => { const s = document.getElementById('tx-period'); if (s) { s.value = 'this'; s.dispatchEvent(new Event('change', { bubbles: true })); } });
await wait(600);
await dm('fade', false); m('s7');
await dm('cap', '7', 'Tax summaries, ready for your return', 'By tax class, with CSV and PDF exports');
await wait(1400); await focus(await spot('#tax-tab .tx-kpis'), 1.18); await wait(3200);
// S8 end card
await dm('cap'); await dm('card', 'mydukapos.store', 'Sell. Track. <span>Grow.</span>', 'Shops · Hotels · Pharmacies · Hospitals · Production · Services · Water', 'Explore the live demo');
m('s8'); await wait(4800);
await cdp.send('Page.stopScreencast');
await wait(300);
fs.writeFileSync(path.join(OUTDIR, 'frames.json'), JSON.stringify({ frames, mark }));
let cc = ''; for (let i = 0; i < frames.length; i++) { const d = i < frames.length - 1 ? Math.max(0.001, frames[i + 1].t - frames[i].t) : 1.0; cc += "file '" + frames[i].file.replace(/\\/g, '/') + "'\nduration " + d.toFixed(4) + "\n"; }
cc += "file '" + frames[frames.length - 1].file.replace(/\\/g, '/') + "'\n"; fs.writeFileSync(path.join(OUTDIR, 'concat.txt'), cc);
console.log('frames', frames.length, 'span', (frames[frames.length - 1].t - frames[0].t).toFixed(1) + 's', 'errors', JSON.stringify(errors.slice(0, 3)));
await browser.close(); srv.close();

// Encode (run from the project folder; DUR = the span printed above + 1, fade starts ~0.9 s before the end):
//   ffmpeg -f concat -safe 0 -i tools/film/out/concat.txt -vf "fps=30,scale=1280:720:flags=lanczos,eq=contrast=1.03:saturation=1.06,fade=t=in:st=0:d=0.6,fade=t=out:st=52.7:d=0.8,format=yuv420p" -c:v libx264 -preset slow -crf 22 -tune animation -profile:v high -level 4.0 -maxrate 2200k -bufsize 4400k -g 60 -movflags +faststart -an public-site/img/demo-film-720.mp4
//   ffmpeg -f concat -safe 0 -i tools/film/out/concat.txt -vf "(same filters)" -c:v libvpx-vp9 -crf 34 -b:v 0 -row-mt 1 -deadline good -cpu-used 2 -g 60 -an public-site/img/demo-film-720.webm
//   ffmpeg -i public-site/img/demo-film-720.mp4 -ss 11.5 -frames:v 1 -q:v 5 public-site/img/demo-film-poster.jpg
