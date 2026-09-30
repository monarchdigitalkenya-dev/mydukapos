// bootCrm: opens crm/index.html in jsdom with the given fetch stub (shared by crm-ui.test.mjs and the later CRM UI tests).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRMDIR = path.join(ROOT, 'crm');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function bootCrm({ stub, storage = {}, hash = '', wait = 350 } = {}) {
  let html = fs.readFileSync(path.join(CRMDIR, 'index.html'), 'utf8');
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, f) => '<script>' + fs.readFileSync(path.join(CRMDIR, f), 'utf8') + '</script>');
  html = html.replace(/<link rel="stylesheet"[^>]*>/, '');
  const errors = []; const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + String(e.message).slice(0, 200)));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ').slice(0, 200)));
  const dom = new JSDOM(html, {
    url: 'https://mydukapos.store/crm/' + hash, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      Object.entries(storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
      w.fetch = stub.fetch; w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      w.HTMLCanvasElement.prototype.getContext = () => null; w.scrollTo = () => {}; w.Element.prototype.scrollIntoView = () => {};
    },
  });
  await sleep(wait);
  const w = dom.window; const d = w.document;
  const ctl = {
    w, d, errors, close: () => { try { w.fetch = () => new Promise(() => {}); (w.CRM.timers || []).forEach((t) => w.clearInterval(t)); } catch (e) { /* closed */ } setTimeout(() => w.close(), 250); },
    text: () => ['#app', '#toasts', '#modal-root'].map((x) => (d.querySelector(x) || { textContent: '' }).textContent).join(' '),
    async until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (e) { /* not yet */ } await sleep(30); } throw new Error('timeout waiting for: ' + fn.toString().slice(0, 120) + '\nBODY: ' + d.body.textContent.replace(/\s+/g, ' ').slice(0, 400)); },
    q: (s) => d.querySelector(s), qa: (s) => [...d.querySelectorAll(s)],
    byText(sel, t) { return [...d.querySelectorAll(sel)].find((e) => e.textContent.trim() === t || e.textContent.trim().includes(t)); },
    click(el) { if (!el) throw new Error('click on missing element'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); },
    type(el, v) { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); },
    go(h) { w.location.hash = h; },
  };
  return ctl;
}
