// Playwright may be installed locally or alongside the toolchain; try both.
let pwmod;
for (const spec of ['playwright', '/opt/npm-tools/node_modules/playwright/index.js']) {
  try { pwmod = await import(spec); break } catch (e) {}
}
if (!pwmod) { console.log('SKIP  playwright is not installed here'); process.exit(0) }
const { chromium } = pwmod.default ?? pwmod;

import http from 'http'; import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const server=http.createServer((req,res)=>{const f=path.join(ROOT,decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);return res.end('no')}
  const ext=path.extname(f);res.writeHead(200,{'content-type':ext==='.html'?'text/html':ext==='.css'?'text/css':'text/javascript'});res.end(d)})});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const PAGE=`http://127.0.0.1:${server.address().port}/book.html`;

// a weekday six days out, 3pm shop time
// Freeze the clock mid-month so the test never depends on today's date
// (a slot six days out used to land in next month near month end).
const NOW=new Date('2027-02-10T12:00:00-05:00').getTime();
const t=new Date(NOW+6*24*3600*1000);
const pad=n=>String(n).padStart(2,'0');
const DATE=`${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}`;
const SLOTS=[`${DATE}T15:00:00-05:00`,`${DATE}T16:00:00-05:00`];
const future=new Date(NOW+5*24*3600*1000).toISOString();

const browser=await chromium.launch();
let failures=0;
const check=(l,c,d='')=>{ if(!c){failures++;console.log(`FAIL  ${l}`);if(d)console.log('        '+d)} else console.log(`PASS  ${l}`) };

async function session({cancelFails=false}={}) {
  const ctx=await browser.newContext({timezoneId:'America/New_York'});
  const page=await ctx.newPage(); await page.clock.setFixedTime(NOW);
  const seen=[]; const errs=[];
  page.on('pageerror',e=>errs.push(e.message));
  await page.route('**/api/square*', async route=>{
    const req=route.request();
    const J=(status,o)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(o)});
    if(req.method()==='GET') return J(200,{slots:SLOTS});
    const body=JSON.parse(req.postData()||'{}'); seen.push(body);
    if(body.action==='cancel')
      return cancelFails ? J(502,{error:'Could not reach the booking calendar'})
                         : J(200,{booking:{id:body.bookingId,status:'CANCELLED_BY_CUSTOMER'}});
    if(body.action==='reschedule')
      return J(200,{booking:{id:body.bookingId,status:'ACCEPTED',startAt:body.startAt}});
    return J(200,{booking:{id:'BK_NEW',status:'ACCEPTED'}});
  });
  await page.addInitScript(([iso])=>{
    localStorage.setItem('sbs_bookings',JSON.stringify([{id:'BK_REAL',svcId:'executive',svcName:'The Executive',price:60,min:45,startISO:iso}]));
    localStorage.setItem('sbs_client',JSON.stringify({fn:'Pat',ln:'Example',ph:'7325550142',em:''}));
  },[future]);
  await page.goto(PAGE); await page.waitForTimeout(400);
  return {page,seen,errs,ctx};
}

/* ---- 0. a cancel that works ---- */
{
  const {page,seen,errs,ctx}=await session();
  await page.locator('#upcoming button.danger').first().click();
  await page.waitForTimeout(120);
  await page.locator('#upcoming button.danger').first().click();
  await page.waitForTimeout(500);
  const req=seen.find(s=>s.action==='cancel');
  check('cancel reaches the booking function', !!req);
  check('cancel sends the booking id and phone',
        req?.bookingId==='BK_REAL' && req?.phone==='7325550142');
  check('the appointment disappears once Square confirms',
        !(await page.locator('#upcoming').isVisible()));
  check('no page errors', errs.length===0, errs.join('; '));
  await ctx.close();
}

/* ---- 1. a cancel that fails must NOT look like it worked ---- */
{
  const {page,seen,errs,ctx}=await session({cancelFails:true});
  await page.locator('#upcoming button.danger').first().click();
  await page.waitForTimeout(120);
  await page.locator('#upcoming button.danger').first().click();
  await page.waitForTimeout(500);
  const text=await page.locator('#upcoming').innerText();
  check('a failed cancel still sends the request', seen.some(s=>s.action==='cancel'));
  check('a failed cancel says it is still booked', /still booked/i.test(text), text.slice(0,160));
  check('a failed cancel keeps the appointment on screen', await page.locator('#upcoming').isVisible());
  const kept=await page.evaluate(()=>JSON.parse(localStorage.getItem('sbs_bookings')||'[]').length);
  check('a failed cancel does not delete the local record', kept===1, 'records left: '+kept);
  check('no page errors', errs.length===0, errs.join('; '));
  await ctx.close();
}

/* ---- 2. reschedule must move the booking, not make a second one ---- */
{
  const {page,seen,errs,ctx}=await session();
  await page.locator('#upcoming button', {hasText:'Reschedule'}).first().click();
  await page.waitForTimeout(600);
  const dayBtn=page.locator(`button.day:not([disabled]):not(.full)`).first();
  await dayBtn.click(); await page.waitForTimeout(300);
  await page.locator('.slot').first().click(); await page.waitForTimeout(200);
  await page.locator('#toS3').click(); await page.waitForTimeout(300);
  await page.locator('#confirmBtn').click(); await page.waitForTimeout(700);

  const req=seen.find(s=>s.action==='reschedule');
  check('reschedule sends a reschedule, not a new booking', !!req, JSON.stringify(seen));
  check('reschedule carries the original booking id', req?.bookingId==='BK_REAL');
  check('reschedule carries the phone for the ownership check', req?.phone==='7325550142');
  check('no second booking request was made', !seen.some(s=>!s.action));
  const recs=await page.evaluate(()=>JSON.parse(localStorage.getItem('sbs_bookings')||'[]'));
  check('still exactly one appointment held locally', recs.length===1, 'records: '+recs.length);
  check('no page errors', errs.length===0, errs.join('; '));
  await ctx.close();
}

await browser.close(); server.close();
console.log(failures?`\n${failures} check(s) failed`:'\nall checks pass');
process.exit(failures?1:0);
