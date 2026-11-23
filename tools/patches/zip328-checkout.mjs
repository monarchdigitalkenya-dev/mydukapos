// zip 328 one-off patch: wires the customer core into each app's checkout (bill = name + phone required; ordinary = optional name/ID; one profile per person).
// Safe to re-run: every replacement is skipped when already applied. Reports apps where an anchor was not found (so nothing is silently half-patched).
import { MODULES, read, write, topLevelFunctions } from '../lib.mjs';
const rep = (html, from, to, label, miss, app) => {
  if (html.includes(to.trim().split('\n')[0]) && html.includes(to)) return html;       // already applied
  const n = html.split(from).length - 1;
  if (n !== 1) { miss.push(`${app}: ${label} (found ${n})`); return html; }
  return html.replace(from, () => to);
};
const miss = [];
for (const app of MODULES) {
  let html = read(app);
  // A. the old phone-only registration now asks the customer core (same signature, same callers)
  const { decls } = topLevelFunctions(html);
  const d = decls.registerOrUpdateCustomer && decls.registerOrUpdateCustomer[0];
  if (d && !d.src.includes('custRegister')) html = html.replace(d.src, () => 'function registerOrUpdateCustomer(phone, name, extra) {\n            // zip 328: one profile per person - matching, creation and the shared-phone rules live in custRegister / upsertCustomer (src/shared/functions.js)\n            return custRegister(phone, name, extra);\n        }');
  if (!decls.checkoutCartOnce) { write(app, html); continue; }
  // B. checkout
  html = rep(html, "            let customerName = '';\n            let billUpfrontAmount = 0, billUpfrontCode = '', billUpfrontBankRef = '';", "            let customerName = '';\n            let __cust = null;                  // zip 328: the customer details captured for this sale (bill: name + phone required)\n            let billUpfrontAmount = 0, billUpfrontCode = '', billUpfrontBankRef = '';", 'let customerName', miss, app);
  html = rep(html, "                customerName = (document.getElementById('bill-customer-name-input').value || '').trim();\n                billDueDate = ", "                customerName = (document.getElementById('bill-customer-name-input').value || '').trim();\n                __cust = typeof custCheckoutCapture === 'function' ? await custCheckoutCapture(true) : null;   // zip 328: a bill needs name + phone\n                if (__cust && !__cust.ok) { showToast(__cust.error, true); return; }\n                if (__cust && __cust.name) customerName = __cust.name;\n                billDueDate = ", 'bill capture', miss, app);
  html = rep(html, "            // The payer name and transaction code auto-fill if a prompt was sent and\n", "            if (!__cust && typeof custCheckoutCapture === 'function') {      // zip 328: an ordinary sale - every customer field optional\n                __cust = await custCheckoutCapture(false);\n                if (__cust && !__cust.ok) { showToast(__cust.error, true); return; }\n                if (__cust && __cust.name && !customerName) customerName = __cust.name;\n            }\n            // The payer name and transaction code auto-fill if a prompt was sent and\n", 'ordinary capture', miss, app);
  html = rep(html, "                customerPhone: ((document.getElementById('sms-checkout-phone-input').value || '').trim() || deliveryPhone) || null,", "                customerPhone: ((document.getElementById('sms-checkout-phone-input').value || '').trim() || deliveryPhone) || null,\n                customerIdNumber: (__cust && __cust.idNumber) || null,           // zip 328: optional; printed on the receipt\n                customerId: null,                                                // zip 328: set below to the ONE profile of this customer", 'sale fields', miss, app);
  html = rep(html, "            try { if (typeof cashStampSale === 'function') { cashStampSale(saleRecord); cashStampSale(saleRecordForReceipt); } } catch (e) { /* never block a sale */ }", "            try { if (typeof custLinkSale === 'function' && __cust) custLinkSale(__cust, saleRecord, saleRecordForReceipt); } catch (e) { /* never block a sale */ }   // zip 328\n            try { if (typeof cashStampSale === 'function') { cashStampSale(saleRecord); cashStampSale(saleRecordForReceipt); } } catch (e) { /* never block a sale */ }", 'link sale', miss, app);
  html = rep(html, "            document.getElementById('sms-checkout-phone-input').value = '';", "            document.getElementById('sms-checkout-phone-input').value = '';\n            if (typeof custCheckoutClear === 'function') custCheckoutClear();      // zip 328", 'clear', miss, app);
  write(app, html);
}
console.log(miss.length ? 'NOT PATCHED:\n' + miss.join('\n') : 'all anchors patched');
