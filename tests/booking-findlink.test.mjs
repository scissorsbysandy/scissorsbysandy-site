// "Change or cancel" in Sandy's emails links to /book.html?find=1, which should
// open the find-my-appointment form straight away.
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
const b=await chromium.launch(); const ctx=await b.newContext({timezoneId:'America/New_York'});
let bad=0; const check=(l,c,d='')=>{ if(!c){bad++;console.log(`FAIL  ${l}`);if(d)console.log('        '+d)} else console.log(`PASS  ${l}`) };
async function open(url){
  const page=await ctx.newPage();
  await page.route('**/api/square*', r=> r.fulfill({status:200,contentType:'application/json',body:'{"slots":[]}'}));
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.goto(url); await page.waitForTimeout(600);
  const shown=await page.locator('#findForm').isVisible();
  await page.close(); return {shown, errs};
}
let r=await open(BASE+'/book.html?find=1&utm_source=sbs_email&utm_medium=email&utm_campaign=booked');
check('?find=1 opens the find-my-appointment form', r.shown);
check('without errors', r.errs.length===0, r.errs.join('; '));
r=await open(BASE+'/book.html');
check('a plain visit leaves it closed', !r.shown);
await b.close(); server.close();
if(bad){console.log(`\n${bad} failed`);process.exit(1)}
console.log('\nall passed');
