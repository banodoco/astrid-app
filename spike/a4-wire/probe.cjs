// Synthetic local fixtures only. Run under the shared-host lease. No product endpoints.
const { chromium } = require('/workspace/r12-a4-fix/node_modules/playwright');
const { startTap, parseSingle } = require('./tap.cjs');
const http = require('node:http'); const https = require('node:https');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { execFileSync } = require('node:child_process'); const assert = require('node:assert/strict');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = s => new Promise(resolve => s.listen(0, '127.0.0.1', () => resolve(s.address().port)));
const close = s => new Promise(resolve => { s.closeAllConnections?.(); s.close(resolve); });
(async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(),'a4-wire-')); let browser, pageServer, origin, tap;
 try {
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'key'),'-out',path.join(dir,'cert'),'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
  let held, seen = [];
  origin = http.createServer((req,res) => {
   seen.push(req.url); res.setHeader('Access-Control-Allow-Origin','https://' + (process.env.A4_SAME_SITE ? '127.0.0.1' : 'localhost') + ':' + pageServer.address().port); res.setHeader('Access-Control-Allow-Credentials','true'); res.setHeader('Access-Control-Allow-Headers','x-pagehide,content-type'); res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Private-Network','true'); res.setHeader('Connection','close');
   if (req.method === 'OPTIONS') {res.writeHead(204, {'Content-Length':'0'}); res.end(); return;}
   if (req.url === '/api/hold') { res.writeHead(200, {'Content-Type':'text/plain','Content-Length':'21'}); res.write('DELIVERED_'); held=res; return; }
   if (req.url === '/api/partial') { res.writeHead(200, {'Content-Length':'20'}); res.write('SHORT'); res.socket.destroy(); return; }
   if (req.url === '/api/redirect') {res.writeHead(302, {'Location':'/api/final','Content-Length':'0'}); res.end(); return;}
   res.writeHead(200, {'Content-Length':'2','Content-Type':'text/plain'}); res.end('ok');
  });
  const target = await listen(origin); tap = startTap(target); const port = await listen(tap.server);
  pageServer = https.createServer({key:fs.readFileSync(path.join(dir,'key')),cert:fs.readFileSync(path.join(dir,'cert'))}, (_req,res) => { res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'}); res.end('<!doctype html><title>fixture</title>'); });
  const pagePort = await listen(pageServer);
  browser = await chromium.launch({headless:true,args:['--no-proxy-server','--no-sandbox','--disable-dev-shm-usage',`--ip-address-space-overrides=127.0.0.1:${pagePort}=public`]});
  const context = await browser.newContext({ignoreHTTPSErrors:true,permissions:['local-network-access']});
  await context.addCookies([{name:'wire_cookie',value:'HTTPONLY_SENTINEL',url:`http://127.0.0.1:${port}`,httpOnly:true,sameSite:process.env.A4_SAME_SITE ? 'Lax' : 'None',secure:!process.env.A4_SAME_SITE}]);
  const page = await context.newPage(); const events=[];
  page.on('request',r=>events.push({kind:'request',url:r.url()})); page.on('requestfinished',r=>events.push({kind:'finished',url:r.url()})); page.on('requestfailed',r=>events.push({kind:'failed',url:r.url()}));
  const pageHost=process.env.A4_SAME_SITE ? '127.0.0.1' : 'localhost'; await page.goto(`https://${pageHost}:${pagePort}/`);
  const base=`http://127.0.0.1:${port}`;
  await page.evaluate(async base => { await fetch(base+'/api/post',{method:'POST',credentials:'include',headers:{'content-type':'text/plain'},body:'BODY_SENTINEL'}); },base);
  const post=tap.records.find(r=>Buffer.concat(r.request).includes(Buffer.from('POST /api/post'))); assert(post); const postParsed=parseSingle(post.request); assert(postParsed.complete); assert(postParsed.body.includes(Buffer.from('BODY_SENTINEL')));
  const cookie=postParsed.head.includes('HTTPONLY_SENTINEL');
  await page.evaluate(async base => { await fetch(base+'/api/warm',{method:'POST',headers:{'x-pagehide':'warm','content-type':'text/plain'},body:'warm'}); },base);
  await page.evaluate(base => { window.addEventListener('pagehide',()=>{fetch(base+'/api/pagehide',{method:'POST',keepalive:true,headers:{'content-type':'text/plain','x-pagehide':'KEEPALIVE_HEADER_SENTINEL'},body:'KEEPALIVE_BODY_SENTINEL'}).catch(()=>{});},{once:true}); fetch(base+'/api/hold').then(async r=>{ const rd=r.body.getReader(); const part=await rd.read(); sessionStorage.setItem('prefix',new TextDecoder().decode(part.value)); return rd.read(); }).catch(()=>{}); },base);
  for(let i=0;i<100 && !held;i++) await wait(20); assert(held,'held response not reached');
  for(let i=0;i<100 && await page.evaluate(()=>sessionStorage.getItem('prefix')) !== 'DELIVERED_';i++) await wait(20);
  const prefix=await page.evaluate(()=>sessionStorage.getItem('prefix')); assert.equal(prefix,'DELIVERED_');
  await page.goto(`https://${pageHost}:${pagePort}/next`,{waitUntil:'commit'}); await wait(300); held.end('NOTRECEIVED'); await wait(300);
  const hold=tap.records.find(r=>Buffer.concat(r.request).includes(Buffer.from('GET /api/hold'))); const hide=tap.records.find(r=>Buffer.concat(r.request).includes(Buffer.from('POST /api/pagehide')));
  const output={ rawPostBody:postParsed.body.includes(Buffer.from('BODY_SENTINEL')), browserAddedOrigin:/\r\norigin:/i.test('\r\n'+postParsed.head), httpOnlyCookie:cookie, pagehideSeen:!!hide, pagehideSentinel:!!hide && Buffer.concat(hide.request).includes(Buffer.from('KEEPALIVE_HEADER_SENTINEL')), deliveredPrefix:prefix==='DELIVERED_', relaySawSuffix:Buffer.concat(hold.response).includes(Buffer.from('NOTRECEIVED')), holdComplete:parseSingle(hold.response,true).complete, holdBrowserTerminal:events.filter(e=>e.url.endsWith('/api/hold')).map(e=>e.kind), relayClosed:hold.clientClosed };
  // No client-side request is silently accepted just because no connection reached the tap.
  await page.route('**/api/never',r=>r.abort()); await page.evaluate(base=>fetch(base+'/api/never').catch(()=>{}),base); output.serverNeverSeen=!seen.includes('/api/never'); output.neverObserved=events.filter(e=>e.url.endsWith('/api/never')).map(e=>e.kind);
  await page.route('**/api/synthetic',r=>r.fulfill({status:200,body:'ROUTE_SENTINEL'})); const synthetic=await page.evaluate(base=>fetch(base+'/api/synthetic').then(r=>r.text()),base); output.syntheticSeenByBrowser=synthetic==='ROUTE_SENTINEL'; output.syntheticSeenByTap=tap.records.some(r=>Buffer.concat(r.request).includes(Buffer.from('/api/synthetic')));
  await page.evaluate(base=>fetch(base+'/api/redirect').catch(()=>{}),base); await wait(100); output.redirectHopSeen=seen.includes('/api/redirect') && seen.includes('/api/final');
  await page.evaluate(base=>fetch(base+'/api/partial').catch(()=>{}),base); await wait(100); const partial=tap.records.find(r=>Buffer.concat(r.request).includes(Buffer.from('GET /api/partial'))); output.partialFailClosed=!!partial && !parseSingle(partial.response,true).complete;
  console.log(JSON.stringify(output,null,2));
 } finally { if(browser) await browser.close(); if(tap) await close(tap.server); if(origin) await close(origin); if(pageServer) await close(pageServer); fs.rmSync(dir,{recursive:true,force:true}); }
})().catch(e=>{console.error(e.stack);process.exitCode=1});
