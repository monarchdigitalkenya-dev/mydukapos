import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { createRequire } from 'node:module'; import { execSync } from 'node:child_process';
const ROOT='/home/claude/work'; const { chromium } = createRequire(ROOT+'/')('playwright');
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,decodeURIComponent(new URL(q.url,'http://x').pathname)); if(!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end();} r.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(p)]||'application/octet-stream'}); fs.createReadStream(p).pipe(r);});
await new Promise(r=>srv.listen(0,'127.0.0.1',r)); const base='http://127.0.0.1:'+srv.address().port;
const H=crypto.createHash('sha256').update('pw').digest('hex');
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
for (const file of (process.argv[2]||'hotel/index.html').split(',')) for (const theme of ['light','dark']) {
const ctx=await b.newContext({viewport:{width:1280,height:800}});
await ctx.route('**/api/**',r=>r.abort());
await ctx.addInitScript(([h,th])=>{ if(sessionStorage.getItem('s'))return; sessionStorage.setItem('s','1'); localStorage.setItem('pos_pw_hash',h); localStorage.setItem('pos_theme',th); localStorage.setItem('pos_biz_name','Hannan Snacks'); for(const k of ['pos_notif_prompt_last','pos_cd_detect_last'])localStorage.setItem(k,String(Date.now())); },[H,theme]);
const page=await ctx.newPage(); await page.goto(base+'/'+file); await page.waitForTimeout(1500);
await page.evaluate((th)=>{for(const id of ['login-screen','registration-screen']){const e=document.getElementById(id); if(e)e.style.display='none';} const a=document.getElementById('app-container'); if(a)a.style.display=''; document.documentElement.setAttribute('data-theme',th);},theme);
await page.evaluate(()=>{const sale={id:'S1',refNumber:'R-1',timestamp:new Date().toISOString(),paymentMethod:'cash',cashAmount:150,servedBy:'Jane',items:[{code:'A1',name:'Simba Stick',qty:1,price:50},{code:'A2',name:'Cow Tea',qty:1,price:100}]}; currentReceiptSale=sale; renderReceipt(sale); document.getElementById('receipt-modal').style.display='flex'; buildSystemPrintCopies(); setPrintMode('receipt');});
await page.emulateMedia({media:'print'});
console.log(await page.evaluate(()=>{const r=document.getElementById('receipt-modal').getBoundingClientRect(); const out={doc:document.documentElement.scrollHeight, body:document.body.scrollHeight, bodyH:document.body.getBoundingClientRect().height, modalH:r.height, innerH:innerHeight}; const big=[...document.body.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().bottom>out.modalH+40 && getComputedStyle(e).display!=='none' && !e.closest('#receipt-modal')).slice(0,5).map(e=>e.tagName+'#'+e.id+'.'+String(e.className).slice(0,25)+' pos='+getComputedStyle(e).position+' b='+Math.round(e.getBoundingClientRect().bottom)); out.big=big; out.bodyStyle=getComputedStyle(document.body).minHeight+' / '+getComputedStyle(document.body).height; return JSON.stringify(out)}));
const pdf=await page.pdf({width:'80mm',height:'30mm',printBackground:true,margin:{top:0,bottom:0,left:0,right:0}});
fs.writeFileSync('/tmp/pg.pdf',pdf);
const n=Number(execSync("pdfinfo /tmp/pg.pdf | grep Pages | awk '{print $2}'",{encoding:'utf8'}));
const blank=[]; for(let i=1;i<=n;i++){ const t=execSync(`pdftotext -f ${i} -l ${i} /tmp/pg.pdf - | tr -d '\\n\\f '`,{encoding:'utf8'}); if(!t.length) blank.push(i);} 
console.log(file,theme,'pages',n,'blank pages',blank.length,JSON.stringify(blank.slice(0,12)));
await ctx.close();}
await b.close(); srv.close();
