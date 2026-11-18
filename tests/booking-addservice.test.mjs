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
const day=new Date(Date.now()+6*864e5); const pad=n=>String(n).padStart(2,'0');
const D=`${day.getFullYear()}-${pad(day.getMonth()+1)}-${pad(day.getDate())}`;
const SLOTS=[`${D}T15:00:00-05:00`,`${D}T16:00:00-05:00`,`${D}T17:00:00-05:00`];

const b=await chromium.launch();
const ctx=await b.newContext({timezoneId:'America/New_York',viewport:{width:430,height:930}});
const page=await ctx.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.route('**/api/square*', r=> r.request().method()==='GET'
  ? r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({slots:SLOTS})})
  : r.fulfill({status:200,contentType:'application/json',body:'{"booking":{"id":"BK","status":"ACCEPTED"}}'}));

let bad=0; const check=(l,c,d='')=>{ if(!c){bad++;console.log(`FAIL  ${l}`);if(d)console.log('        '+d)} else console.log(`PASS  ${l}`) };

// arrive the way a client does, from a service link
await page.goto(BASE+'/book.html?service=executive'); await page.waitForTimeout(800);
check('the control is on the calendar step', await page.locator('#addMore').isVisible());
check('it reads right for one service',
      /add a second service/i.test(await page.locator('#addMore').innerText()),
      await page.locator('#addMore').innerText());

await page.locator('#addMore').click(); await page.waitForTimeout(400);
check('it opens the services', await page.locator('#s1').isVisible());
check('the first service is still chosen', (await page.evaluate(()=>picked.map(s=>s.id))).join()==='executive');
check('and shows as added', await page.locator('button.svc.on').count()===1);

// add a second, come back
const before=(await page.locator('.slot').count());
await page.locator('button.svc').nth(5).click(); await page.waitForTimeout(200);
await page.locator('#pickBar .btn').click(); await page.waitForTimeout(900);
check('back on the calendar with both', /2 services/i.test(await page.locator('#s2sub').innerText()),
      await page.locator('#s2sub').innerText());
check('the control now reads "another"',
      /add another service/i.test(await page.locator('#addMore').innerText()),
      await page.locator('#addMore').innerText());

// and the visit still books
await page.locator('.day:not([disabled])').first().click(); await page.waitForTimeout(350);
await page.locator('.slot').first().click(); await page.waitForTimeout(150);
await page.locator('#toS3').click(); await page.waitForTimeout(300);
await page.locator('#fn').fill('Luis'); await page.locator('#ln').fill('Mordan');
await page.locator('#ph').fill('2017900718'); await page.waitForTimeout(250);
await page.locator('#confirmBtn').click(); await page.waitForTimeout(800);
check('the two-service visit books', await page.locator('#s4').isVisible());
check('no page errors', errs.length===0, errs.join('; '));

// it must not appear on the service list itself
await page.goto(BASE+'/book.html'); await page.waitForTimeout(500);
check('it is not shown on the service list', !(await page.locator('#addMore').isVisible()));

await b.close(); server.close();
console.log(bad?`\n${bad} check(s) failed`:'\nall checks pass');
process.exit(bad?1:0);
