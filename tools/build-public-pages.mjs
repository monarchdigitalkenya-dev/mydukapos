// tools/build-public-pages.mjs — generates the public pages that share one design (public-site/site.css): terms, privacy, cookies, acceptable-use,
// faq, contact, offers. Run `npm run build:public`; tests/zip177-public-site.test.mjs fails if the committed files drift from this generator.
// Rules for the text: nothing here may state a company, registration number, address, price or certification that the owner has not published
// elsewhere on the site. The legal pages are plain-language terms of use written from what the product actually does, and say so.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERMS_VERSION, PRIVACY_VERSION } from '../functions/api/_legal.js';
import { SUPPORT_WHATSAPP, DEFAULT_SITE_ORIGIN } from '../functions/_site.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WA = `https://wa.me/${SUPPORT_WHATSAPP}`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NAV = [['/', 'Home'], ['/shop', 'Hardware'], ['/offers', 'Offers'], ['/websites', 'Website Development'], ['/portfolio', 'Portfolio'], ['/faq', 'FAQ'], ['/contact', 'Contact'], ['/dashboard.html', 'Sign in']];
const FOOT = [['/terms', 'Terms of Service'], ['/privacy', 'Privacy Policy'], ['/cookies', 'Cookies'], ['/acceptable-use', 'Acceptable Use']];

function shell({ file, title, description, body, extraHead = '', script = '' }) {
  const canon = file === 'index' ? '/' : '/' + file;
  const abs = DEFAULT_SITE_ORIGIN + canon;        // zip 273: canonical, og:url and og:image are ABSOLUTE in the HTML itself (crawlers and social scrapers do not run script)
  const nav = NAV.map(([h, t]) => `<a href="${h}"${h === canon ? ' aria-current="page"' : ''}>${t}</a>`).join('');
  const foot = FOOT.map(([h, t]) => `<a href="${h}">${t}</a>`).join('<br>');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — MyDukaPOS</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${abs}">
<meta property="og:type" content="website"><meta property="og:site_name" content="MyDukaPOS"><meta property="og:title" content="${esc(title)} — MyDukaPOS"><meta property="og:description" content="${esc(description)}"><meta property="og:image" content="${DEFAULT_SITE_ORIGIN}/img/og-default.png"><meta property="og:url" content="${abs}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)} — MyDukaPOS"><meta name="twitter:description" content="${esc(description)}">
<meta name="theme-color" content="#0B1F4D">
<link rel="icon" href="/favicon.ico?v=283" sizes="any"><link rel="shortcut icon" href="/favicon.ico?v=283"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E%3Cstyle%3E%40media (prefers-color-scheme:dark)%7B.cart%7Bfill:#E8F1FF;stroke:#E8F1FF%7D%7D%3C/style%3E%3Cdefs%3E%3ClinearGradient id=%22m%22 gradientUnits=%22userSpaceOnUse%22 x1=%225%22 y1=%228%22 x2=%2238%22 y2=%2254%22%3E%3Cstop offset=%220%22 stop-color=%22#00D2FF%22/%3E%3Cstop offset=%22.55%22 stop-color=%22#1D7BFF%22/%3E%3Cstop offset=%221%22 stop-color=%22#1747E0%22/%3E%3C/linearGradient%3E%3ClinearGradient id=%22d%22 gradientUnits=%22userSpaceOnUse%22 x1=%2230%22 y1=%2256%22 x2=%2258%22 y2=%228%22%3E%3Cstop offset=%220%22 stop-color=%22#FF4D12%22/%3E%3Cstop offset=%22.55%22 stop-color=%22#FF8A0D%22/%3E%3Cstop offset=%221%22 stop-color=%22#FFC01F%22/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d=%22M34 13.5H37.5A18.5 18.5 0 0 1 37.5 50.5H34%22 fill=%22none%22 stroke=%22url(#d)%22 stroke-width=%229.5%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/%3E%3Cpath d=%22M9.5 50V14.5L21.75 33L34 14.5V50%22 fill=%22none%22 stroke=%22url(#m)%22 stroke-width=%229.5%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/%3E%3Cpath d=%22M34 13.5H37.5%22 fill=%22none%22 stroke=%22url(#d)%22 stroke-width=%229.5%22 stroke-linecap=%22round%22/%3E%3Cg class=%22cart%22 fill=%22none%22 stroke=%22#0B1F4D%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath class=%22cart%22 d=%22M40.2 25.2H49.4L47.6 31.6H42Z%22 fill=%22#0B1F4D%22/%3E%3Cpath d=%22M49.4 25.2L50.9 22.2%22/%3E%3C/g%3E%3Ccircle cx=%2242.9%22 cy=%2235.6%22 r=%221.55%22 fill=%22#0B1F4D%22 class=%22cart%22/%3E%3Ccircle cx=%2246.9%22 cy=%2235.6%22 r=%221.55%22 fill=%22#0B1F4D%22 class=%22cart%22/%3E%3C/svg%3E" type="image/svg+xml"><link rel="icon" href="/favicon-32x32.png?v=283" type="image/png" sizes="32x32"><link rel="icon" href="/favicon-16x16.png?v=283" type="image/png" sizes="16x16"><link rel="apple-touch-icon" href="/apple-touch-icon.png?v=283" sizes="180x180">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/site.css">
${extraHead}</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="nav"><div class="wrap"><a class="brand" href="/">my<b>duka</b>pos</a><nav aria-label="Main">${nav}</nav></div></header>
<main id="main"><div class="wrap">
${body}
</div></main>
<footer class="foot"><div class="wrap"><div class="cols">
<div><h4>mydukapos</h4>Point of sale software for Kenyan businesses.<br><a href="${WA}" rel="noopener">WhatsApp us</a></div>
<div><h4>Legal</h4>${foot}</div>
<div><h4>Help</h4><a href="/faq">FAQ</a><br><a href="/contact">Contact</a><br><a href="/shop">Hardware</a><br><a href="/offers">Offers</a><br><a href="/websites">Website Development</a><br><a href="/portfolio">Portfolio</a></div>
</div><p class="small">© <span id="yr">2026</span> mydukapos. All rights reserved.</p></div></footer>
<script>document.getElementById('yr').textContent=new Date().getFullYear();try{if(navigator.doNotTrack!=='1'&&navigator.sendBeacon)navigator.sendBeacon('/api/hit',new Blob([JSON.stringify({path:location.pathname})],{type:'application/json'}))}catch(e){}</script>
${script}</body>
</html>
`;
}

const DRAFT = `<p class="notice"><strong>Plain-language document.</strong> This text describes how mydukapos works and what we ask of you. It has not been reviewed by a lawyer; if your business needs a reviewed contract, contact us before relying on it.</p>`;
const legal = (title, version, sections) => `<div class="legal"><p class="eyebrow">Legal</p><h1>${title}</h1><p class="meta">Version ${version}</p>${DRAFT}${sections.map(([h, ps]) => `<h2>${h}</h2>${ps}`).join('')}</div>`;

const terms = legal('Terms of Service', TERMS_VERSION, [
  ['1. Who we are and what this covers', '<p>mydukapos provides point-of-sale software (shop, hotel and restaurant, hospital, pharmacy, production, services and water-station modules) that runs in your browser, on Windows or on Android, with optional cloud sync. By creating an account you agree to these terms.</p>'],
  ['2. Your account', '<ul><li>You must give correct details and keep your password private. You are responsible for what is done with your account and the staff logins you create.</li><li>The password you set on the website is also the password for your till. Tills sign in on the device itself, so they keep working without internet.</li><li>Tell us promptly if you think your account has been used without your permission.</li></ul>'],
  ['3. Your business data', '<p>The sales, stock, customer and staff records you enter belong to you. We store and process them only to run the service for you (including sync between your devices and backups). You are responsible for the accuracy of what you record and for keeping your own tax and legal records as the law requires.</p>'],
  ['4. Acceptable use', '<p>You agree to follow our <a href="/acceptable-use">Acceptable Use rules</a>.</p>'],
  ['5. Payments and integrations', '<p>Features that connect to third-party services (for example M-Pesa or KRA eTIMS) depend on those services and on the credentials you provide. We do not control third-party systems and cannot promise they will be available.</p>'],
  ['6. Availability and offline use', '<p>We work to keep the service running, but it is provided as available and may be interrupted for maintenance or by problems outside our control. Keep regular exports of important records.</p>'],
  ['7. Limits of liability', '<p>To the extent the law allows, we are not liable for indirect or consequential losses, or for losses caused by third-party services, loss of internet or power, or misuse of your account. Nothing in these terms limits liability that cannot be limited by law.</p>'],
  ['8. Ending your account', '<p>You may stop using the service at any time. We may suspend an account that breaks these terms or the acceptable-use rules. Contact us to ask for your data to be exported or deleted; see the <a href="/privacy">Privacy Policy</a>.</p>'],
  ['9. Changes', '<p>If we change these terms in a way that matters, we will publish the new version here with a new version number. Continuing to use the service after that means you accept the update.</p>'],
  ['10. Contact', `<p>Questions? Use the <a href="/contact">contact page</a> or <a href="${WA}" rel="noopener">WhatsApp</a>.</p>`],
]);

const privacy = legal('Privacy Policy', PRIVACY_VERSION, [
  ['1. What we collect', '<ul><li><strong>Account details:</strong> your name, business name, phone number, email address and a salted, one-way hash of your password (we cannot read your password).</li><li><strong>Consent record:</strong> when you accept the Terms, the document versions, the time, where you signed up (website or app) and the country your connection appears to come from. We do not store your IP address for this.</li><li><strong>Business data you enter:</strong> products, sales, customers, staff and similar records, stored so your devices can sync.</li><li><strong>Messages you send us</strong> through the contact form or WhatsApp.</li><li><strong>Basic, cookieless usage counts</strong> for public pages (page views and referrer), without personal identifiers.</li></ul>'],
  ['2. Why we use it', '<p>To create and secure your account, run and sync your tills, send verification and password-reset messages, answer your questions, prevent abuse, and keep the service working.</p>'],
  ['3. Who processes it', '<p>Our service is hosted on Cloudflare. Verification and reset messages are sent through email and WhatsApp providers. They handle data only to deliver the service.</p>'],
  ['4. Retention and your choices', `<p>We keep account data while your account exists. You can ask us to correct, export or delete your data using the <a href="/contact">contact page</a>. We aim to handle personal data in line with the Kenya Data Protection Act, 2019; this page is not a claim of registration or certification.</p>`],
  ['5. Security', '<p>Passwords are stored as salted hashes, traffic uses HTTPS, and sign-in attempts are rate-limited. No system is perfectly secure, so use a strong, unique password.</p>'],
  ['6. Cookies', '<p>See the <a href="/cookies">Cookies page</a>.</p>'],
  ['7. Changes', '<p>Updates are published here with a new version number.</p>'],
]);

const cookies = legal('Cookies and local storage', PRIVACY_VERSION, [
  ['What we use', '<ul><li><strong>Sign-in token</strong> kept in your browser so you stay signed in to the dashboard.</li><li><strong>Local storage</strong> in the till apps, which holds your shop data on your device so it works offline.</li><li><strong>Service worker cache</strong> so the apps open without internet.</li></ul>'],
  ['What we do not use', '<p>The public pages set no advertising or cross-site tracking cookies. Page-view counts are first-party and carry no personal identifiers.</p>'],
  ['Your control', '<p>You can clear site data in your browser at any time. Clearing the till app\'s data removes anything not yet synced, so sync first.</p>'],
]);

const aup = legal('Acceptable Use', TERMS_VERSION, [
  ['You agree not to', '<ul><li>Break the law, or use mydukapos to sell or record illegal goods or services.</li><li>Try to access accounts, shops or data that are not yours, or probe or disrupt the service.</li><li>Send spam or abusive messages through the platform, or use it to harass anyone.</li><li>Upload malware or content you have no right to use.</li><li>Resell or share your login in a way that bypasses how the service is licensed.</li></ul>'],
  ['What happens if you do', '<p>We may warn, limit or suspend the account. Report abuse through the <a href="/contact">contact page</a>.</p>'],
]);

const FAQ = [
  ['Does mydukapos work without internet?', 'Yes. Tills sign in and record sales on the device itself, so selling continues offline. Changes sync to your other devices when the connection returns. The website dashboard and sign-up do need internet.'],
  ['Which kinds of business does it support?', 'Shops and supermarkets, hotels, restaurants and bars, hospitals, pharmacies, production businesses, repair/salon/service businesses and water refill stations. See the product pages on the home page.'],
  ['What does it cost?', 'The current price and any running offer are shown on the <a href="/">home page</a> and the <a href="/offers">offers page</a>. We do not hide prices in this FAQ so they cannot go out of date.'],
  ['Which devices can I use?', 'Any modern browser, a Windows app and an Android app.'],
  ['How do I sign in?', 'Use the <a href="/dashboard.html">dashboard</a> with your email and password. The same password signs in your till. If you forget it, use "Forgot password" on the dashboard.'],
  ['Is my data safe?', 'Your data travels over a secure (HTTPS) connection, is stored encrypted and is backed up regularly. Passwords are stored as salted hashes and sign-in attempts are rate-limited. See the <a href="/privacy">Privacy Policy</a>. You should still keep your own exports of important records.'],
  ['I have just signed up and have no products yet. Where do I start?', 'Open Inventory or the Sales Counter: both show an <b>Add your first item</b> button. An item name and selling price are enough to start; cost, stock quantity, code and category can be added later. If you already keep a list, use the Excel/CSV import on the Inventory tab. Once an item is saved it can be sold straight away.'],
  ['Can I keep customer records and loyalty tokens?', 'Yes. Type a name or phone number in the Customer box when you make a sale to find an existing customer or add a new one. The customer is saved when the sale goes through. My Customers lists each customer\u2019s purchases, bills still owed, returns and loyalty tokens. Tokens are earned on payment according to the tiers you set in Settings.'],
  ['Can I receive payments made straight to my M-PESA Till?', 'Yes. Once your till is registered with Safaricom, payments customers make to it appear in Sales Counter, Till Payments, newest first, with the name Safaricom supplied, the amount, the M-PESA code and the time. A cashier links each one to the right sale or bill in one tap; the balance updates and the same payment can never be applied twice. Nothing is applied until you confirm.'],
  ['What can the Hospital app do?', 'Patient records and history, consultations and billing in one flow, a prescription that lists every medicine on one page and marks anything you cannot supply as NA, a ready-made and editable laboratory test list with structured result forms such as urinalysis, and inpatient care: beds and transfers, meals, medication charts, and one admission account that combines bed, lab, pharmacy and meals before discharge.'],
  ['Can I change the lab tests, prices and meals in the Hospital app?', 'Yes. The starter laboratory list can be switched on or off and edited (name, specimen, result fields, units, reference ranges, price). Meal menus, charge types and bed rates are set by you too. Patient results are never pre-filled.'],
  // zip 307: honest answers on the three things the site used to overclaim (eTIMS, M-Pesa STK Push, what the price includes)
  ['Does MyDuka submit sales to KRA eTIMS?', 'MyDuka helps you review and organise your sales and tax records for manual reporting: the Tax &amp; Returns tab works out VAT per item and exports summaries. These are not official KRA returns or eTIMS invoices. Submitting sales to KRA eTIMS needs your business\'s own KRA approval (OSCU) and setup first; ask us whether it is available for your business before relying on it.'],
  ['Can customers pay by M-Pesa?', 'Yes, in two ways. Any cashier can record an M-Pesa payment against a sale. Sending an automatic payment prompt to the customer\'s phone (STK Push) works once your own M-Pesa or payment-gateway account has been set up in Settings. A sale is marked paid only when the provider confirms the payment, never just because a prompt was sent.'],
  ['What does the price include?', 'The one-time price gets your own private link for one business and all the features of the edition you choose, with staff logins and no per-sale fee. Hardware, M-Pesa, bank and SMS charges, KRA eTIMS approval and on-site installation are not included. Any subscription or branch and staff limits that apply are shown beside the price on the home page.'],
  ['How do I get help?', `Use the <a href="/contact">contact form</a> or <a href="${WA}" rel="noopener">WhatsApp</a>.`],
];
const faqJson = JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a.replace(/<[^>]+>/g, '') } })) });
const faq = `<p class="eyebrow">Help</p><h1>Frequently asked questions</h1><p class="lead">Short, honest answers. Anything missing? <a href="/contact">Ask us</a>.</p>${FAQ.map(([q, a]) => `<details class="faq"><summary>${q}</summary><p>${a}</p></details>`).join('')}`;

const contact = `<p class="eyebrow">Contact</p><h1>Talk to us</h1><p class="lead">Send a message and we will reply by email or WhatsApp. For something urgent, <a href="${WA}" rel="noopener">WhatsApp us directly</a>.</p>
<form id="cf" class="card" novalidate style="max-width:560px;margin-top:20px">
<label for="cf-name">Your name</label><input id="cf-name" name="name" autocomplete="name" required maxlength="100">
<label for="cf-contact">Email or phone</label><input id="cf-contact" name="contact" autocomplete="email" required maxlength="120">
<label for="cf-msg">Message</label><textarea id="cf-msg" name="message" required maxlength="2000"></textarea>
<div class="hp" aria-hidden="true"><label for="cf-web">Leave this empty</label><input id="cf-web" name="website" tabindex="-1" autocomplete="off"></div>
<p style="margin-top:14px"><button class="btn" type="submit" id="cf-btn">Send message</button></p>
<p class="msg" id="cf-out" role="status" aria-live="polite"></p>
</form>`;
// zip 303: t is when the page was OPENED; the server silently drops anything sent within 1.5 s of t (a bot), so sending the submit time threw every real message away
const contactScript = `<script>(function(){var T0=Date.now(),f=document.getElementById('cf'),o=document.getElementById('cf-out'),b=document.getElementById('cf-btn');f.addEventListener('submit',function(e){e.preventDefault();o.className='msg';o.textContent='';
var d={name:f.name.value.trim(),contact:f.contact.value.trim(),message:f.message.value.trim(),website:f.website.value,t:T0};
if(!d.name||!d.contact||d.message.length<5){o.className='msg err';o.textContent='Please fill in your name, how to reach you, and a message.';return}
b.disabled=true;b.textContent='Sending…';
fetch('/api/contact',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){if(!x.ok)throw new Error(x.j.error||'Could not send.');o.className='msg ok';o.textContent='Thank you — we have your message.';f.reset()}).catch(function(err){o.className='msg err';o.textContent=(err instanceof TypeError||!navigator.onLine)?'You appear to be offline. Please reconnect and try again, or WhatsApp us.':err.message}).then(function(){b.disabled=false;b.textContent='Send message'})})})();</script>`;

const offers = `<p class="eyebrow">Offers</p><h1>Current offers</h1><p class="lead">Offers start and end on our server's clock (Nairobi time), so the countdown is the same for everyone.</p>
<div id="offers" aria-live="polite"><p>Loading offers…</p></div>`;
const offersScript = `<script>(function(){var box=document.getElementById('offers'),list=[],skew=0;
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function fmt(ms){if(ms<=0)return'Ended';var s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return(d?d+'d ':'')+h+'h '+m+'m '+(s%60)+'s'}
function draw(){if(!list.length){box.innerHTML='<div class="card"><p>There is no active offer right now. Check back soon, or <a href="/contact">ask us</a>.</p></div>';return}
box.innerHTML=list.map(function(o,i){return'<article class="offer"><span class="badge">Limited time</span><h2 style="margin-top:.4em">'+esc(o.title)+'</h2><p>'+esc(o.description||'')+'</p>'+(o.endsAt?'<div class="count" data-i="'+i+'">'+fmt(o.endsAt-(Date.now()+skew))+'</div>':'')+(o.terms?'<p class="small" style="color:#5B6B60;opacity:1">'+esc(o.terms)+'</p>':'')+'<a class="btn" href="'+esc(o.ctaUrl||'/')+'">'+esc(o.ctaLabel||'Get started')+'</a></article>'}).join('')}
function tick(){[].forEach.call(box.querySelectorAll('.count'),function(el){var o=list[+el.dataset.i];var left=o.endsAt-(Date.now()+skew);el.textContent=fmt(left);if(left<=0)load()})}
function load(){fetch('/api/offers').then(function(r){return r.json()}).then(function(j){skew=(j.now||Date.now())-Date.now();list=j.offers||[];draw()}).catch(function(){box.innerHTML='<div class="card"><p>Offers could not be loaded. Check your connection.</p></div>'})}
load();setInterval(tick,1000)})();</script>`;

const PAGES = [
  { file: 'terms', title: 'Terms of Service', description: 'The terms for using a mydukapos point-of-sale account: what you can expect from us, what we ask of you, payments, data and ending your account.', body: terms },
  { file: 'privacy', title: 'Privacy Policy', description: 'What personal data mydukapos collects when you sign up and use the point of sale, why we collect it, how long we keep it and the choices you have.', body: privacy },
  { file: 'cookies', title: 'Cookies and Local Storage', description: 'The cookies and browser storage mydukapos uses to keep you signed in, keep your till working offline and remember your settings.', body: cookies },
  { file: 'acceptable-use', title: 'Acceptable Use Policy', description: 'The rules for using mydukapos: what is not allowed on the platform, and what happens if an account is used to break them.', body: aup },
  { file: 'faq', title: 'Frequently Asked Questions', description: 'Answers about mydukapos point of sale: working offline, supported businesses and devices, getting started with no stock, customers and loyalty, sign-in and data safety.', body: faq, extraHead: `<script type="application/ld+json">${faqJson}</script>\n` },
  { file: 'contact', title: 'Contact Us', description: 'Send the mydukapos team a message or WhatsApp us. We reply by email or WhatsApp about demos, pricing, setup and support for your shop, hotel or clinic.', body: contact, script: contactScript },
  { file: 'offers', title: 'Current Offers', description: 'See the current mydukapos point-of-sale offers and how long each one runs, with a live countdown to the end date.', body: offers, script: offersScript },
];

export function buildAll() { const out = {}; for (const p of PAGES) out[`public-site/${p.file}.html`] = shell(p); return out; }
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [f, html] of Object.entries(buildAll())) { fs.writeFileSync(path.join(ROOT, f), html); console.log('wrote', f); }
}
