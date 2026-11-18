let pwmod;
for (const spec of ['playwright','/opt/npm-tools/node_modules/playwright/index.js']) {
  try { pwmod = await import(spec); break } catch(e){}
}
if(!pwmod){ console.log('SKIP  playwright is not installed here'); process.exit(0) }
const { chromium } = pwmod.default ?? pwmod;
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
const ROOT=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','site');
const server=http.createServer((req,res)=>{const f=path.join(ROOT,decodeURIComponent(req.url.split('?')[0].split('#')[0]));
  fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);return res.end('no')}
  res.writeHead(200,{'content-type':'text/html'});res.end(d)})});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const BASE=`http://127.0.0.1:${server.address().port}`;
const SLOTS=[new Date(Date.now()+6*864e5).toISOString()];
const b=await chromium.launch(); const ctx=await b.newContext({timezoneId:'America/New_York'});
let bad=0; const check=(l,c,d='')=>{ if(!c){bad++;console.log(`FAIL  ${l}`);if(d)console.log('        '+d)} else console.log(`PASS  ${l}`) };

async function land(url){
  const page=await ctx.newPage();
  await page.route('**/api/square*', r=> r.request().method()==='GET'
    ? r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({slots:SLOTS})})
    : r.fulfill({status:200,contentType:'application/json',body:'{"booking":{"id":"BK"}}'}));
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(url); await page.waitForTimeout(700);
  const picked=await page.evaluate(()=>picked.map(s=>s.id));
  const step2=await page.locator('#s2').isVisible();
  await page.close();
  return {picked, step2, errs};
}

let r = await land(BASE+'/book.html?service=executive');
check('?service= selects the service', r.picked.join()==='executive', r.picked.join());
check('and jumps straight to picking a time', r.step2);

r = await land(BASE+'/book.html#executive');
check('an older #hash link still works', r.picked.join()==='executive', r.picked.join());

r = await land(BASE+'/book.html?service=not-a-service');
check('an unknown service falls back to the menu', r.picked.length===0 && !r.step2);

r = await land(BASE+'/book.html');
check('no parameter shows the full menu', r.picked.length===0 && !r.step2);
check('no page errors', r.errs.length===0, r.errs.join('; '));

await b.close(); server.close();
console.log(bad?`\n${bad} check(s) failed`:'\nall checks pass');
process.exit(bad?1:0);
