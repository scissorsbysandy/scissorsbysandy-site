let pwmod;
for (const spec of ['playwright', '/opt/npm-tools/node_modules/playwright/index.js']) {
  try { pwmod = await import(spec); break } catch (e) {}
}
if (!pwmod) { console.log('SKIP  playwright is not installed here'); process.exit(0) }
const { chromium } = pwmod.default ?? pwmod;
import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const server = http.createServer((req,res)=>{const f=path.join(ROOT,decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);return res.end('no')}
  const ext=path.extname(f);res.writeHead(200,{'content-type':ext==='.html'?'text/html':ext==='.css'?'text/css':'text/javascript'});res.end(d)})});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const PAGE=`http://127.0.0.1:${server.address().port}/book.html`;
const SHOTS = process.env.SHOTS || '';

const t=new Date(Date.now()+6*24*3600*1000); const pad=n=>String(n).padStart(2,'0');
const DATE=`${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}`;
const SLOTS=[`${DATE}T15:00:00-05:00`,`${DATE}T16:00:00-05:00`];

const browser=await chromium.launch();
const ctx=await browser.newContext({timezoneId:'America/New_York', viewport:{width:430,height:900}});
const page=await ctx.newPage();
const posts=[]; const gets=[]; const errs=[];
page.on('pageerror',e=>errs.push(e.message));
await page.route('**/api/square*', async route=>{
  const req=route.request();
  const J=(o)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});
  if(req.method()==='GET'){ gets.push(req.url()); return J({slots:SLOTS}) }
  posts.push(JSON.parse(req.postData()||'{}'));
  return J({booking:{id:'BK_NEW',status:'ACCEPTED'}});
});
await page.goto(PAGE); await page.waitForTimeout(400);

let bad=0;
const check=(l,c,d='')=>{ if(!c){bad++;console.log(`FAIL  ${l}`);if(d)console.log('        '+d)} else console.log(`PASS  ${l}`) };

const svcBtns = page.locator('.svc');
const nameOf  = async (i)=> (await svcBtns.nth(i).locator('.svc-name').innerText()).trim();
const priceOf = async (i)=> parseInt((await svcBtns.nth(i).locator('.svc-price').innerText()).replace(/\D/g,''),10);
const minOf   = async (i)=> parseInt((await svcBtns.nth(i).locator('.svc-meta').innerText()).replace(/\D/g,''),10);

check('the bar is hidden before anything is chosen', !(await page.locator('#pickBar').isVisible()));

const [n0,n1]=[await nameOf(0), await nameOf(2)];
const [p0,p1]=[await priceOf(0), await priceOf(2)];
const [m0,m1]=[await minOf(0), await minOf(2)];

await svcBtns.nth(0).click(); await page.waitForTimeout(120);
check('choosing one service shows the bar', await page.locator('#pickBar').isVisible());
await svcBtns.nth(2).click(); await page.waitForTimeout(150);

const sum=(await page.locator('#pickSum').innerText()).replace(/\s+/g,' ');
check('the bar counts both services', /2 services/i.test(sum), sum);
check('the bar adds the minutes', sum.includes(String(m0+m1)+' min'), sum+` (expected ${m0+m1} min)`);
check('the bar adds the price', sum.includes('$'+(p0+p1)), sum+` (expected $${p0+p1})`);
check('both rows show as added', await page.locator('.svc.on').count()===2);
check('each chosen row shows a quantity of one',
      (await page.locator('.svc.on .qty .n').allInnerTexts()).join(',')==='1,1',
      (await page.locator('.svc.on .qty .n').allInnerTexts()).join(','));

if(SHOTS) await page.screenshot({path:SHOTS+'/multi-1-services.png', fullPage:false});

// tapping a chosen service takes it back off
await svcBtns.nth(0).click(); await page.waitForTimeout(150);
check('tapping a chosen service removes it', await page.locator('.svc.on').count()===1);
// the plus is how a second of the same service is added
const keptId=(await page.locator('.svc.on').first().getAttribute('id')).replace('svc-','');
await page.locator('#qty-'+keptId+' button').last().click(); await page.waitForTimeout(150);
check('the plus adds another of the same service',
      (await page.locator('#n-'+keptId).innerText()).trim()==='2');
check('and it stays one row', await page.locator('.svc.on').count()===1);
await page.locator('#qty-'+keptId+' button').first().click(); await page.waitForTimeout(150);
check('the minus takes one back off', (await page.locator('#n-'+keptId).innerText()).trim()==='1');
await svcBtns.nth(0).click(); await page.waitForTimeout(150);   // put the other one back

await page.locator('#pickBar .btn').click(); await page.waitForTimeout(600);
const lastGet = gets[gets.length-1] || '';
const ids = decodeURIComponent((lastGet.match(/services=([^&]+)/)||[])[1]||'');
check('availability asks for both services', ids.split(',').length===2, ids);
check('step 2 sums the visit', /2 services/i.test(await page.locator('#s2sub').innerText()));

await page.locator('.day:not([disabled])').first().click(); await page.waitForTimeout(300);
await page.locator('.slot').first().click(); await page.waitForTimeout(200);
await page.locator('#toS3').click(); await page.waitForTimeout(300);

const summary=(await page.locator('#sum').innerText()).replace(/\s+/g,' ');
check('the summary lists both services', summary.includes(n1) && summary.includes(n0), summary);
check('the summary totals the price', summary.includes('$'+(p0+p1)), summary);
check('the summary totals the length', summary.includes(String(m0+m1)+' minutes'), summary);
if(SHOTS) await page.screenshot({path:SHOTS+'/multi-2-summary.png', fullPage:false});

await page.locator('#fn').fill('Pat'); await page.locator('#ln').fill('Example');
await page.locator('#ph').fill('7325550142'); await page.waitForTimeout(150);
await page.locator('#confirmBtn').click(); await page.waitForTimeout(700);

const booked=posts[posts.length-1];
check('the booking sends a list of services', Array.isArray(booked?.services), JSON.stringify(booked));
check('it sends exactly two', booked?.services?.length===2, JSON.stringify(booked?.services));
check('no page errors anywhere', errs.length===0, errs.join('; '));
if(SHOTS) await page.screenshot({path:SHOTS+'/multi-3-confirmed.png', fullPage:false});

// reschedule must bring the whole visit back
await page.locator('.btn-line', {hasText:'Book Another'}).first().click().catch(()=>{});
await page.waitForTimeout(300);
await page.locator('#upcoming button', {hasText:'Reschedule'}).first().click();
await page.waitForTimeout(600);
check('rescheduling restores the whole visit', /2 services/i.test(await page.locator('#s2sub').innerText()),
      await page.locator('#s2sub').innerText());

await browser.close(); server.close();
console.log(bad?`\n${bad} check(s) failed`:'\nall checks pass');
process.exit(bad?1:0);
