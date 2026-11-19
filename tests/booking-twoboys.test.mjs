// A parent bringing two children for the same cut. Five such visits are in
// Sandy's Booksy history since July, all of them two Royal Roots.
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
const SLOTS=[`${D}T15:00:00-05:00`,`${D}T16:00:00-05:00`];

const b=await chromium.launch();
const page=await (await b.newContext({timezoneId:'America/New_York',viewport:{width:430,height:930}})).newPage();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
const posts=[]; const gets=[];
await page.route('**/api/square*', async r=>{
  const req=r.request();
  if(req.method()==='GET'){ gets.push(req.url()); return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({slots:SLOTS})}) }
  posts.push(JSON.parse(req.postData()||'{}'));
  return r.fulfill({status:200,contentType:'application/json',body:'{"booking":{"id":"BK","status":"ACCEPTED"}}'});
});
let bad=0; const check=(l,c,d='')=>{ if(!c){bad++;console.log(`FAIL  ${l}`);if(d)console.log('        '+d)} else console.log(`PASS  ${l}`) };

await page.goto(BASE+'/book.html?service=royalroots'); await page.waitForTimeout(800);
const one=await page.evaluate(()=>({min:totalMin(),price:totalPrice()}));
check('one child is booked', one.min===30 && one.price===40, JSON.stringify(one));

// mum taps the same cut again for the second boy
await page.locator('#addMore').click(); await page.waitForTimeout(400);
await page.locator('#qty-royalroots button').last().click(); await page.waitForTimeout(250);
check('the row shows two', (await page.locator('#n-royalroots').innerText()).trim()==='2');
check('only one row is highlighted', await page.locator('.svc.on').count()===1);
const two=await page.evaluate(()=>({n:picked.length,min:totalMin(),price:totalPrice()}));
check('the visit is two cuts', two.n===2, JSON.stringify(two));
check('an hour is reserved, not half', two.min===60, String(two.min));
check('and it costs eighty', two.price===80, String(two.price));
check('the bar says two services', /2 services/i.test(await page.locator('#pickSum').innerText()),
      await page.locator('#pickSum').innerText());

await page.locator('#pickBar .btn').click(); await page.waitForTimeout(900);
const q=decodeURIComponent((gets[gets.length-1].match(/services=([^&]+)/)||[])[1]||'');
check('Square is asked for the cut twice', q.split(',').length===2 && new Set(q.split(',')).size===1, q);

await page.locator('.day:not([disabled])').first().click(); await page.waitForTimeout(350);
await page.locator('.slot').first().click(); await page.waitForTimeout(150);
await page.locator('#toS3').click(); await page.waitForTimeout(350);
const sum=(await page.locator('#sum').innerText()).replace(/\s+/g,' ');
check('the summary reads "The Royal Roots × 2"', /Royal Roots\s*×\s*2/.test(sum), sum);
check('the summary charges eighty', sum.includes("$80"), sum);
check('the summary reserves sixty minutes', sum.includes('60 minutes'), sum);

await page.locator('#fn').fill('Jordan'); await page.locator('#ln').fill('Sample');
await page.locator('#ph').fill('7325550148'); await page.waitForTimeout(250);
await page.locator('#confirmBtn').click(); await page.waitForTimeout(900);
const sent=posts[posts.length-1];
check('the booking sends the service twice', sent?.services?.length===2 && new Set(sent.services).size===1,
      JSON.stringify(sent?.services));
const conf=(await page.locator('.conf').innerText()).replace(/\s+/g,' ');
check('the confirmation says two', /Royal Roots\s*×\s*2/.test(conf), conf.slice(0,110));

// and the minus still undoes it
await page.locator('.btn-line',{hasText:'Book Another'}).first().click(); await page.waitForTimeout(400);
await page.locator('#svc-royalroots').click(); await page.waitForTimeout(150);
await page.locator('#qty-royalroots button').last().click(); await page.waitForTimeout(150);
check('a tap then the plus gives two', (await page.locator('#n-royalroots').innerText()).trim()==='2');
// a tap on a row holding two clears the service, it does not peel one off
await page.locator('#svc-royalroots').click(); await page.waitForTimeout(200);
check('tapping a row holding two clears the whole service', await page.locator('.svc.on').count()===0);
check('and the bar goes with it', !(await page.locator('#pickBar').isVisible()));
// build it back up to check the minus on its own
await page.locator('#svc-royalroots').click(); await page.waitForTimeout(150);
await page.locator('#qty-royalroots button').last().click(); await page.waitForTimeout(150);
await page.locator('#qty-royalroots button').first().click(); await page.waitForTimeout(200);
check('minus takes one back off', (await page.locator('#n-royalroots').innerText()).trim()==='1');
await page.locator('#qty-royalroots button').first().click(); await page.waitForTimeout(200);
check('minus again clears the service', await page.locator('.svc.on').count()===0);
check('and the bar disappears', !(await page.locator('#pickBar').isVisible()));
check('no page errors', errs.length===0, errs.join('; '));

await b.close(); server.close();
console.log(bad?`\n${bad} check(s) failed`:'\nall checks pass');
process.exit(bad?1:0);
